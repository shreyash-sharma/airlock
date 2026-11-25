import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES, DEFAULT_RULES, GEMINI_PROFILE, GENERIC_JSON_TEMPLATE } from "./builtins.js";
import { DELETE, deleteAt, getAll, parsePath, PathError, setAt, visit } from "./jsonpath.js";
import { globMatch, hostMatches, inScope, matchProfile } from "./match.js";
import { KEYS, memoryKV, ProfileRegistry } from "./storage.js";
import { CATEGORY_OF_ENTITY, type Profile } from "./types.js";
import { MAX_DEPTH, MAX_FIELDS, validateProfile, validateRules } from "./validate.js";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function crm(extra: Partial<Profile> = {}): Profile {
  return {
    version: 1,
    id: "crm-contacts",
    name: "Example CRM contacts",
    kind: "saas",
    pipeline: "field-protect",
    match: { hosts: ["crm.example.com"], paths: ["/api/contacts", "/api/contacts/*"], methods: ["POST", "PATCH"], contentTypes: ["application/json"] },
    request: { fields: [{ path: "$.properties.email", category: "contact", flow: { action: "token" } }] },
    response: { fields: [{ path: "$.properties.email" }] },
    author: { by: "user", at: "2026-11-23T10:00:00.000Z" },
    ...extra,
  };
}

describe("jsonpath", () => {
  it("parses the supported subset", () => {
    expect(parsePath("$")).toEqual([]);
    expect(parsePath("$.a.b")).toHaveLength(2);
    expect(parsePath("$['a b'][3][*]")).toEqual([
      { t: "key", key: "a b" },
      { t: "index", index: 3 },
      { t: "wild" },
    ]);
    expect(parsePath("$.rows[*][*]")).toHaveLength(3);
  });

  it("rejects syntax outside the subset with the position", () => {
    for (const bad of ["$..a", "$.a[?(@.x)]", "$.a[0:2]", "$.*", "a.b", "$.a[", "$.a['b'", "$.a[-1]", "$.a b"]) {
      expect(() => parsePath(bad), bad).toThrow(PathError);
    }
    try {
      parsePath("$.a..b");
    } catch (e) {
      expect((e as PathError).position).toBe(3);
      expect((e as PathError).message).toContain("position 3");
    }
  });

  it("getAll returns concrete paths and [] for missing paths or non-arrays", () => {
    const doc = { rows: [{ e: "a" }, { e: "b" }], name: "x" };
    expect(getAll(doc, "$.rows[*].e")).toEqual([
      { path: "$.rows[0].e", value: "a" },
      { path: "$.rows[1].e", value: "b" },
    ]);
    expect(getAll(doc, "$.missing.deep")).toEqual([]);
    expect(getAll(doc, "$.name[*]")).toEqual([]);
    expect(getAll(doc, "$.rows[5]")).toEqual([]);
    expect(getAll(doc, "$['rows'][1]['e']")).toEqual([{ path: "$.rows[1].e", value: "b" }]);
  });

  it("setAt, deleteAt and visit work on objects and arrays", () => {
    const doc = { a: { b: 1 }, list: [1, 2, 3, 4] };
    expect(setAt(doc, "$.a.b", 9)).toBe(1);
    expect(setAt(doc, "$.a.c", 5)).toBe(1);
    expect(setAt(doc, "$.list[*]", 0)).toBe(4);
    expect(doc).toEqual({ a: { b: 9, c: 5 }, list: [0, 0, 0, 0] });
    const arr = { list: ["a", "b", "c", "d"] };
    expect(deleteAt(arr, "$.list[1]")).toBe(1);
    expect(arr.list).toEqual(["a", "c", "d"]);
    visit(arr, "$.list[*]", (v) => (v === "c" ? DELETE : String(v).toUpperCase()));
    expect(arr.list).toEqual(["A", "D"]);
    expect(deleteAt(arr, "$.nothing")).toBe(0);
    expect(() => setAt(arr, "$", 1)).toThrow(PathError);
  });

  it("does not follow prototype keys", () => {
    expect(getAll({}, "$.constructor")).toEqual([]);
    expect(getAll({}, "$['__proto__']")).toEqual([]);
  });
});

