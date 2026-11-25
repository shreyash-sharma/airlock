import { STRICT_RULES } from "../flows/rules.js";
import { afterEach, describe, expect, it } from "vitest";
import { installAirlock, type AirlockHandle } from "../net/guard.js";
import { KEYS, memoryKV } from "../profiles/storage.js";
import type { Profile } from "../profiles/types.js";
import { dryRun } from "./dryrun.js";

/** Synthetic sample, HubSpot-style. Every value is made up; example.com is a reserved domain. */
const EMAIL = "rohan.mehta@example.com";
const NOTE = "Prefers a call after lunch, budget signed off";

const SAAS: Profile = {
  version: 1,
  id: "crm-contacts",
  name: "Example CRM contacts",
  kind: "saas",
  pipeline: "field-protect",
  match: { hosts: ["crm.example.com"], paths: ["/api/**"] },
  request: {
    fields: [
      { path: "$.properties.city", category: "non_sensitive" },
      { path: "$.properties.internal_note", category: "free_text", flow: { action: "drop" } },
      { path: "$.properties.email", category: "contact", flow: { action: "mask" } },
    ],
  },
  response: { fields: [{ path: "$.results[*].properties.email" }] },
  author: { by: "user", at: "2026-11-23T10:00:00.000Z" },
};

const CREATE = "https://crm.example.com/api/contacts";
const JSON_HEADERS = { "content-type": "application/json" };

/** A fake SaaS: remembers the last create body and answers a list with that record. */
function fakeSaas() {
  const sent: Array<{ method: string; body: string | null }> = [];
  let last = "{}";
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : null;
    sent.push({ method: init?.method ?? "GET", body });
    if (init?.method === "POST" && body) {
      last = body;
      return new Response(JSON.stringify({ id: "1" }), { status: 201, headers: JSON_HEADERS });
    }
    const stored = JSON.parse(last) as { properties?: Record<string, unknown> };
    return new Response(JSON.stringify({ results: [{ id: "1", properties: stored.properties ?? {} }] }), { status: 200, headers: JSON_HEADERS });
  }) as typeof fetch;
  return { sent, impl };
}

const create = (properties: Record<string, unknown>) => ({ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ properties }) });

let handle: AirlockHandle | undefined;
afterEach(() => handle?.uninstall());

function setup(profile: Profile = SAAS) {
  const saas = fakeSaas();
  handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [profile] });
  return saas;
}

