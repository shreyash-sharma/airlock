import { describe, expect, it, vi } from "vitest";
import type { LocalModelLike } from "../ai/local.js";
import { dryRun } from "../flows/dryrun.js";
import type { AuthoringModelLike } from "../inspect/author.js";
import { InspectionStore } from "../inspect/session.js";
import { globMatch, matchProfile, profileMatches } from "../profiles/match.js";
import { memoryKV, ProfileRegistry } from "../profiles/storage.js";
import type { Profile } from "../profiles/types.js";
import { validateRules } from "../profiles/validate.js";
import { countRestorable, locatorsOfShape, suggestResponseLocators, validateLocator } from "./locators.js";
import { shapeOf, ShapeLog } from "./shape.js";

/** Synthetic values only. example.com is a reserved domain. */
const EMAIL = "rohan.mehta@example.com";
const LIST = { total: 1, list: [{ id: "a1b2c3", name: "Rohan Mehta", firstName: "Rohan", emailAddress: EMAIL, emailAddressData: [{ emailAddress: EMAIL, primary: true }] }] };
const DETAIL = LIST.list[0];

describe("shapeOf and ShapeLog", () => {
  it("keeps keys and types and no value", () => {
    const text = JSON.stringify(shapeOf(LIST));
    for (const v of ["Rohan", "Mehta", EMAIL, "a1b2c3"]) expect(text).not.toContain(v);
    expect(text).toContain("$string");
    expect(text).toContain("emailAddressData");
  });

  it("withholds a key that looks like data", () => {
    const text = JSON.stringify(shapeOf({ [EMAIL]: "x", fine: 1 }));
    expect(text).not.toContain(EMAIL);
    expect(text).toContain("[withheld key]");
  });

  it("records 2xx JSON only, once per identical shape, never a value, and never throws on bad text", () => {
    const log = new ShapeLog();
    log.record({ host: "crm.test", method: "GET", path: "/api/v1/Contact", status: 200, text: JSON.stringify(LIST) });
    log.record({ host: "crm.test", method: "GET", path: "/api/v1/Contact", status: 200, text: JSON.stringify(LIST) });
    log.record({ host: "crm.test", method: "GET", path: "/api/v1/Contact", status: 500, text: JSON.stringify(LIST) });
    log.record({ host: "crm.test", method: "GET", path: "/x", status: 200, text: "not json" });
    expect(log.list()).toHaveLength(1);
    expect(JSON.stringify(log.list())).not.toContain(EMAIL);
    expect(log.forHost("CRM.test")).toHaveLength(1);
  });
});

describe("locator suggestions", () => {
  it("proposes the array of a list answer and the record itself for a detail answer", () => {
    expect(locatorsOfShape(shapeOf(LIST).tree).map((l) => l.locator)).toEqual(["$.list[*]"]);
    expect(locatorsOfShape(shapeOf({ total: 0, list: [] }).tree)).toEqual([{ locator: "$.list[*]", resolves: 0 }]);
    expect(locatorsOfShape(shapeOf(DETAIL).tree).map((l) => l.locator)).toEqual(["$"]);
    expect(locatorsOfShape(shapeOf([{ a: "x" }]).tree).map((l) => l.locator)).toEqual(["$[*]"]);
  });

  it("validates a typed locator and counts what it reaches in a pasted sample", () => {
    expect(validateLocator("$..x").ok).toBe(false);
    expect(validateLocator("$.list[*]").ok).toBe(true);
    expect(countRestorable(LIST, "$.list[*]")).toEqual({ ok: true, resolves: 5 });
    expect(countRestorable(LIST, "$.nothing")).toEqual({ ok: true, resolves: 0 });
    expect(countRestorable(LIST, "$.[").ok).toBe(false);
  });

  const POST_ONLY: Profile = {
    version: 1,
    id: "crm",
    name: "crm",
    kind: "saas",
    pipeline: "field-protect",
    match: { hosts: ["crm.test"], paths: ["/api/v1/Contact"], methods: ["POST"], contentTypes: ["application/json"] },
    request: { fields: [{ path: "$.firstName", category: "identifier", flow: { action: "token" } }] },
    response: { fields: [] },
    author: { by: "on_device", at: "2026-11-24T10:00:00.000Z" },
  };

  it("suggests from answers of the same host and nearby paths, flags GET, and offers the write answer unobserved", () => {
    const log = new ShapeLog();
    log.record({ host: "crm.test", method: "GET", path: "/api/v1/Contact", status: 200, text: JSON.stringify({ total: 0, list: [] }) });
    log.record({ host: "other.test", method: "GET", path: "/api/v1/Contact", status: 200, text: JSON.stringify(DETAIL) });
    log.record({ host: "crm.test", method: "GET", path: "/api/v1/Metadata", status: 200, text: JSON.stringify(DETAIL) });
    const s = suggestResponseLocators(POST_ONLY, log.list());
    expect(s.addGet).toBe(true);
    expect(s.locators.map((l) => [l.locator, l.observed])).toEqual([
      ["$.list[*]", true],
      ["$", false],
    ]);
    expect(suggestResponseLocators(POST_ONLY, []).addGet).toBe(false);
  });
});