describe("validateProfile", () => {
  it("accepts a valid profile and returns a fresh normalized copy", () => {
    const input = { ...crm(), extraneous: { evil: true } };
    const r = validateProfile(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile).toEqual(crm());
      expect(r.profile).not.toBe(input);
      expect("extraneous" in r.profile).toBe(false);
    }
  });

  it("collects every error prefixed by its field path", () => {
    const bad = clone(crm()) as unknown as Record<string, any>;
    bad.match.hosts = ["crm.example.com", "*.example.com"];
    bad.request.fields[0].path = "$..email";
    bad.request.fields.push({ path: "$.ok" }, { path: "$.x", flow: { action: "explode" } });
    const r = validateProfile(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith("match.hosts[1]:"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("request.fields[0].path:"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("request.fields[2].flow.action:"))).toBe(true);
    }
  });

  it("rejects 201 fields, depth 9, wildcard hosts and unsafe path globs", () => {
    const many = crm();
    many.request.fields = Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ({ path: `$.f${i}` }));
    const r1 = validateProfile(many);
    expect(!r1.ok && r1.errors[0]).toContain("exceed the cap of 200");

    const deep = crm();
    deep.request.fields = [{ path: "$" + ".k".repeat(MAX_DEPTH + 1) }];
    const r2 = validateProfile(deep);
    expect(!r2.ok && r2.errors[0]).toMatch(/^request\.fields\[0\]\.path: depth 9/);
    expect(validateProfile({ ...crm(), request: { fields: [{ path: "$" + ".k".repeat(MAX_DEPTH) }] } }).ok).toBe(true);

    const wild = crm();
    wild.match.hosts = ["*"];
    expect(validateProfile(wild).ok).toBe(false);

    for (const glob of ["/a/(b+)+$", "/a b", "/api/**?x=1", "relative", "/a;b"]) {
      const g = crm();
      g.match.paths = [glob];
      const r = validateProfile(g);
      expect(r.ok, glob).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatch(/^match\.paths\[0\]:/);
    }
  });

  it("rejects locators outside the JSONPath subset, naming the field", () => {
    for (const path of ["$..email", "$.a[?(@.x>1)]", "$.a[(@.length-1)]", "$.a[0,1]", "$.a[1:3]", "email"]) {
      const p = crm();
      p.response.fields = [{ path: "$.ok" }, { path }];
      const r = validateProfile(p);
      expect(r.ok, path).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatch(/^response\.fields\[1\]\.path:/);
    }
  });

  it("rejects allow on any category but non_sensitive in an authored profile, by name", () => {
    const withAllow = (category: string | undefined, by: string): unknown => {
      const p = clone(crm()) as unknown as Record<string, any>;
      p.author.by = by;
      p.request.fields = [{ path: "$.properties.city", category: "non_sensitive", flow: { action: "allow" } }, { path: "$.properties.email", category, flow: { action: "allow" } }];
      return p;
    };
    for (const by of ["on_device", "in_cloud"]) {
      for (const category of ["contact", "identifier", "financial", "free_text", "sensitive_other", undefined]) {
        const r = validateProfile(withAllow(category, by));
        expect(r.ok, `${by}/${String(category)}`).toBe(false);
        if (!r.ok) {
          expect(r.errors).toHaveLength(1);
          expect(r.errors[0]).toMatch(/^request\.fields\[1\]\.flow\.action: allow-on-sensitive-category/);
        }
      }
    }
    // non_sensitive may be allowed by an authored profile; a hand-written one keeps the editor's freedom (the scan still applies).
    const ok = clone(crm()) as unknown as Record<string, any>;
    ok.author.by = "on_device";
    ok.request.fields = [{ path: "$.properties.city", category: "non_sensitive", flow: { action: "allow" } }];
    expect(validateProfile(ok).ok).toBe(true);
    expect(validateProfile(withAllow("contact", "user")).ok).toBe(true);
  });

  it("compares hosts in one canonical spelling", () => {
    for (const host of ["crm.example.com", "crm.example.com.", "CRM.Example.com..", "crm.example.com:443", "crm.example.com.:80", "crm.example.com:8443"]) {
      expect(hostMatches("crm.example.com", host), host).toBe(true);
    }
    expect(hostMatches("crm.example.com:8443", "crm.example.com.:8443")).toBe(true);
    expect(hostMatches("crm.example.com:8443", "crm.example.com:9443")).toBe(false);
    for (const host of ["crm.example.com.evil.test", "xcrm.example.com", "example.com", "crm.example.com.:evil"]) {
      expect(hostMatches("crm.example.com", host), host).toBe(false);
    }
  });

  it("treats a leading *. as the domain and its subdomains only", () => {
    for (const host of ["hubspot.com", "app.hubspot.com", "a.b.hubspot.com:8443", "APP.HubSpot.com."]) {
      expect(hostMatches("*.hubspot.com", host), host).toBe(true);
    }
    for (const host of ["hubspot.com.evil.test", "evilhubspot.com", "hubspot.co", "app.hubspot.com.evil.test"]) {
      expect(hostMatches("*.hubspot.com", host), host).toBe(false);
    }
    expect(hostMatches("*.", "anything")).toBe(false);
    expect(hostMatches("a.*.com", "a.x.com")).toBe(false);
  });

  it("allows empty hosts for templates and validates rules", () => {
    expect(validateProfile(GENERIC_JSON_TEMPLATE).ok).toBe(true);
    expect(validateProfile(GEMINI_PROFILE).ok).toBe(true);
    expect(validateRules(DEFAULT_RULES).ok).toBe(true);
    const bad = clone(DEFAULT_RULES) as unknown as Record<string, any>;
    bad.destinations[1].approval = "maybe";
    bad.destinations[0].defaults.nonsense = "mask";
    const r = validateRules(bad);
    expect(!r.ok && r.errors.some((e) => e.startsWith("destinations[1].approval:"))).toBe(true);
    expect(!r.ok && r.errors.some((e) => e.startsWith("destinations[0].defaults.nonsense:"))).toBe(true);
  });

  it("maps entity types to categories", () => {
    expect(CATEGORY_OF_ENTITY.EMAIL).toBe("contact");
    expect(CATEGORY_OF_ENTITY.PERSON).toBe("identifier");
    expect(CATEGORY_OF_ENTITY.IBAN).toBe("financial");
    expect(CATEGORY_OF_ENTITY.API_KEY).toBe("sensitive_other");
  });
});