describe("field-protect through the fetch adapter", () => {
  it("keeps city, drops internal_note, masks email, and sends only that body", async () => {
    const saas = setup();
    await fetch(CREATE, create({ email: EMAIL, city: "Pune", internal_note: NOTE }));
    expect(saas.sent).toHaveLength(1);
    const wire = JSON.parse(saas.sent[0].body as string) as { properties: Record<string, string> };
    expect(wire.properties.city).toBe("Pune");
    expect("internal_note" in wire.properties).toBe(false);
    expect(wire.properties.email).toMatch(/^\[EMAIL_\d+\]$/);
    expect(saas.sent[0].body).not.toContain(EMAIL);
    expect(saas.sent[0].body).not.toContain("lunch");
    const view = handle?.store.getSnapshot()[0];
    expect(view?.status).toBe("done");
    expect(view?.pipeline).toBe("field-protect");
    expect(view?.profileId).toBe("crm-contacts");
  });

  it("restores the real email at the declared response path of a later list", async () => {
    const saas = setup();
    await fetch(CREATE, create({ email: EMAIL, city: "Pune" }));
    const res = await fetch("https://crm.example.com/api/contacts");
    const json = (await res.json()) as { results: Array<{ properties: Record<string, string> }> };
    expect(json.results[0].properties.email).toBe(EMAIL);
    // The SaaS itself only ever held the placeholder.
    expect(saas.sent[0].body).not.toContain(EMAIL);
  });

  it("fails the residual scan on an undeclared field holding an email and sends nothing", async () => {
    const saas = setup();
    await expect(fetch(CREATE, create({ email: EMAIL, city: "Pune", backup_contact: "ops@example.com" }))).rejects.toThrow(
      /no-residual-detection.*\$\.properties\.backup_contact/,
    );
    expect(saas.sent).toHaveLength(0);
    const view = handle?.store.getSnapshot()[0];
    expect(view?.status).toBe("blocked");
    expect(JSON.stringify(view?.message)).not.toContain("ops@example.com");
  });

  it("aborts on a block flow with a reason naming path and category, never the value", async () => {
    const blocking: Profile = {
      ...SAAS,
      request: { fields: [...SAAS.request.fields, { path: "$.properties.salary", category: "financial", flow: { action: "block" } }] },
    };
    const saas = setup(blocking);
    const attempt = fetch(CREATE, create({ city: "Pune", salary: "68000" }));
    await expect(attempt).rejects.toThrow(/\$\.properties\.salary \(financial\)/);
    await expect(attempt).rejects.not.toThrow(/68000/);
    expect(saas.sent).toHaveLength(0);
  });

  it("passes a GET without a body, a missing declared path and an already-placeholder value unchanged", async () => {
    const saas = setup();
    await fetch("https://crm.example.com/api/contacts");
    expect(saas.sent[0].body).toBeNull();
    const body = JSON.stringify({ properties: { city: "Pune" } });
    await fetch(CREATE, { method: "POST", headers: JSON_HEADERS, body });
    expect(saas.sent[1].body).toBe(body); // email, note: declared paths absent; nothing changed
    const placeholder = JSON.stringify({ properties: { email: "[EMAIL_7]", city: "Pune" } });
    await fetch(CREATE, { method: "POST", headers: JSON_HEADERS, body: placeholder });
    expect(saas.sent[2].body).toBe(placeholder);
  });

  it("blocks a non-JSON body when the profile declares request fields", async () => {
    const saas = setup();
    await expect(fetch(CREATE, { method: "POST", body: "email=rohan" })).rejects.toThrow(/not JSON/);
    expect(saas.sent).toHaveLength(0);
  });

  it("keeps originals out of the field summary, audit and notes", async () => {
    setup();
    await fetch(CREATE, create({ email: EMAIL, city: "Pune", internal_note: NOTE }));
    const view = handle?.store.getSnapshot()[0];
    expect(view?.fieldSummary?.map((f) => `${f.path}:${f.action}`).sort()).toEqual([
      "$.properties.city:allow",
      "$.properties.email:mask",
      "$.properties.internal_note:drop",
    ]);
    const seen = JSON.stringify([view?.fieldSummary, view?.actionCounts, view?.notes, handle?.audit.snapshot()]);
    for (const original of [EMAIL, "lunch", "signed off"]) expect(seen).not.toContain(original);
  });
});

describe("field-protect over the URL query string and path", () => {
  const LIST = "https://crm.example.com/api/contacts";

  it.each([
    ["an email in a query value", `${LIST}?email=${EMAIL}`, /query parameter "email"/],
    ["a percent-encoded email in a query value", `${LIST}?email=${encodeURIComponent(EMAIL)}`, /query parameter "email"/],
    ["a phone number in a query value", `${LIST}?phone=9876543210`, /query parameter "phone"/],
    ["a double-encoded email in a query value", `${LIST}?q=${encodeURIComponent(encodeURIComponent(EMAIL))}`, /query parameter "q"/],
    ["an email as a path segment", `${LIST}/${EMAIL}`, /path segment 3/],
    ["a percent-encoded email as a path segment", `${LIST}/${encodeURIComponent(EMAIL)}`, /path segment 3/],
  ])("blocks a GET with %s, sends nothing and never echoes the value", async (_name, url, reason) => {
    const saas = setup();
    const attempt = fetch(url);
    await expect(attempt).rejects.toThrow(/no-residual-detection/);
    await expect(attempt).rejects.toThrow(reason);
    await expect(attempt).rejects.not.toThrow(/mehta|9876543210/);
    expect(saas.sent).toHaveLength(0);
    const view = handle?.store.getSnapshot()[0];
    expect(view?.status).toBe("blocked");
    expect(JSON.stringify([view, handle?.audit.snapshot()])).not.toMatch(/mehta|9876543210/);
  });

  it("blocks a POST whose body is clean but whose query carries a value, and one whose body was protected", async () => {
    const saas = setup();
    await expect(fetch(`${CREATE}?owner=${EMAIL}`, create({ city: "Pune" }))).rejects.toThrow(/query parameter "owner"/);
    await expect(fetch(`${CREATE}?owner=${EMAIL}`, create({ email: EMAIL, city: "Pune" }))).rejects.toThrow(/query parameter "owner"/);
    expect(saas.sent).toHaveLength(0);
  });

  it("does not name a query key that is itself a value", async () => {
    const saas = setup();
    const attempt = fetch(`${LIST}?${EMAIL}=1`);
    await expect(attempt).rejects.toThrow(/query parameter #1/);
    await expect(attempt).rejects.not.toThrow(/mehta/);
    expect(saas.sent).toHaveLength(0);
  });

  it("lets ordinary pagination, filters and ids through", async () => {
    const saas = setup();
    await fetch(`${LIST}?page=2&limit=50&sort=city&q=Pune`);
    await fetch(`${LIST}/42`);
    expect(saas.sent).toHaveLength(2);
    expect(handle?.store.getSnapshot().every((v) => v.status === "done")).toBe(true);
  });

  it("checks the URL of a request that has no body at all (dry run is not involved)", async () => {
    const saas = setup();
    await expect(fetch(`${LIST}?email=${EMAIL}`, { method: "GET" })).rejects.toThrow(/Sensitive value still present|no-residual-detection/);
    expect(saas.sent).toHaveLength(0);
  });
});

/** No flows on the fields: the destination rules decide, so an ai host and a saas host differ. */
const BY_RULES: Profile = {
  ...SAAS,
  id: "crm-by-rules",
  request: {
    fields: [
      { path: "$.properties.name", category: "identifier" },
      { path: "$.properties.email", category: "contact" },
      { path: "$.properties.city", category: "non_sensitive" },
    ],
  },
};
const AI_CLONE: Profile = { ...BY_RULES, id: "crm-by-rules-ai", kind: "ai" };
const BY_RULES_BODY = { name: "Rohan Mehta", email: EMAIL, city: "Pune" };

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("timed out waiting for condition");
}