describe("GET matching", () => {
  const base: Profile = {
    version: 1,
    id: "p",
    name: "p",
    kind: "saas",
    pipeline: "field-protect",
    match: { hosts: ["crm.test"], paths: ["/api/v1/Contact", "/api/v1/Contact/*"], methods: ["POST"], contentTypes: ["application/json"] },
    request: { fields: [] },
    response: { fields: [] },
    author: { by: "user", at: "2026-11-24T10:00:00.000Z" },
  };
  const key = (method: string, path = "/api/v1/Contact", contentType = "") => ({ host: "crm.test", path, method, contentType });

  it("skips the content-type prefixes only when the methods explicitly name GET or HEAD", () => {
    expect(profileMatches(base, key("GET"))).toBe(false);
    expect(profileMatches({ ...base, match: { ...base.match, methods: undefined } }, key("GET"))).toBe(false);
    expect(profileMatches({ ...base, match: { ...base.match, methods: ["POST", "GET"] } }, key("GET"))).toBe(true);
    expect(profileMatches({ ...base, match: { ...base.match, methods: ["POST", "GET"] } }, key("GET", "/api/v1/Contact/abc123"))).toBe(true);
    expect(profileMatches({ ...base, match: { ...base.match, methods: ["POST", "GET"] } }, key("HEAD"))).toBe(false);
    expect(profileMatches({ ...base, match: { ...base.match, methods: ["HEAD"] } }, key("HEAD"))).toBe(true);
  });

  it("still enforces content types for writes, so a POST of another type is not matched", () => {
    const withGet = { ...base, match: { ...base.match, methods: ["POST", "GET"] } };
    expect(profileMatches(withGet, key("POST", "/api/v1/Contact", "application/json"))).toBe(true);
    expect(profileMatches(withGet, key("POST", "/api/v1/Contact", "text/plain"))).toBe(false);
    expect(matchProfile([withGet], key("DELETE", "/api/v1/Contact/abc"))).toBeNull();
    expect(globMatch("/api/v1/Contact/*", "/api/v1/Contact/abc/stream")).toBe(false);
  });
});

describe("destination rule allowReads", () => {
  const dest = (extra: object, match: object = { hosts: ["crm.test"] }) => ({
    version: 1,
    destinations: [{ id: "d", match, approval: "ask", defaults: {}, ...extra }],
  });
  it("is kept only as true, only on a rule that names hosts, and refuses other types", () => {
    const ok = validateRules(dest({ allowReads: true }));
    expect(ok.ok && ok.rules.destinations[0].allowReads).toBe(true);
    const off = validateRules(dest({ allowReads: false }));
    expect(off.ok && "allowReads" in off.rules.destinations[0]).toBe(false);
    expect(validateRules(dest({ allowReads: true }, { kind: "saas" })).ok).toBe(false);
    expect(validateRules(dest({ allowReads: "yes" })).ok).toBe(false);
  });
});

