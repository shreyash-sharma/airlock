import { describe, expect, it } from "vitest";
import { detect } from "../core/detect.js";
import type { LocalModelLike } from "../ai/local.js";
import { KEYS, memoryKV, ProfileRegistry } from "../profiles/storage.js";
import type { DryRun } from "../profiles/types.js";
import { authorProfile, promptLeaves, type AuthoringModelLike } from "./author.js";
import { Capture, shapePreview, wildcardPath } from "./capture.js";
import { classifyFields, detectorFields, type Classification } from "./classify.js";
import { assertStructureOnly, buildAuthoringPrompt, StructureLeakError } from "./prompt.js";
import { InspectionStore } from "./session.js";

const HOST = "127.0.0.1:5173";
const CREATE_PATH = "/mock-crm/api/contacts";
const EMAIL = "rohan.mehta@example.com";
const NOTE = "Prefers evening calls and a quarterly review";
const ROHAN = {
  properties: {
    firstname: "Rohan",
    lastname: "Mehta",
    email: EMAIL,
    phone: "9876543210",
    city: "Pune",
    plan: "Enterprise",
    salary: 68000,
    internal_note: NOTE,
  },
};
const VALUES = ["Rohan", "Mehta", EMAIL, "9876543210", "Pune", "Enterprise", "68000", NOTE];

const CLASSES: Record<string, string> = {
  firstname: "identifier",
  lastname: "identifier",
  email: "contact",
  phone: "contact",
  city: "non_sensitive",
  plan: "non_sensitive",
  salary: "financial",
  internal_note: "free_text",
};

const newCapture = (): Capture => new Capture({ host: HOST, method: "POST", path: CREATE_PATH, request: ROHAN });

function classification(capture: Capture): Classification {
  return {
    source: "on_device",
    latencyMs: 1,
    calls: 1,
    fields: capture.leaves().map((l) => ({ side: l.side, path: l.path, class: CLASSES[l.path.split(".").pop() ?? ""] as never, reason: "test" })),
  };
}

const field = (name: string, category: string, action: string) => ({ path: `$.properties.${name}`, category, flow: { action } });
const CRM_PROFILE = {
  name: "Mock CRM create contact",
  kind: "saas",
  match: { hosts: [HOST], paths: [CREATE_PATH], methods: ["POST"] },
  request: {
    fields: [
      field("firstname", "identifier", "surrogate"),
      field("lastname", "identifier", "surrogate"),
      field("email", "contact", "token"),
      field("phone", "contact", "token"),
      field("salary", "financial", "token"),
      field("internal_note", "free_text", "mask"),
      field("city", "non_sensitive", "allow"),
      field("plan", "non_sensitive", "allow"),
    ],
  },
  response: { fields: [{ path: "$.properties.email" }, { path: "$.properties.firstname" }] },
};

function fakeModel(replies: unknown[], source: string | undefined = "in_cloud") {
  const prompts: string[] = [];
  const model: AuthoringModelLike = {
    async generateContent(prompt) {
      prompts.push(prompt);
      const next = replies.length > 1 ? replies.shift() : (replies[0] ?? CRM_PROFILE);
      return { response: { text: () => (typeof next === "string" ? next : JSON.stringify(next)), inferenceSource: source } };
    },
  };
  return { model, prompts };
}

const passing: DryRun = async () => ({ ok: true, failures: [], restored: true });
const failing: DryRun = async () => ({ ok: false, failures: ["$.properties.email: sensitive-value-remains"], restored: false });

describe("capture", () => {
  it("lists every leaf with type, detector hits and a shape-only preview", () => {
    const leaves = newCapture().leaves();
    const email = leaves.find((l) => l.path === "$.properties.email")!;
    expect(email).toMatchObject({ side: "request", valueType: "string" });
    expect(email.detectorHits).toContain("EMAIL");
    expect(leaves.find((l) => l.path === "$.properties.salary")!.valueType).toBe("number");
    const previews = JSON.stringify(leaves.map((l) => l.preview));
    for (const secret of ["Rohan", "Mehta", "9876543210", EMAIL, "rohan"]) expect(previews).not.toContain(secret);
    expect(shapePreview("Rohan Mehta 1")).toBe("Xxxxx Xxxxx 9");
    expect(shapePreview("a".repeat(40))).toBe(`${"x".repeat(24)}…`);
    expect(wildcardPath("$.contacts[12].emails[0]")).toBe("$.contacts[*].emails[*]");
  });

  it("holds values privately and empties them on clear", () => {
    const c = newCapture();
    expect(c.entries().map((e) => e.value)).toContain(EMAIL);
    c.clear();
    expect(c.entries()).toEqual([]);
    expect(c.request()).toBeUndefined();
    expect(JSON.stringify(c.leaves())).not.toContain("Rohan");
  });
});

