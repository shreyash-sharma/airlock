import { STRICT_RULES } from "../flows/rules.js";
import { afterEach, describe, expect, it } from "vitest";
import { SAMPLE_CONTRACT } from "../../host/sample-contract.js";
import { LocalAIError, type Analyzer, type Clause, type Selection } from "../core/types.js";
import type { Profile } from "../profiles/types.js";
import { INJECTED_LEAK, installAirlock, type AirlockHandle } from "./guard.js";

const CLOUD = "https://firebasevertexai.googleapis.com/v1beta/projects/p/models/m:generateContent";

function body(task: string, doc: string): string {
  return JSON.stringify({ contents: [{ role: "user", parts: [{ text: task }, { text: doc }] }] });
}

/** A fake cloud that records what it receives and echoes the first placeholder it sees. */
function fakeCloud() {
  const sent: Array<{ url: string; body: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const text = String(init?.body ?? "");
    sent.push({ url: String(input), body: text });
    const token = /\[[A-Z_]+_\d+\]/.exec(text)?.[0] ?? "none";
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: `See ${token} and [C2]` }] } }] }), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "999" },
    });
  }) as typeof fetch;
  return { sent, impl };
}

const pick =
  (heads: string[]): Analyzer => ({
    async select(_task: string, clauses: Clause[]): Promise<Selection> {
      const ids = clauses.filter((c) => heads.some((h) => c.heading.toLowerCase().includes(h))).map((c) => c.id);
      return { ids, reasons: Object.fromEntries(ids.map((i) => [i, "needed"])), source: "on_device", latencyMs: 5, calls: 1 };
    },
  });

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("timed out waiting for condition");
}

let handle: AirlockHandle | undefined;
afterEach(() => handle?.uninstall());

describe("guard", () => {
  it("passes non-guarded requests through untouched", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl });
    await fetch("https://example.com/data", { method: "POST", body: "plain" });
    expect(cloud.sent).toEqual([{ url: "https://example.com/data", body: "plain" }]);
    expect(handle.store.getSnapshot()).toHaveLength(0);
  });

  it("minimizes, masks, sends only the approved body and restores the answer", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES,
      fetchImpl: cloud.impl,
      autoApprove: true,
      analyzer: pick(["salary", "equipment"]),
      protectedTerms: ["Maria Sofia Alvarez"],
    });
    const res = await fetch(CLOUD, { method: "POST", body: body("Which clauses should I negotiate?", SAMPLE_CONTRACT) });
    const json = (await res.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };

    expect(cloud.sent).toHaveLength(1);
    const wire = cloud.sent[0].body;
    for (const secret of ["GB82 WEST", "sk_live_DEMO", "Orc4-Delta", "536-90-4399", "Probation", "Maria Sofia"]) {
      expect(wire).not.toContain(secret);
    }
    expect(wire).toContain("GBP 68,000");
    const answer = json.candidates[0].content.parts[0].text;
    expect(answer).not.toMatch(/\[[A-Z_]+_\d+\]/); // placeholder restored for the app
    expect(answer).toContain("[C2]");

    const view = handle.store.getSnapshot()[0];
    expect(view.status).toBe("done");
    expect(view.cloudView).toMatch(/\[[A-Z_]+_\d+\]/); // what the cloud saw
    expect(view.wireHash).toMatch(/^[0-9a-f]{64}$/);
    // The fake answer cites [C2], which was not selected, so the check flags it.
    expect(view.citations?.outside).toEqual(["C2"]);
    expect(handle.audit.snapshot().map((e) => e.kind)).toEqual([
      "request-held", "local-analysis", "policy", "approved", "sent", "response",
    ]);
    // The audit never carries original values.
    expect(JSON.stringify(handle.audit.snapshot())).not.toContain("maria.alvarez83");
  });

  it("stops an injected secret with the real policy and sends nothing", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, analyzer: pick(["salary"]) });
    const pending = fetch(CLOUD, { method: "POST", body: body("t", SAMPLE_CONTRACT) });
    const settled = pending.catch((e: Error) => e);
    await waitFor(() => handle!.store.getSnapshot()[0]?.status === "awaiting-approval");
    handle.store.injectLeak(handle.store.getSnapshot()[0].id);
    expect(String(await settled)).toContain("no-residual-detection");
    const view = handle.store.getSnapshot()[0];
    expect(view.status).toBe("blocked");
    expect(view.injected).toBe(true);
    expect(view.prepared?.outboundText).toContain(INJECTED_LEAK);
    expect(cloud.sent).toHaveLength(0);
  });

  it("sends nothing when the user denies", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, analyzer: pick(["salary"]) });
    const pending = fetch(CLOUD, { method: "POST", body: body("t", SAMPLE_CONTRACT) });
    const settled = pending.catch((e: Error) => e);
    await waitFor(() => handle!.store.getSnapshot()[0]?.status === "awaiting-approval");
    handle.store.deny(handle.store.getSnapshot()[0].id);
    expect(String(await settled)).toContain("denied");
    expect(cloud.sent).toHaveLength(0);
    expect(handle.store.getSnapshot()[0].status).toBe("denied");
  });

  it("holds when the local model fails and only continues with the labelled fallback", async () => {
    const cloud = fakeCloud();
    const broken: Analyzer = {
      async select() {
        throw new LocalAIError("not-ready", "On-device model is not ready.");
      },
    };
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, analyzer: broken });
    const pending = fetch(CLOUD, { method: "POST", body: body("Is the non-compete reasonable?", SAMPLE_CONTRACT) });
    await waitFor(() => handle!.store.getSnapshot()[0]?.status === "local-failed");
    expect(cloud.sent).toHaveLength(0);
    handle.store.useFallback(handle.store.getSnapshot()[0].id);
    await waitFor(() => handle!.store.getSnapshot()[0]?.status === "awaiting-approval");
    expect(handle.store.getSnapshot()[0].selection?.source).toBe("deterministic");
    handle.store.approve(handle.store.getSnapshot()[0].id);
    await pending;
    expect(cloud.sent).toHaveLength(1);
    expect(cloud.sent[0].body).not.toContain("sk_live_DEMO");
  });

  it("blocks streaming endpoints, odd shapes and policy failures without sending", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, autoApprove: true, analyzer: pick(["salary"]), maxChars: 50 });
    await expect(fetch(CLOUD.replace(":generateContent", ":streamGenerateContent"), { method: "POST", body: "{}" })).rejects.toThrow(/Streaming/);
    await expect(fetch(CLOUD, { method: "POST", body: JSON.stringify({ foo: 1 }) })).rejects.toThrow(/contents/);
    await expect(fetch(CLOUD, { method: "POST", body: body("t", SAMPLE_CONTRACT) })).rejects.toThrow(/size-budget/);
    expect(cloud.sent).toHaveLength(0);
    expect(handle.store.getSnapshot().every((v) => v.status === "blocked")).toBe(true);
  });
});

