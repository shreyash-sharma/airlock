import { describe, expect, it } from "vitest";
import { extractJsonObject, type LocalModelLike } from "../ai/local.js";
import { dryRun as realDryRun } from "../flows/dryrun.js";
import type { Category, DryRun } from "../profiles/types.js";
import { authorProfile, type AuthoringModelLike } from "./author.js";
import { Capture } from "./capture.js";
import { classifyFields, type Classification } from "./classify.js";

const HOST = "127.0.0.1:5173";
const CREATE_PATH = "/mock-crm/api/contacts";
const EMAIL = "rohan.mehta@example.com";
const ROHAN = { properties: { firstname: "Rohan", lastname: "Mehta", email: EMAIL, phone: "9876543210", city: "Pune", salary: 68000 } };
const CLASSES: Record<string, Category> = {
  firstname: "identifier",
  lastname: "identifier",
  email: "contact",
  phone: "contact",
  city: "non_sensitive",
  salary: "financial",
};

const newCapture = (): Capture => new Capture({ host: HOST, method: "POST", path: CREATE_PATH, request: ROHAN });
const classOf = (c: Capture): Classification => ({
  source: "on_device",
  latencyMs: 1,
  calls: 1,
  fields: c.leaves().map((l) => ({ side: l.side, path: l.path, class: CLASSES[l.path.split(".").pop() ?? ""], reason: "test" })),
});

const field = (name: string, category: string, action: string) => ({ path: `$.properties.${name}`, category, flow: { action } });
const GOOD = {
  name: "Mock CRM create contact",
  kind: "saas",
  match: { hosts: ["HOST"], paths: [CREATE_PATH], methods: ["POST"] },
  request: {
    fields: [
      field("firstname", "identifier", "surrogate"),
      field("lastname", "identifier", "surrogate"),
      field("email", "contact", "token"),
      field("phone", "contact", "token"),
      field("salary", "financial", "token"),
      field("city", "non_sensitive", "allow"),
    ],
  },
  response: { fields: [{ path: "$.properties.email" }] },
};

function fakeModel(replies: Array<unknown>, source?: string, delayMs = 0) {
  const prompts: string[] = [];
  const model: AuthoringModelLike = {
    async generateContent(prompt) {
      prompts.push(prompt);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const next = replies.length > 1 ? replies.shift() : replies[0];
      return { response: { text: () => (typeof next === "string" ? next : JSON.stringify(next)), inferenceSource: source } };
    },
  };
  return { model, prompts };
}

const passing: DryRun = async () => ({ ok: true, failures: [], restored: true });

async function author(replies: unknown[], dry: DryRun = passing, source: string | null = "in_cloud") {
  const c = newCapture();
  const { model, prompts } = fakeModel(replies, source ?? undefined);
  const r = await authorProfile({ capture: c, classification: classOf(c), model, dryRun: dry });
  return { r, prompts };
}

describe("hostile model output is rejected by name and never saved", () => {
  const cases: Array<[string, unknown, RegExp, number]> = [
    ["oversized text", `{"name":"${"a".repeat(70_000)}"}`, /oversized/, 1],
    ["201 fields", { ...GOOD, request: { fields: Array.from({ length: 201 }, (_, i) => field(`f${i}`, "free_text", "mask")) } }, /exceed the cap of 200/, 2],
    ["another host", { ...GOOD, match: { ...GOOD.match, hosts: ["evil.example"] } }, /cannot widen its scope/, 2],
    ["a second host next to the captured one", { ...GOOD, match: { ...GOOD.match, hosts: [HOST, "evil.example"] } }, /cannot widen its scope/, 2],
    ["recursive descent", { ...GOOD, request: { fields: [{ path: "$..email", flow: { action: "token" } }] } }, /recursive descent/, 2],
    ["a filter locator", { ...GOOD, request: { fields: [{ path: "$.properties[?(@.email)]", flow: { action: "token" } }] } }, /only \[n\]/, 2],
    ["a regex-like path glob", { ...GOOD, match: { ...GOOD.match, paths: ["/mock-crm/api/(contacts|people)+"] } }, /only letters, digits/, 2],
    ["the ai-minimize pipeline", { ...GOOD, pipeline: "ai-minimize" }, /not allowed for an authored profile/, 2],
    ["a path that does not match the captured request", { ...GOOD, match: { ...GOOD.match, paths: ["/other/**"] } }, /does not match the captured request/, 2],
    ["not JSON", "I cannot help with that", /not valid JSON/, 2],
  ];
  for (const [name, reply, expected, calls] of cases) {
    it(`rejects ${name}`, async () => {
      const { r } = await author([reply]);
      expect(r.status).toBe("rejected");
      expect(r.profile).toBeUndefined();
      expect(r.errors.join(" | ")).toMatch(expected);
      expect(r.calls).toBe(calls);
    });
  }

  it("strips a __proto__ key and changes no prototype", async () => {
    const text = JSON.stringify(GOOD).replace(
      '"flow":{"action":"token"}',
      '"flow":{"action":"token","params":{"__proto__":"x","constructor":"y","keep":"ok"}}',
    );
    const poisoned = text.replace("{", '{"__proto__":{"polluted":"yes"},');
    const { r } = await author([poisoned]);
    expect(r.status).toBe("ready");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const email = r.profile!.request.fields.find((f) => f.path === "$.properties.email")!;
    expect(email.flow?.params).toEqual({ keep: "ok" });
    expect(Object.keys(email.flow?.params ?? {})).not.toContain("__proto__");
  });
});