describe("structure-only prompt", () => {
  it("contains every leaf path, type and class and none of the values, and trips no detector", () => {
    const c = newCapture();
    const cls = classification(c);
    const prompt = buildAuthoringPrompt({ host: HOST, method: "POST", path: CREATE_PATH, leaves: promptLeaves(c, cls) });
    for (const leaf of c.leaves()) expect(prompt).toContain(leaf.path);
    expect(prompt).toContain("number | financial");
    expect(prompt).toContain("string | contact");
    for (const v of VALUES) expect(prompt.toLowerCase()).not.toContain(v.toLowerCase());
    expect(() => assertStructureOnly(prompt, c.entries())).not.toThrow();
    expect(detect(prompt)).toEqual([]);
  });

  it("throws, naming the path and not the value, when a value is inserted, and the fake model gets zero calls", async () => {
    const c = newCapture();
    const prompt = buildAuthoringPrompt({ host: HOST, method: "POST", path: CREATE_PATH, leaves: promptLeaves(c, classification(c)) });
    const tampered = `${prompt}\nNote: contact Rohan Mehta at ${EMAIL}`;
    let error: unknown;
    try {
      assertStructureOnly(tampered, c.entries());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(StructureLeakError);
    expect((error as StructureLeakError).paths).toContain("$.properties.email");
    expect((error as Error).message).not.toContain(EMAIL);

    // A request whose object key is itself data (a name) cannot be described without leaking it: no call.
    const keyed = new Capture({ host: HOST, method: "POST", path: CREATE_PATH, request: { "Rohan Mehta": { email: EMAIL } } });
    const { model, prompts } = fakeModel([CRM_PROFILE]);
    const r = await authorProfile({ capture: keyed, classification: detectorsOnly(keyed), model, dryRun: passing });
    expect(r.status).toBe("rejected");
    expect(r.calls).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(r.errors.join(" ")).not.toContain("Rohan Mehta");
  });
});

function detectorsOnly(c: Capture): Classification {
  return { source: "detectors", latencyMs: 0, calls: 0, fields: detectorFields(c) };
}

describe("authorProfile", () => {
  it("gives a ready profile whose author.by is the SDK-reported inference source", async () => {
    const c = newCapture();
    for (const source of ["in_cloud", "on_device"] as const) {
      const { model } = fakeModel([CRM_PROFILE], source);
      const r = await authorProfile({ capture: c, classification: classification(c), model, dryRun: passing });
      expect(r.status).toBe("ready");
      expect(r.source).toBe(source);
      expect(r.profile?.author.by).toBe(source);
      expect(r.profile?.id).toBe("authored-127-0-0-1-5173");
      expect(r.profile?.pipeline).toBe("field-protect");
      expect(r.calls).toBe(1);
    }
  });

  it("registers the call with beforeCall using the exact prompt and generation config, and releases it", async () => {
    const c = newCapture();
    const { model } = fakeModel([CRM_PROFILE]);
    const seen: Array<{ prompt: string; generationConfig: unknown; model: string }> = [];
    let released = 0;
    const r = await authorProfile({
      capture: c,
      classification: classification(c),
      model,
      modelName: "gemini-x",
      generationConfig: { responseMimeType: "application/json" },
      dryRun: passing,
      beforeCall: (call) => {
        seen.push(call);
        return () => void released++;
      },
    });
    expect(seen).toEqual([{ prompt: r.prompt, generationConfig: { responseMimeType: "application/json" }, model: "gemini-x" }]);
    expect(released).toBe(1);
  });
});

describe("InspectionStore", () => {
  function setup(opts: { dryRun?: DryRun; reply?: unknown } = {}) {
    const kv = memoryKV();
    const registry = new ProfileRegistry(kv);
    const { model } = fakeModel([opts.reply ?? CRM_PROFILE]);
    const classifier: LocalModelLike = {
      async generateContent() {
        const fields = Object.entries(CLASSES).map(([k, c]) => ({ path: `$.properties.${k}`, class: c, reason: "test" }));
        return { response: { text: () => JSON.stringify({ fields }), inferenceSource: "on_device" } };
      },
      async initializeDeviceModel() {},
    };
    const store = new InspectionStore({
      registry,
      dryRun: opts.dryRun ?? passing,
      classifierModel: () => classifier,
      status: async () => "ready",
      authoringModel: () => ({ model, name: "m" }),
    });
    const { id, decision } = store.capture({ host: HOST, method: "POST", path: CREATE_PATH, request: ROHAN });
    return { kv, registry, store, id, decision };
  }

  it("saves nothing before approve; after an edit and approve exactly one authored profile is stored, with no sample value", async () => {
    const { kv, store, id, decision } = setup();
    await store.classify(id);
    expect(store.get(id)?.classification?.source).toBe("on_device");
    await store.author(id);
    expect(store.get(id)?.status).toBe("ready");
    expect(await kv.get(KEYS.profiles)).toBeNull();

    await store.edit(id, "$.properties.internal_note", "drop");
    const note = store.get(id)?.profile?.request.fields.find((f) => f.path === "$.properties.internal_note");
    expect(note?.flow?.action).toBe("drop");
    expect(await kv.get(KEYS.profiles)).toBeNull();

    expect(await store.approve(id)).toEqual({ ok: true, errors: [] });
    await expect(decision).resolves.toBe("saved");
    const stored = JSON.parse((await kv.get(KEYS.profiles))!) as Array<{ id: string; author: { by: string } }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].id.startsWith("authored-")).toBe(true);
    for (const v of VALUES) expect(JSON.stringify(stored)).not.toContain(v);
    expect(JSON.stringify(store.getSnapshot())).not.toContain(EMAIL);
  });

  it("refuses to approve while the dry run fails or validation fails, and saves nothing", async () => {
    const bad = setup({ dryRun: failing });
    await bad.store.author(bad.id);
    expect(bad.store.get(bad.id)?.status).toBe("rejected");
    expect(bad.store.get(bad.id)?.errors).toEqual(["$.properties.email: sensitive-value-remains"]);
    expect((await bad.store.approve(bad.id)).ok).toBe(false);
    expect(await bad.kv.get(KEYS.profiles)).toBeNull();

    const wide = setup({ reply: { ...CRM_PROFILE, match: { ...CRM_PROFILE.match, hosts: ["evil.example"] } } });
    await wide.store.author(wide.id);
    expect(wide.store.get(wide.id)?.status).toBe("rejected");
    expect((await wide.store.approve(wide.id)).ok).toBe(false);
    expect(await wide.kv.get(KEYS.profiles)).toBeNull();
  });

  it("clears the values when the decision resolves, on discard and on pass-through too", async () => {
    const a = setup();
    a.store.discard(a.id);
    await expect(a.decision).resolves.toBe("discarded");
    expect((await a.store.author(a.id), a.store.get(a.id)?.status)).toBe("discarded");
    const b = setup();
    b.store.passThrough(b.id);
    await expect(b.decision).resolves.toBe("pass-through");
  });
});

describe("classifyFields", () => {
  const ready = async () => "ready" as const;
  it("uses the on-device reply when the SDK reports on_device, and labels the detector fallback otherwise", async () => {
    const c = newCapture();
    const model = (source: string): LocalModelLike => ({
      async generateContent() {
        const fields = [{ path: "$.properties.firstname", class: "identifier", reason: "a first name" }];
        return { response: { text: () => JSON.stringify({ fields }), inferenceSource: source } };
      },
      async initializeDeviceModel() {},
    });
    const onDevice = await classifyFields(c, model("on_device"), { status: ready });
    expect(onDevice.source).toBe("on_device");
    expect(onDevice.fields.find((f) => f.path === "$.properties.firstname")?.class).toBe("identifier");
    expect(onDevice.fields.find((f) => f.path === "$.properties.email")?.class).toBe("contact");

    const cloud = await classifyFields(c, model("in_cloud"), { status: ready });
    expect(cloud.source).toBe("detectors");
    expect(cloud.note).toContain("in_cloud");
    expect((await classifyFields(c, null)).source).toBe("detectors");
  });
});