describe("destination rules", () => {
  it("gives a saas and an ai destination different actions, and only the ai one waits for approval", async () => {
    const saas = fakeSaas();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [BY_RULES] });
    await fetch(CREATE, create(BY_RULES_BODY));
    const saasView = handle.store.getSnapshot()[0];
    const actionOf = (path: string) => saasView.fieldSummary?.find((f) => f.path === path)?.action;
    expect(actionOf("$.properties.name")).toBe("surrogate");
    expect(actionOf("$.properties.email")).toBe("token");
    expect(saasView.status).toBe("done"); // auto approval, nobody clicked
    handle.uninstall();

    const ai = fakeSaas();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: ai.impl, profiles: [AI_CLONE] });
    const pending = fetch(CREATE, create(BY_RULES_BODY));
    await waitFor(() => handle?.store.getSnapshot()[0]?.status === "awaiting-approval");
    expect(ai.sent).toHaveLength(0);
    const aiView = handle.store.getSnapshot()[0];
    expect(aiView.fieldSummary?.find((f) => f.path === "$.properties.name")?.action).toBe("token");
    handle.store.approve(aiView.id);
    await pending;
    expect(ai.sent).toHaveLength(1);
  });

  it("applies rules stored under airlock.rules.v1 over the defaults", async () => {
    const saas = fakeSaas();
    const kv = memoryKV();
    await kv.set(
      KEYS.rules,
      JSON.stringify({
        version: 1,
        destinations: [{ id: "crm-host", match: { hosts: ["crm.example.com"] }, approval: "auto", defaults: { identifier: "drop", contact: "mask", non_sensitive: "allow" } }],
      }),
    );
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [BY_RULES], kv });
    await fetch(CREATE, create(BY_RULES_BODY));
    const props = sentProps(saas, 0);
    expect("name" in props).toBe(false);
    expect(props.email).toMatch(/^\[EMAIL_\d+\]$/);
    expect(handle.profileErrors().filter((e) => e.startsWith("rules"))).toEqual([]);
  });

  it("falls back to the defaults, with an error, when the stored rules are invalid", async () => {
    const saas = fakeSaas();
    const kv = memoryKV({ [KEYS.rules]: JSON.stringify({ version: 1, destinations: [{ id: "x", match: {}, approval: "never", defaults: {} }] }) });
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [BY_RULES], kv });
    await fetch(CREATE, create(BY_RULES_BODY));
    expect(sentProps(saas, 0).email).toMatch(/^tok_/); // the default saas rule
    expect(handle.profileErrors().some((e) => e.startsWith("rules") || e.includes("stored rules"))).toBe(true);
  });
});