describe("one feedback retry", () => {
  it("sends the failures back once, re-asserted structure-only, and accepts the fixed answer", async () => {
    let n = 0;
    const dry: DryRun = async () => (n++ === 0 ? { ok: false, failures: ["$.properties.email: sensitive-value-remains"], restored: false } : { ok: true, failures: [], restored: true });
    const { r, prompts } = await author([GOOD], dry);
    expect(r.status).toBe("ready");
    expect(r.calls).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("sensitive-value-remains");
    expect(prompts[1]).toContain("$.properties.email: sensitive-value-remains");
    for (const secret of ["Rohan", "Mehta", EMAIL, "9876543210", "68000"]) expect(prompts[1]).not.toContain(secret);
  });

  it("gives up after the second failure: rejected, calls 2, never 3", async () => {
    const dry: DryRun = async () => ({ ok: false, failures: ["$.properties.phone: sensitive-value-remains"], restored: false });
    const { r, prompts } = await author([GOOD], dry);
    expect(r.status).toBe("rejected");
    expect(r.calls).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(r.errors).toEqual(["$.properties.phone: sensitive-value-remains"]);
  });

  it("withholds a failure message that carries a captured value, so no prompt and no error shows it", async () => {
    const dry: DryRun = async () => ({ ok: false, failures: [`$.properties.email: leaked ${EMAIL}`], restored: false });
    const { r, prompts } = await author([GOOD], dry);
    expect(r.status).toBe("rejected");
    expect(r.calls).toBe(2);
    expect(prompts[1]).toContain("withheld");
    for (const text of [...prompts, ...r.errors, r.prompt]) expect(text).not.toContain(EMAIL);
  });

  it("releases the beforeCall allowance after each call", async () => {
    let held = 0;
    let max = 0;
    const c = newCapture();
    const { model } = fakeModel([GOOD], "in_cloud");
    let n = 0;
    const dry: DryRun = async () => (n++ === 0 ? { ok: false, failures: ["$.x: y"], restored: false } : { ok: true, failures: [], restored: true });
    await authorProfile({
      capture: c,
      classification: classOf(c),
      model,
      dryRun: dry,
      beforeCall: () => {
        held++;
        max = Math.max(max, held);
        return () => void held--;
      },
    });
    expect(max).toBe(1);
    expect(held).toBe(0);
  });
});

describe("inference source and latency", () => {
  it("rejects any inferenceSource other than on_device or in_cloud", async () => {
    for (const source of [null, "cached", "ON_DEVICE"]) {
      const { r } = await author([GOOD], passing, source);
      expect(r.status).toBe("rejected");
      expect(r.errors.join(" ")).toContain("inference source");
      expect(r.calls).toBe(1);
    }
  });

  it("records the real source and the measured latency", async () => {
    const c = newCapture();
    const { model } = fakeModel([GOOD], "on_device", 25);
    const r = await authorProfile({ capture: c, classification: classOf(c), model, dryRun: passing });
    expect(r.profile?.author.by).toBe("on_device");
    expect(r.source).toBe("on_device");
    expect(r.latencyMs).toBeGreaterThanOrEqual(20);
  });
});

describe("OpenAI-style chat profile authored from a captured fixture", () => {
  it("yields a ready profile that masks messages[*].content and restores choices[*].message.content", async () => {
    const request = { model: "gpt-fixture", messages: [{ role: "user", content: `Draft a reply to ${EMAIL} about the renewal` }] };
    const response = { id: "chatcmpl-fixture", choices: [{ index: 0, message: { role: "assistant", content: "Here is a draft reply." } }] };
    const c = new Capture({ host: "api.openai.com", method: "POST", path: "/v1/chat/completions", request, response });
    const classification: Classification = {
      source: "on_device",
      latencyMs: 1,
      calls: 1,
      fields: c.leaves().map((l) => ({ side: l.side, path: l.path, class: l.path.endsWith(".content") && l.side === "request" ? "free_text" : "non_sensitive", reason: "test" })),
    };
    const reply = {
      name: "OpenAI chat completions",
      kind: "ai",
      match: { hosts: ["api.openai.com"], paths: ["/v1/chat/completions"], methods: ["POST"] },
      request: { fields: [{ path: "$.messages[*].content", category: "free_text", flow: { action: "mask" } }] },
      response: { fields: [{ path: "$.choices[*].message.content" }] },
    };
    const { model } = fakeModel([reply], "in_cloud");
    const r = await authorProfile({ capture: c, classification, model, dryRun: realDryRun });
    expect(r.errors).toEqual([]);
    expect(r.status).toBe("ready");
    expect(r.profile?.id).toBe("authored-api-openai-com");
    expect(r.profile?.request.fields[0]).toMatchObject({ path: "$.messages[*].content", flow: { action: "mask" } });
    expect(r.profile?.response.fields[0].path).toBe("$.choices[*].message.content");
    expect(r.dryRun?.ok).toBe(true);
  });
});