/** A fake cloud that also records the headers it was given. */
function headerCloud() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
  }) as typeof fetch;
  return { calls, impl };
}

const CRM_PROFILE: Profile = {
  version: 1,
  id: "crm-contacts",
  name: "Example CRM contacts",
  kind: "saas",
  pipeline: "field-protect",
  match: { hosts: ["crm.example.com"], paths: ["/api/**"] },
  request: { fields: [{ path: "$" }] },
  response: { fields: [] },
  author: { by: "user", at: "2026-11-23T10:00:00.000Z" },
};

describe("guard bypass hardening", () => {
  it("runs Request and URL inputs to a Gemini host through the pipeline", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, autoApprove: true, analyzer: pick(["salary"]) });
    const req = new Request(CLOUD, { method: "POST", headers: { "content-type": "application/json" }, body: body("Which clauses?", SAMPLE_CONTRACT) });
    await fetch(req);
    await fetch(new URL(CLOUD), { method: "POST", body: body("Which clauses?", SAMPLE_CONTRACT) });
    expect(cloud.sent).toHaveLength(2);
    for (const s of cloud.sent) {
      expect(s.body).not.toContain("536-90-4399");
      expect(s.body).not.toContain("sk_live_DEMO");
    }
    expect(handle.store.getSnapshot().map((v) => v.status)).toEqual(["done", "done"]);
  });

  it("normalizes Headers instances, pairs and records alike", async () => {
    const cloud = headerCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, autoApprove: true, analyzer: pick(["salary"]) });
    const b = body("Which clauses?", SAMPLE_CONTRACT);
    const variants: HeadersInit[] = [
      new Headers({ "X-Test": "1", "Content-Type": "application/json" }),
      [
        ["X-Test", "1"],
        ["Content-Type", "application/json"],
      ],
      { "X-Test": "1", "Content-Type": "application/json" },
    ];
    for (const headers of variants) await fetch(CLOUD, { method: "POST", headers, body: b });
    expect(cloud.calls).toHaveLength(3);
    for (const c of cloud.calls) expect(c.headers).toEqual({ "x-test": "1", "content-type": "application/json" });
  });

  it("blocks FormData, Blob, ArrayBuffer, URLSearchParams and stream bodies in scope with no network call", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, autoApprove: true, analyzer: pick(["salary"]) });
    const bodies: Array<[string, BodyInit]> = [
      ["FormData", new FormData()],
      ["Blob", new Blob(["x"])],
      ["ArrayBuffer", new ArrayBuffer(4)],
      ["URLSearchParams", new URLSearchParams({ a: "1" })],
      ["ReadableStream", new ReadableStream()],
    ];
    for (const [name, b] of bodies) {
      await expect(fetch(CLOUD, { method: "POST", body: b, duplex: "half" } as RequestInit)).rejects.toThrow(new RegExp(name));
    }
    expect(cloud.sent).toHaveLength(0);
    expect(handle.store.getSnapshot().every((v) => v.status === "blocked")).toBe(true);
  });

  it("blocks an in-scope request that no profile matches, naming method, host and path", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, scope: ["crm.example.com"] });
    await expect(fetch("https://crm.example.com/api/contacts?x=1", { method: "POST", body: "{}" })).rejects.toThrow(
      /No profile matches POST crm\.example\.com\/api\/contacts/,
    );
    expect(cloud.sent).toHaveLength(0);
    const view = handle.store.getSnapshot()[0];
    expect(view.status).toBe("blocked");
    expect(view.message).toContain("No profile matches");
    expect(handle.audit.snapshot().map((e) => e.kind)).toEqual(["blocked"]);
    // An out-of-scope host is untouched.
    await fetch("https://other.example.com/x", { method: "POST", body: "plain" });
    expect(cloud.sent).toHaveLength(1);
  });

  it("reports a malformed options.profiles entry and still matches a valid one", async () => {
    const cloud = fakeCloud();
    const bad = { ...CRM_PROFILE, id: "bad", match: { hosts: ["*.example.com"], paths: ["/**"] } };
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, profiles: [bad, CRM_PROFILE] });
    await handle.registry.ready;
    expect(handle.profileErrors().some((e) => e.startsWith("match.hosts[0]:"))).toBe(true);
    // The valid profile matched and its field-protect pipeline ran (not "No profile matches").
    await expect(fetch("https://crm.example.com/api/contacts", { method: "POST", body: "{}" })).resolves.toBeDefined();
    expect(handle.store.getSnapshot()[0].profileId).toBe("crm-contacts");
    // The malformed one was not applied at all: its wildcard host is not in scope.
    await expect(fetch("https://other.example.com/x", { method: "POST", body: "{}" })).resolves.toBeDefined();
    expect(cloud.sent).toHaveLength(2);
  });
});