describe("ProfileRegistry", () => {
  it("keeps valid stored profiles and rejects invalid ones whole", async () => {
    const bad = clone(crm({ id: "broken" })) as unknown as Record<string, any>;
    bad.match.hosts = ["*.evil.example"];
    const kv = memoryKV({ [KEYS.profiles]: JSON.stringify([crm(), bad]) });
    const reg = new ProfileRegistry(kv, { builtins: BUILTIN_PROFILES });
    await reg.ready;
    expect(reg.all().map((p) => p.id)).toEqual(["crm-contacts", "gemini-generate-content", "generic-json"]);
    expect(reg.errors()).toHaveLength(1);
    expect(reg.errors()[0]).toMatch(/^match\.hosts\[0\]:/);
  });

  it("corrupt storage gives one error and applies nothing", async () => {
    const reg = new ProfileRegistry(memoryKV({ [KEYS.profiles]: "{not json" }), { builtins: BUILTIN_PROFILES });
    await reg.ready;
    expect(reg.errors()).toHaveLength(1);
    expect(reg.all()).toEqual(BUILTIN_PROFILES);
  });

  it("save refuses invalid input without writing, and persists valid input", async () => {
    const kv = memoryKV();
    const reg = new ProfileRegistry(kv);
    const bad = { ...crm(), pipeline: "run-this-code" };
    const r = await reg.save(bad);
    expect(r.ok).toBe(false);
    expect(await kv.get(KEYS.profiles)).toBeNull();
    expect((await reg.save(crm())).ok).toBe(true);
    const again = new ProfileRegistry(kv);
    await again.ready;
    expect(again.all()).toEqual([crm()]);
    // Saving the same id replaces instead of duplicating.
    await reg.save(crm({ name: "Renamed" }));
    expect(JSON.parse((await kv.get(KEYS.profiles)) ?? "[]")).toHaveLength(1);
  });

  it("validates host-supplied profiles and does not persist them", async () => {
    const kv = memoryKV();
    const reg = new ProfileRegistry(kv, {
      extra: [crm(), { ...crm({ id: "bad" }), match: { hosts: ["*"], paths: ["/**"] } }],
    });
    await reg.ready;
    expect(reg.all().map((p) => p.id)).toEqual(["crm-contacts"]);
    expect(reg.errors()[0]).toContain("match.hosts[0]");
    expect(await kv.get(KEYS.profiles)).toBeNull();
  });

  it("invalid stored rules give errors and the defaults, never a merge", async () => {
    const kv = memoryKV({ [KEYS.rules]: JSON.stringify({ version: 1, destinations: [{ id: "x", match: {}, approval: "never", defaults: {} }] }) });
    const reg = new ProfileRegistry(kv);
    expect(await reg.loadRules(DEFAULT_RULES)).toBe(DEFAULT_RULES);
    expect(reg.errors()[0]).toMatch(/^destinations\[0\]\.approval:/);
    const saved = await reg.saveRules(DEFAULT_RULES);
    expect(saved.ok).toBe(true);
    expect(await reg.loadRules({ version: 1, destinations: [] })).toEqual(DEFAULT_RULES);
    expect((await reg.saveRules({ version: 2 })).ok).toBe(false);
  });
});

