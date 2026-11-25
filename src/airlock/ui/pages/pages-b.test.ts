import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../core/audit.js";
import { DEFAULT_RULES } from "../../flows/rules.js";
import { BUILTIN_PROFILES } from "../../profiles/builtins.js";
import { memoryKV, ProfileRegistry } from "../../profiles/storage.js";
import type { Profile } from "../../profiles/types.js";
import { filterEvents, groupByDay, groupCounts } from "./audit-model.js";
import { addField, blankProfile, changedLabel, deleteSummary, draftErrors, exportJson, parseImport, parseProfileText, profileRows, removeField, setField, stampUser } from "./profiles-model.js";
import { addHostRule, parseRulesText, removeDestination, setApproval, setDefault, setHosts } from "./rules-model.js";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

const crm = (): Profile => ({
  ...blankProfile("127.0.0.1:5173", NOW),
  request: { fields: [{ path: "$.properties.email", category: "contact", flow: { action: "token" } }] },
});

describe("profiles-model", () => {
  it("builds rows with counts, author and origin", async () => {
    const reg = new ProfileRegistry(memoryKV(), { builtins: BUILTIN_PROFILES });
    await reg.save(crm());
    const rows = profileRows(reg.entries());
    const mine = rows.find((r) => r.id === crm().id)!;
    expect(mine).toMatchObject({ fields: 2, flows: 1, authoredBy: "user", origin: "stored", editable: true });
    expect(rows.find((r) => r.id === "gemini-generate-content")).toMatchObject({ origin: "built-in", editable: false, authoredBy: "builtin" });
  });

  it("labels the last change in words", () => {
    expect(changedLabel(NOW - 5_000, NOW)).toBe("just now");
    expect(changedLabel(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(changedLabel(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(changedLabel(Date.parse("2026-11-01T00:00:00Z"), NOW)).toBe("2026-11-01");
    expect(changedLabel(undefined, NOW)).toBe("unknown");
  });

  it("an invalid edit is reported with its field path and the registry refuses to save it", async () => {
    const reg = new ProfileRegistry(memoryKV(), { builtins: BUILTIN_PROFILES });
    const bad = setField(crm(), "request", 0, { path: "properties.email", category: "contact" });
    const errors = draftErrors(bad);
    expect(errors.join("\n")).toContain("request.fields[0].path");
    const saved = await reg.save(bad);
    expect(saved.ok).toBe(false);
    expect(reg.entries().filter((e) => e.origin === "stored")).toHaveLength(0);
  });

  it("a hand edit is stamped as authored by the user", () => {
    const edited = stampUser({ ...crm(), author: { by: "on_device", at: "2026-01-01T00:00:00.000Z" } }, NOW);
    expect(edited.author).toEqual({ by: "user", at: "2026-11-24T12:00:00.000Z" });
  });

  it("adds and removes fields", () => {
    const p = addField(crm(), "response");
    expect(p.response.fields).toHaveLength(2);
    expect(removeField(p, "response", 1).response.fields).toHaveLength(1);
    expect(draftErrors(addField(crm(), "request"))).toEqual([]);
  });

  it("parses profile text and names a JSON error", () => {
    expect(parseProfileText(JSON.stringify(crm())).ok).toBe(true);
    const r = parseProfileText("{not json");
    expect(r.ok).toBe(false);
    const missing = parseProfileText(JSON.stringify({ version: 1 }));
    expect(missing.ok).toBe(false);
  });

  it("deleting names what is removed", () => {
    const text = deleteSummary(crm());
    expect(text).toContain("for 127.0.0.1:5173");
    expect(text).toContain("2 field locator(s)");
    expect(text).toContain(crm().id);
  });

  it("export then import round-trips, and an import with one invalid profile writes nothing", async () => {
    const a = crm();
    const b = { ...crm(), id: "second", name: "Second", match: { hosts: ["b.example.com"], paths: ["/**"] } };
    const text = exportJson([a, b]);
    const parsed = parseImport(text);
    expect(parsed.ok).toBe(true);
    const reg = new ProfileRegistry(memoryKV());
    const ok = await reg.saveMany(parsed.ok ? parsed.items : []);
    expect(ok.ok).toBe(true);
    expect(reg.entries()).toHaveLength(2);

    const reg2 = new ProfileRegistry(memoryKV());
    const mixed = await reg2.saveMany([a, { ...b, match: { hosts: ["*.evil.com"], paths: ["/**"] } }]);
    expect(mixed.ok).toBe(false);
    expect(mixed.ok ? [] : mixed.errors.join("\n")).toContain("(profile 2)");
    expect(reg2.entries()).toHaveLength(0);
    expect(parseImport("[]").ok).toBe(false);
    expect(exportJson([a])).toBe(JSON.stringify(a, null, 2));
  });

  it("remove deletes a stored profile only, and notifies subscribers", async () => {
    const reg = new ProfileRegistry(memoryKV(), { builtins: BUILTIN_PROFILES });
    await reg.ready;
    let calls = 0;
    reg.subscribe(() => calls++);
    await reg.save(crm());
    expect((await reg.remove("gemini-generate-content")).ok).toBe(false);
    expect((await reg.remove(crm().id)).ok).toBe(true);
    expect(reg.entries().some((e) => e.origin === "stored")).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("rules-model", () => {
  it("edits one cell and keeps the rest", () => {
    const r = setDefault(DEFAULT_RULES, "saas-default", "contact", "mask");
    expect(r.ok && r.rules.destinations[1].defaults.contact).toBe("mask");
    expect(r.ok && r.rules.destinations[0].defaults.contact).toBe("token");
    const cleared = setDefault(DEFAULT_RULES, "saas-default", "contact", "");
    expect(cleared.ok && cleared.rules.destinations[1].defaults.contact).toBeUndefined();
    expect(DEFAULT_RULES.destinations[1].defaults.contact).toBe("token");
  });

  it("changes approval", () => {
    const r = setApproval(DEFAULT_RULES, "ai-default", "auto");
    expect(r.ok && r.rules.destinations[0].approval).toBe("auto");
  });

  it("refuses an invalid host with its path and leaves the rules untouched", () => {
    const r = setHosts(DEFAULT_RULES, "saas-default", "*.example.com");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join("\n")).toContain("destinations[1].match.hosts[0]");
    const good = setHosts(DEFAULT_RULES, "saas-default", "crm.example.com");
    expect(good.ok && good.rules.destinations[1].match.hosts).toEqual(["crm.example.com"]);
  });

  it("adds a host rule from the kind defaults, and removes only host rules", () => {
    const added = addHostRule(DEFAULT_RULES, "crm.example.com", "saas");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const dest = added.rules.destinations.find((d) => d.id === "host-rule-1")!;
    expect(dest.approval).toBe("auto");
    expect(dest.defaults.identifier).toBe("surrogate");
    expect(addHostRule(DEFAULT_RULES, "", "saas").ok).toBe(false);
    expect(addHostRule(DEFAULT_RULES, "not a host", "ai").ok).toBe(false);
    expect(removeDestination(added.rules, "host-rule-1").ok).toBe(true);
    expect(removeDestination(DEFAULT_RULES, "ai-default").ok).toBe(false);
  });

  it("parses rules text", () => {
    expect(parseRulesText(JSON.stringify(DEFAULT_RULES)).ok).toBe(true);
    expect(parseRulesText("nope").ok).toBe(false);
    expect(parseRulesText(JSON.stringify({ version: 2, destinations: [] })).ok).toBe(false);
  });
});

describe("audit-model", () => {
  const ev = (id: number, kind: AuditEvent["kind"], ts: number, where?: AuditEvent["where"]): AuditEvent => ({ id, ts, kind, requestId: `r${id}`, where, detail: {} });
  const events = [
    ev(1, "request-held", NOW - 1000, "code"),
    ev(2, "local-analysis", NOW - 900, "on_device"),
    ev(3, "approved", NOW - 800, "code"),
    ev(4, "sent", NOW - 700, "in_cloud"),
    ev(5, "blocked", NOW - 600, "code"),
    ev(6, "sent", NOW - 2 * 86_400_000, "in_cloud"),
  ];

  it("filters by group, where and text", () => {
    expect(filterEvents(events, { group: "sends", query: "" }).map((e) => e.id)).toEqual([4, 6]);
    expect(filterEvents(events, { group: "problems", query: "" }).map((e) => e.id)).toEqual([5]);
    expect(filterEvents(events, { group: "inference", query: "" }).map((e) => e.id)).toEqual([2]);
    expect(filterEvents(events, { group: "all", where: "in_cloud", query: "" }).map((e) => e.id)).toEqual([4, 6]);
    expect(filterEvents(events, { group: "all", query: "r3" }).map((e) => e.id)).toEqual([3]);
  });

  it("counts groups and groups by day, newest first", () => {
    expect(groupCounts(events)).toMatchObject({ all: 6, sends: 2, problems: 1, decisions: 1, inference: 1 });
    const days = groupByDay(events, NOW);
    expect(days[0].day).toBe("Today");
    expect(days[0].events[0].id).toBe(5);
    expect(days).toHaveLength(2);
  });
});