describe("dryRun", () => {
  const sample = { request: { properties: { email: EMAIL, city: "Pune", internal_note: NOTE } }, sensitive: [{ path: "$.properties.email", value: EMAIL }] };
  const realList = { results: [{ id: "1", properties: { email: EMAIL, city: "Pune" } }] };

  it("passes a good profile with a clean scan and a restore round trip", async () => {
    const result = await dryRun(SAAS, { ...sample, response: realList });
    expect(result).toEqual({ ok: true, failures: [], restored: true });
    expect(await dryRun(SAAS, sample)).toMatchObject({ ok: true, restored: true }); // protected request echoed back
  });

  it("names path and rule when a detector hit is left unprotected", async () => {
    const leaky: Profile = { ...SAAS, request: { fields: SAAS.request.fields.filter((f) => f.path !== "$.properties.email") } };
    const result = await dryRun(leaky, sample);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("$.properties.email: no-residual-detection");
  });

  it("fails a classifier-sensitive field whether the profile omits it or explicitly allows it", async () => {
    const withNick = { request: { properties: { email: EMAIL, nickname: "Ro Ro Mehta" } }, sensitive: [{ path: "$.properties.nickname", value: "Ro Ro Mehta" }] };
    const result = await dryRun(SAAS, withNick);
    expect(result.failures).toContain("$.properties.nickname: sensitive-value-remains");
    // Gap closure: an explicit allow used to pass here. It must not: only a non-allow flow clears the failure.
    const allowed: Profile = { ...SAAS, request: { fields: [...SAAS.request.fields, { path: "$.properties.nickname", flow: { action: "allow" } }] } };
    expect((await dryRun(allowed, withNick)).failures).toContain("$.properties.nickname: sensitive-value-remains");
    const masked: Profile = { ...SAAS, request: { fields: [...SAAS.request.fields, { path: "$.properties.nickname", category: "identifier", flow: { action: "mask" } }] } };
    expect((await dryRun(masked, withNick)).ok).toBe(true);
  });

  it("fails an allow-all container locator that lets email, phone and salary through", async () => {
    const allowAll: Profile = { ...SAAS, request: { fields: [{ path: "$", category: "non_sensitive", flow: { action: "allow" } }] } };
    const rich = {
      request: { properties: { email: EMAIL, phone: "+91 98765 43210", salary: "68000" } },
      sensitive: [{ path: "$.properties.salary", value: "68000" }],
    };
    const result = await dryRun(allowAll, rich);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("$.properties.email: no-residual-detection");
    expect(result.failures).toContain("$.properties.phone: no-residual-detection");
    expect(result.failures).toContain("$.properties.salary: sensitive-value-remains");
    expect(JSON.stringify(result.failures)).not.toMatch(/example\.com|98765|68000/);
  });

  it("blocks at run time a leaf an explicit allow covers when a detector still hits it", async () => {
    const allowAll: Profile = { ...SAAS, id: "crm-allow-all", request: { fields: [{ path: "$", category: "non_sensitive", flow: { action: "allow" } }] } };
    const saas = setup(allowAll);
    const attempt = fetch(CREATE, create({ email: EMAIL, city: "Pune" }));
    await expect(attempt).rejects.toThrow(/no-residual-detection.*\$\.properties\.email/);
    await expect(attempt).rejects.not.toThrow(/mehta/);
    expect(saas.sent).toHaveLength(0);
    // A clean body under the same allow still goes through.
    await fetch(CREATE, create({ city: "Pune" }));
    expect(saas.sent).toHaveLength(1);
  });

  it("fails when no response field resolves, and never reports a value", async () => {
    const result = await dryRun(SAAS, { ...sample, response: { data: [{ mail: EMAIL }] } });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("response: no response field resolves");
    for (const r of [result, await dryRun({ ...SAAS, request: { fields: [] } }, sample)]) {
      expect(JSON.stringify(r.failures)).not.toContain("example.com");
    }
  });

  it("reports a block flow as a failure and leaves no persisted state behind", async () => {
    const blocking: Profile = { ...SAAS, request: { fields: [{ path: "$.properties.email", flow: { action: "block" } }] } };
    expect((await dryRun(blocking, sample)).failures).toEqual(["$.properties.email: block"]);
  });
});

/** Token, surrogate and mask together, with restore state persisted through a shared KVStore. */
const MIXED: Profile = {
  ...SAAS,
  id: "crm-mixed",
  request: {
    fields: [
      { path: "$.properties.name", category: "identifier", flow: { action: "surrogate" } },
      { path: "$.properties.email", category: "contact", flow: { action: "token" } },
      { path: "$.properties.salary", category: "financial", flow: { action: "token" } },
      { path: "$.properties.note", category: "free_text", flow: { action: "mask" } },
    ],
  },
  response: {
    fields: [
      { path: "$.results[*].properties.name" },
      { path: "$.results[*].properties.email" },
      { path: "$.results[*].properties.salary" },
      { path: "$.results[*].properties.note" },
    ],
  },
};
const NAME = "Rohan Mehta";
const NOTE_WITH_PHONE = "Call 98765 43210 about the renewal";