describe("InspectionStore learns response locators", () => {
  const CLASSES: Record<string, string> = { firstName: "identifier", emailAddress: "contact", description: "free_text" };
  const REQUEST = { firstName: "Rohan", emailAddress: EMAIL, description: "Prefers evening calls" };
  const PROFILE = {
    name: "crm contact",
    kind: "saas",
    match: { hosts: ["HOST"], paths: ["/api/v1/Contact"], methods: ["POST"], contentTypes: ["application/json"] },
    request: {
      fields: [
        { path: "$.firstName", category: "identifier", flow: { action: "token" } },
        { path: "$.emailAddress", category: "contact", flow: { action: "token" } },
        { path: "$.description", category: "free_text", flow: { action: "drop" } },
      ],
    },
    response: { fields: [] },
  };

  function setup(log: ShapeLog) {
    const registry = new ProfileRegistry(memoryKV());
    const classifier: LocalModelLike = {
      async generateContent() {
        const fields = Object.entries(CLASSES).map(([k, c]) => ({ path: `$.${k}`, class: c, reason: "test" }));
        return { response: { text: () => JSON.stringify({ fields }), inferenceSource: "on_device" } };
      },
      async initializeDeviceModel() {},
    };
    const model: AuthoringModelLike = { async generateContent() { return { response: { text: () => JSON.stringify(PROFILE), inferenceSource: "on_device" } }; } };
    const store = new InspectionStore({ registry, dryRun, classifierModel: () => classifier, status: async () => "ready", authoringModel: () => ({ model, name: "m" }), observations: log });
    const { id } = store.capture({ host: "crm.test", method: "POST", path: "/api/v1/Contact", request: REQUEST });
    return { store, registry, id };
  }

  it("proposes locators after authoring, applies them to the draft, adds GET only on request, and saves them with the profile", async () => {
    const log = new ShapeLog();
    log.record({ host: "crm.test", method: "GET", path: "/api/v1/Contact", status: 200, text: JSON.stringify({ total: 0, list: [] }) });
    const { store, registry, id } = setup(log);
    await store.author(id);
    const item = store.get(id)!;
    expect(item.errors).toEqual([]);
    expect(item.status).toBe("ready");
    expect(item.suggestions?.locators.map((l) => [l.locator, l.accepted])).toEqual([
      ["$.list[*]", true],
      ["$", true],
    ]);
    expect(item.suggestions?.addGet).toBe(true);
    expect(item.profile?.response.fields.map((f) => f.path)).toEqual(["$.list[*]", "$"]);
    // Nothing is covered for reads until the user clicks Add GET.
    expect(item.profile?.match.methods).toEqual(["POST"]);

    await store.setLocatorAccepted(id, "$", false);
    expect(store.get(id)?.profile?.response.fields.map((f) => f.path)).toEqual(["$.list[*]"]);
    await store.setLocatorAccepted(id, "$", true);

    await store.addGet(id);
    const added = store.get(id)!;
    expect(added.profile?.match.methods).toEqual(["POST", "GET"]);
    expect(added.profile?.match.paths).toEqual(["/api/v1/Contact", "/api/v1/Contact/*"]);
    expect(added.status).toBe("ready");

    expect((await store.addLocator(id, "$..bad")).ok).toBe(false);
    expect((await store.addLocator(id, "$.note")).ok).toBe(true);

    expect((await store.approve(id)).ok).toBe(true);
    const saved = registry.all()[0];
    expect(saved.response.fields.map((f) => f.path)).toEqual(["$.list[*]", "$", "$.note"]);
    expect(JSON.stringify(registry.all())).not.toContain(EMAIL);
  });

  it("keeps a draft that failed only the dry run, so the user can correct a field; Approve stays refused until it passes", async () => {
    const registry = new ProfileRegistry(memoryKV());
    const strict: typeof dryRun = async (profile) => {
      const covered = profile.request.fields.some((f) => f.path === "$.description" && f.flow?.action === "drop");
      return covered ? { ok: true, failures: [], restored: true } : { ok: false, failures: ["$.description: sensitive-value-remains"], restored: false };
    };
    const classifier: LocalModelLike = {
      async generateContent() {
        return { response: { text: () => JSON.stringify({ fields: [{ path: "$.description", class: "free_text", reason: "test" }] }), inferenceSource: "on_device" } };
      },
      async initializeDeviceModel() {},
    };
    const wrong = { ...PROFILE, request: { fields: PROFILE.request.fields.filter((f) => f.path !== "$.description") } };
    const model: AuthoringModelLike = { async generateContent() { return { response: { text: () => JSON.stringify(wrong), inferenceSource: "on_device" } }; } };
    const store = new InspectionStore({ registry, dryRun: strict, classifierModel: () => classifier, status: async () => "ready", authoringModel: () => ({ model, name: "m" }) });
    const { id } = store.capture({ host: "crm.test", method: "POST", path: "/api/v1/Contact", request: REQUEST });
    await store.author(id);
    const item = store.get(id)!;
    expect(item.status).toBe("rejected");
    expect(item.errors).toEqual(["$.description: sensitive-value-remains"]);
    expect(item.profile?.request.fields.some((f) => f.path === "$.description")).toBe(false);
    expect((await store.approve(id)).ok).toBe(false);
    expect(registry.all()).toHaveLength(0);
    await store.edit(id, "$.description", "drop", "free_text");
    expect(store.get(id)?.status).toBe("ready");
    expect((await store.approve(id)).ok).toBe(true);
    expect(registry.all()).toHaveLength(1);
  });

  it("refreshes the proposals when a new answer is observed after authoring", async () => {
    const log = new ShapeLog();
    const { store, id } = setup(log);
    await store.author(id);
    expect(store.get(id)?.suggestions?.addGet).toBe(false);
    log.record({ host: "crm.test", method: "GET", path: "/api/v1/Contact/a1b2c3", status: 200, text: JSON.stringify(DETAIL) });
    await vi.waitFor(() => expect(store.get(id)?.suggestions?.addGet).toBe(true));
  });
});