describe("host canonicalisation (scope bypass)", () => {
  const RAW = JSON.stringify({ name: "Rohan Mehta", contact: "rohan.mehta@example.com" });

  it.each([
    "https://crm.example.com./api/contacts",
    "https://crm.example.com../api/contacts",
    "https://CRM.Example.COM./api/contacts",
    "https://crm.example.com.:443/api/contacts",
    "https://crm.example.com:443/api/contacts",
    "HTTPS://Crm.Example.Com/api/contacts",
  ])("treats %s as the in-scope host and protects the body", async (url) => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, profiles: [CRM_PROFILE] });
    await fetch(url, { method: "POST", body: RAW });
    expect(cloud.sent).toHaveLength(1);
    expect(cloud.sent[0].body).not.toContain("rohan.mehta@example.com");
    expect(handle.store.getSnapshot()[0].profileId).toBe("crm-contacts");
  });

  it("blocks an unprofiled path on a trailing-dot in-scope host instead of passing it through", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, profiles: [CRM_PROFILE] });
    await expect(fetch("https://crm.example.com./other/path", { method: "POST", body: RAW })).rejects.toThrow(/No profile matches/);
    expect(cloud.sent).toHaveLength(0);
  });

  it("keeps a genuinely different host out of scope", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, profiles: [CRM_PROFILE] });
    for (const url of ["https://crm.example.com.evil.test/api/contacts", "https://xcrm.example.com/api/contacts", "https://example.com/api/contacts"]) {
      await fetch(url, { method: "POST", body: RAW });
    }
    expect(cloud.sent.map((s) => s.body)).toEqual([RAW, RAW, RAW]);
    expect(handle.store.getSnapshot()).toHaveLength(0);
  });

  it("applies the Gemini pipeline to a trailing-dot Gemini host", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl, autoApprove: true, analyzer: pick(["salary"]) });
    await fetch(CLOUD.replace("googleapis.com", "googleapis.com."), { method: "POST", body: body("Which clauses?", SAMPLE_CONTRACT) });
    expect(cloud.sent).toHaveLength(1);
    expect(cloud.sent[0].body).not.toContain("536-90-4399");
    expect(cloud.sent[0].body).not.toContain("sk_live_DEMO");
    expect(handle.store.getSnapshot()[0].status).toBe("done");
  });
});