describe("extractJsonObject", () => {
  it("unfences, takes the outermost braces, and returns null on failure", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! {"a":{"b":2}} hope that helps')).toEqual({ a: { b: 2 } });
    expect(extractJsonObject("no json")).toBeNull();
    expect(extractJsonObject('{"a":')).toBeNull();
    expect(extractJsonObject("[1,2]")).toBeNull();
  });
});

describe("classification hardening", () => {
  const ready = async () => "ready" as const;
  function model(replies: Array<string | Error>, source = "on_device") {
    const prompts: string[] = [];
    let inits = 0;
    const m: LocalModelLike = {
      async generateContent(prompt) {
        prompts.push(prompt);
        const next = replies.shift() ?? "{}";
        if (next instanceof Error) throw next;
        return { response: { text: () => next, inferenceSource: source } };
      },
      async initializeDeviceModel() {
        inits++;
      },
    };
    return { m, prompts, inits: () => inits };
  }
  const classFor = (r: Classification, path: string) => r.fields.find((f) => f.path === path)?.class;

  it("parses a fenced reply and a truncated reply", async () => {
    const c = newCapture();
    const fenced = '```json\n{"fields":[{"path":"$.properties.firstname","class":"identifier","reason":"first name"}]}\n```';
    const a = await classifyFields(c, model([fenced]).m, { status: ready });
    expect(a.source).toBe("on_device");
    expect(classFor(a, "$.properties.firstname")).toBe("identifier");

    const cut = '{"fields":[{"path":"$.properties.lastname","class":"identifier","reason":"surname"},{"path":"$.properties.city","class":"contact","reason":"cu';
    const b = await classifyFields(c, model([cut]).m, { status: ready });
    expect(b.source).toBe("on_device");
    expect(classFor(b, "$.properties.lastname")).toBe("identifier");
    expect(classFor(b, "$.properties.city")).toBe("contact");
  });

  it("drops unknown paths and unknown classes", async () => {
    const c = newCapture();
    const reply = JSON.stringify({
      fields: [
        { path: "$.nope", class: "contact", reason: "x" },
        { path: "$.properties.firstname", class: "banana", reason: "x" },
        { path: "$.properties.email", class: "contact", reason: "ok" },
      ],
    });
    const r = await classifyFields(c, model([reply]).m, { status: ready });
    expect(r.fields.some((f) => f.path === "$.nope")).toBe(false);
    expect(classFor(r, "$.properties.firstname")).toBe("non_sensitive");
    expect(classFor(r, "$.properties.email")).toBe("contact");
  });

  it("retries once on garbage, then reads the valid reply", async () => {
    const c = newCapture();
    const good = JSON.stringify({ fields: [{ path: "$.properties.salary", class: "financial", reason: "pay" }] });
    const { m, prompts } = model(["garbage", good]);
    const r = await classifyFields(c, m, { status: ready });
    expect(r.source).toBe("on_device");
    expect(r.calls).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(classFor(r, "$.properties.salary")).toBe("financial");
    const twice = await classifyFields(c, model(["x", "y"]).m, { status: ready });
    expect(twice.source).toBe("detectors");
    expect(twice.calls).toBe(2);
    expect(twice.note).toContain("unreadable");
  });

  it("falls back to labelled detectors for the wrong source, a throw, or an unavailable model", async () => {
    const c = newCapture();
    const wrong = await classifyFields(c, model(['{"fields":[]}'], "in_cloud").m, { status: ready });
    expect(wrong.source).toBe("detectors");
    expect(wrong.note).toContain("in_cloud");

    const thrown = await classifyFields(c, model([new Error("boom")]).m, { status: ready });
    expect(thrown.source).toBe("detectors");
    expect(thrown.note).toContain("boom");

    const unavailable = model(['{"fields":[]}']);
    const none = await classifyFields(c, unavailable.m, { status: async () => "unavailable" });
    expect(none.source).toBe("detectors");
    expect(none.note).toContain("unavailable");
    expect(unavailable.prompts).toHaveLength(0);
    expect(none.calls).toBe(0);
  });

  it("initializes the device model once, sends values cut to 60 characters inside an untrusted block, and never to a cloud source", async () => {
    const c = new Capture({ host: HOST, method: "POST", path: CREATE_PATH, request: { note: "a".repeat(100) } });
    const { m, prompts, inits } = model(["{}", "{}"]);
    await classifyFields(c, m, { status: ready });
    await classifyFields(c, m, { status: ready });
    expect(inits()).toBe(1);
    expect(prompts[0]).toContain("<fields>");
    expect(prompts[0]).toContain("untrusted");
    expect(prompts[0]).toContain("a".repeat(60));
    expect(prompts[0]).not.toContain("a".repeat(61));
  });
});