describe("matching", () => {
  const key = (over: Partial<{ host: string; path: string; method: string; contentType: string }> = {}) => ({
    host: "crm.example.com",
    path: "/api/contacts",
    method: "POST",
    contentType: "application/json; charset=utf-8",
    ...over,
  });

  it("globMatch honours * within a segment and ** across segments, ignoring the query", () => {
    expect(globMatch("/api/contacts/*", "/api/contacts/42")).toBe(true);
    expect(globMatch("/api/contacts/*", "/api/contacts/42/notes")).toBe(false);
    expect(globMatch("/api/**", "/api/contacts/42/notes")).toBe(true);
    expect(globMatch("/api/**", "/api")).toBe(true);
    expect(globMatch("/**", "/")).toBe(true);
    expect(globMatch("/v*/items", "/v2/items")).toBe(true);
    expect(globMatch("/api/*.json", "/api/a.json")).toBe(true);
    expect(globMatch("/api/contacts", "/api/contacts?id=1")).toBe(true);
    expect(globMatch("/api/contacts", "/api/other")).toBe(false);
  });

  it("host patterns with a port equal the URL host, otherwise the hostname", () => {
    expect(hostMatches("localhost:5173", "localhost:5173")).toBe(true);
    expect(hostMatches("localhost:5173", "localhost:3000")).toBe(false);
    expect(hostMatches("localhost", "localhost:3000")).toBe(true);
    expect(hostMatches("CRM.example.com", "crm.example.com")).toBe(true);
    expect(hostMatches("example.com", "crm.example.com")).toBe(false);
  });

  it("matchProfile honours method and content-type filters, stored before built-in", () => {
    const profiles = [crm(), ...BUILTIN_PROFILES];
    expect(matchProfile(profiles, key())?.id).toBe("crm-contacts");
    expect(matchProfile(profiles, key({ method: "GET" }))).toBeNull();
    expect(matchProfile(profiles, key({ contentType: "text/plain" }))).toBeNull();
    expect(matchProfile(profiles, key({ path: "/api/other" }))).toBeNull();
    expect(matchProfile(profiles, key({ host: "firebasevertexai.googleapis.com", path: "/v1beta/x", method: "GET", contentType: "" }))?.id).toBe("gemini-generate-content");
    const shadow = crm({ id: "shadow", match: { hosts: ["firebasevertexai.googleapis.com"], paths: ["/**"] } });
    expect(matchProfile([shadow, ...BUILTIN_PROFILES], key({ host: "firebasevertexai.googleapis.com" }))?.id).toBe("shadow");
  });

  it("inScope is profile hosts plus the scope list, and the template matches nothing", () => {
    const profiles = [crm(), ...BUILTIN_PROFILES];
    expect(inScope("crm.example.com", profiles)).toBe(true);
    expect(inScope("firebasevertexai.googleapis.com", profiles)).toBe(true);
    expect(inScope("other.example.com", profiles)).toBe(false);
    expect(inScope("other.example.com", profiles, ["other.example.com"])).toBe(true);
    expect(matchProfile([GENERIC_JSON_TEMPLATE], key())).toBeNull();
  });
});