describe("structure-only authoring seam", () => {
  const PROMPT = "Fields: $.properties.a (string, class: contact)";
  const CONFIG = { temperature: 0, responseMimeType: "application/json" };
  const wire = (over: Record<string, unknown> = {}, prompt = PROMPT) =>
    JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: CONFIG, ...over });

  /** Run a request that must reach the normal gate: wait for it, deny it, and require that nothing was sent. */
  async function viaGate(h: AirlockHandle, p: Promise<unknown>): Promise<void> {
    const settled = p.catch((e: Error) => e);
    await waitFor(() => h.store.getSnapshot().some((v) => v.status === "awaiting-approval" || v.status === "blocked"));
    for (const v of h.store.getSnapshot()) if (v.status === "awaiting-approval") h.store.deny(v.id);
    await settled;
  }

  it("releases exactly one request that equals the registration, with an audit event", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl });
    handle.engine.allowStructureOnly({ prompt: PROMPT, generationConfig: CONFIG, model: "m" });
    await fetch(CLOUD, { method: "POST", body: wire() });
    expect(cloud.sent).toEqual([{ url: CLOUD, body: wire() }]);
    const events = handle.audit.snapshot();
    expect(events.map((e) => e.kind)).toEqual(["internal-authoring"]);
    expect(events[0].detail?.wireHash).toMatch(/^[0-9a-f]{64}$/);
    expect(handle.store.getSnapshot()).toHaveLength(0);
    // A repeat goes to the normal gate.
    await viaGate(handle, fetch(CLOUD, { method: "POST", body: wire() }));
    expect(cloud.sent).toHaveLength(1);
    expect(handle.store.getSnapshot()[0].status).toBe("denied");
  });

  it("does not release a request that differs in path, keys, parts, config, role or text", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl });
    handle.engine.allowStructureOnly({ prompt: PROMPT, generationConfig: CONFIG, model: "m" });
    const variants: Array<[string, string, string]> = [
      ["other path", CLOUD.replace("m:generate", "other:generate"), wire()],
      ["extra key", CLOUD, wire({ systemInstruction: { parts: [{ text: "hi" }] } })],
      ["tools", CLOUD, wire({ tools: [] })],
      ["extra part", CLOUD, JSON.stringify({ contents: [{ role: "user", parts: [{ text: PROMPT }, { text: "x" }] }], generationConfig: CONFIG })],
      ["extra leaf in part", CLOUD, JSON.stringify({ contents: [{ role: "user", parts: [{ text: PROMPT, inlineData: { data: "AA" } }] }], generationConfig: CONFIG })],
      ["different config", CLOUD, wire({ generationConfig: { ...CONFIG, temperature: 1 } })],
      ["model role", CLOUD, JSON.stringify({ contents: [{ role: "model", parts: [{ text: PROMPT }] }], generationConfig: CONFIG })],
      ["different text", CLOUD, wire({}, PROMPT + " ")],
    ];
    for (const [, url, b] of variants) await viaGate(handle, fetch(url, { method: "POST", body: b }));
    expect(cloud.sent).toHaveLength(0);
    expect(handle.audit.snapshot().some((e) => e.kind === "internal-authoring")).toBe(false);
    // The registration is still pending for the request it names.
    await fetch(CLOUD, { method: "POST", body: wire() });
    expect(cloud.sent).toHaveLength(1);
  });

  it("blocks a registered prompt that contains a detectable value", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl });
    const leaky = "Contact rohan.mehta@example.com about the fields";
    handle.engine.allowStructureOnly({ prompt: leaky, generationConfig: CONFIG, model: "m" });
    await expect(fetch(CLOUD, { method: "POST", body: wire({}, leaky) })).rejects.toThrow(/sensitive value/);
    expect(cloud.sent).toHaveLength(0);
    expect(handle.audit.snapshot().map((e) => e.kind)).toEqual(["blocked"]);
  });

  it("expires after its timeout and can be cancelled", async () => {
    const cloud = fakeCloud();
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: cloud.impl });
    handle.engine.allowStructureOnly({ prompt: PROMPT, generationConfig: CONFIG, model: "m", ttlMs: -1 });
    const cancel = handle.engine.allowStructureOnly({ prompt: PROMPT, generationConfig: CONFIG, model: "m" });
    cancel();
    await viaGate(handle, fetch(CLOUD, { method: "POST", body: wire() }));
    expect(cloud.sent).toHaveLength(0);
  });
});