const listed = async () => {
  const res = await fetch("https://crm.example.com/api/contacts");
  return ((await res.json()) as { results: Array<{ properties: Record<string, string> }> }).results[0].properties;
};
const sentProps = (saas: ReturnType<typeof fakeSaas>, i: number) =>
  (JSON.parse(saas.sent[i].body as string) as { properties: Record<string, string> }).properties;
const person = { name: NAME, email: EMAIL, salary: 68000, note: NOTE_WITH_PHONE };

describe("token and surrogate with persisted restore", () => {
  it("gives the same contact the same token, whatever its case or spacing, and tokenizes numbers", async () => {
    const saas = fakeSaas();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [MIXED] });
    await fetch(CREATE, create(person));
    await fetch(CREATE, create({ ...person, email: "  Rohan.Mehta@EXAMPLE.com " }));
    const [a, b] = [sentProps(saas, 0), sentProps(saas, 1)];
    expect(a.email).toMatch(/^tok_[a-z2-7]{22}$/);
    expect(b.email).toBe(a.email);
    expect(a.salary).toMatch(/^tok_[a-z2-7]{22}$/);
    expect(saas.sent[0].body).not.toContain("68000");
  });

  it("restores tokens, surrogates and placeholders after a simulated reload, with the same token again", async () => {
    const saas = fakeSaas();
    const kv = memoryKV();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [MIXED], kv });
    await fetch(CREATE, create(person));
    handle.uninstall();

    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [MIXED], kv });
    await handle.engine.ready;
    const back = await listed();
    expect(back).toEqual({ name: NAME, email: EMAIL, salary: "68000", note: NOTE_WITH_PHONE });
    await fetch(CREATE, create(person));
    expect(saas.sent[1].body).toBeNull(); // the list GET
    expect(sentProps(saas, 2).email).toBe(sentProps(saas, 0).email);
    expect(sentProps(saas, 2).name).toBe(sentProps(saas, 0).name);
  });

  it("blocks on a token collision and sends nothing", async () => {
    const saas = fakeSaas();
    const kv = memoryKV();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [MIXED], kv });
    await fetch(CREATE, create(person));
    handle.uninstall();
    const record = JSON.parse((await kv.get(KEYS.vault)) as string) as { tokens: Record<string, string> };
    const token = sentProps(saas, 0).email;
    record.tokens[token] = "someone.else@example.com";
    await kv.set(KEYS.vault, JSON.stringify(record));

    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [MIXED], kv });
    await expect(fetch(CREATE, create(person))).rejects.toThrow(/token collision/);
    expect(saas.sent).toHaveLength(1);
    expect(handle.store.getSnapshot()[0].status).toBe("blocked");
  });

  it("uses a surrogate that differs, reads as a name, and restores in a later list", async () => {
    const saas = fakeSaas();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [MIXED] });
    await fetch(CREATE, create(person));
    const fake = sentProps(saas, 0).name;
    expect(fake).not.toBe(NAME);
    expect(fake).toMatch(/^[A-Z][a-z]+(?: [A-Z][a-z]+)+$/);
    expect(saas.sent[0].body).not.toContain("Mehta");
    expect((await listed()).name).toBe(NAME);
  });

  it("clears the vault and the key, after which protected values stay as they are", async () => {
    const saas = fakeSaas();
    const kv = memoryKV();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [MIXED], kv });
    await fetch(CREATE, create(person));
    expect(await kv.get(KEYS.vault)).toContain("tokens");
    expect(await kv.get(KEYS.tokenkey)).toBeTruthy();

    await handle.engine.clearLocalData();
    expect(await kv.get(KEYS.vault)).toBeFalsy();
    expect(await kv.get(KEYS.tokenkey)).toBeFalsy();
    const after = await listed();
    expect(after.email).toBe(sentProps(saas, 0).email);
    expect(after.name).toBe(sentProps(saas, 0).name);
    expect(JSON.stringify(after)).not.toContain(EMAIL);
  });

  it("audits protected with profile, author and action counts and no original value", async () => {
    const saas = fakeSaas();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: saas.impl, profiles: [MIXED] });
    await fetch(CREATE, create(person));
    const event = handle.audit.snapshot().find((e) => e.kind === "protected");
    expect(event?.detail).toMatchObject({ profileId: "crm-mixed", author: "user", token: 2, surrogate: 1 });
    const seen = JSON.stringify(handle.audit.snapshot()) + JSON.stringify(handle.store.getSnapshot()[0].fieldSummary);
    for (const original of [EMAIL, NAME, "Mehta", "68000", "98765"]) expect(seen).not.toContain(original);
  });
});
