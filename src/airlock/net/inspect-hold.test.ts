import { STRICT_RULES } from "../flows/rules.js";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalModelLike } from "../ai/local.js";
import { egressSummary } from "../core/audit.js";
import { installAirlock } from "../index.js";
import { memoryKV } from "../profiles/storage.js";
import { installAirlock as installGuard, type AirlockHandle } from "./guard.js";
import type { HoldDecision, InspectionPort } from "./engine.js";

const HOST = "127.0.0.1:5173";
const CRM = `http://${HOST}/mock-crm/api/contacts`;
const GEMINI_HOST = "firebasevertexai.googleapis.com";
const EMAIL = "rohan.mehta@example.com";
const SAMPLE = { properties: { firstname: "Rohan", lastname: "Mehta", email: EMAIL, phone: "9876543210", city: "Pune", plan: "Enterprise", salary: "68000", internal_note: "Renewal is at risk" } };
const VALUES = ["Rohan", "Mehta", EMAIL, "9876543210", "68000", "Renewal is at risk"];

const field = (name: string, category: string, action: string) => ({ path: `$.properties.${name}`, category, flow: { action } });
const CRM_PROFILE = {
  name: "Mock CRM create contact",
  kind: "saas",
  match: { hosts: ["HOST"], paths: ["/mock-crm/api/contacts"], methods: ["POST"] },
  request: {
    fields: [
      field("firstname", "identifier", "surrogate"),
      field("lastname", "identifier", "surrogate"),
      field("email", "contact", "token"),
      field("phone", "contact", "token"),
      field("salary", "financial", "token"),
      field("internal_note", "free_text", "drop"),
      field("city", "non_sensitive", "allow"),
      field("plan", "non_sensitive", "allow"),
    ],
  },
  response: { fields: [] },
};

const flush = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(cond: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

/** A fake network that records every call that reaches it and answers with `answer`. */
function fakeNetwork(answer: (url: string, body: string) => unknown = () => ({ ok: true })) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, method: String(init?.method ?? "GET"), body });
    return new Response(JSON.stringify(answer(url, body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, impl };
}

const realFetch = globalThis.fetch;
let handle: Pick<AirlockHandle, "uninstall"> | undefined;
afterEach(() => {
  handle?.uninstall();
  handle = undefined;
  globalThis.fetch = realFetch;
});

/** A port the test controls: the decision is resolved by hand. */
function controlledPort() {
  let resolve!: (d: HoldDecision) => void;
  const decision = new Promise<HoldDecision>((r) => (resolve = r));
  const attached: unknown[] = [];
  const captured: unknown[] = [];
  const port: InspectionPort = {
    hosts: [HOST],
    capture: (req) => {
      captured.push(req);
      return { id: "held-1", decision };
    },
    attachResponse: (_id, body) => void attached.push(body),
    get: () => ({ leaves: [1, 2, 3] }),
  };
  return { port, decide: resolve, attached, captured };
}

describe("the inspection hold", () => {
  it("holds an unprofiled request: zero network calls until a decision, and discard throws with zero calls", async () => {
    const net = fakeNetwork();
    const h = installGuard({ rules: STRICT_RULES, fetchImpl: net.impl, scope: [HOST] });
    handle = h;
    const { port, decide, captured } = controlledPort();
    h.engine.setInspection(port);

    const pending = fetch(CRM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(SAMPLE) });
    const outcome = expect(pending).rejects.toThrow(/Inspection discarded/);
    await waitFor(() => h.store.getSnapshot().length === 1, "the held view");
    await flush();

    expect(net.calls).toHaveLength(0);
    expect(h.store.getSnapshot()[0].status).toBe("inspecting");
    expect(h.store.getSnapshot()[0].message).toBe("Held for inspection. Nothing was sent.");
    expect(h.audit.snapshot().find((e) => e.kind === "inspection-held")?.detail).toMatchObject({ host: HOST, method: "POST", leaves: 3 });
    expect(captured).toHaveLength(1);
    // The captured body is the parsed request, held in memory for the Inspect tab.
    expect((captured[0] as { request: unknown }).request).toEqual(SAMPLE);

    decide("discarded");
    await outcome;
    expect(net.calls).toHaveLength(0);
  });

  it("passThrough sends exactly the original body once, returns the answer unchanged, and audits an unprotected send", async () => {
    const net = fakeNetwork(() => ({ id: "7", properties: SAMPLE.properties }));
    const h = installGuard({ rules: STRICT_RULES, fetchImpl: net.impl, scope: [HOST] });
    handle = h;
    const { port, decide, attached } = controlledPort();
    h.engine.setInspection(port);

    const original = JSON.stringify(SAMPLE);
    const pending = fetch(CRM, { method: "POST", headers: { "content-type": "application/json" }, body: original });
    await waitFor(() => h.store.getSnapshot().length === 1, "the held view");
    expect(net.calls).toHaveLength(0);

    decide("pass-through");
    const res = await pending;
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].body).toBe(original);
    expect(((await res.json()) as { properties: { firstname: string } }).properties.firstname).toBe("Rohan");
    expect(attached).toHaveLength(1);

    const kinds = h.audit.snapshot().map((e) => e.kind);
    expect(kinds).toContain("unprotected-send");
    const send = h.audit.snapshot().find((e) => e.kind === "unprotected-send");
    expect(send?.detail).toMatchObject({ host: HOST, approvedOnce: true });
    expect(Number(send?.detail?.bytes)).toBe(original.length);
    // The unprotected send is part of "what left this device", never hidden from the total.
    expect(egressSummary(h.audit.snapshot()).requests).toBe(1);
    expect(JSON.stringify(h.audit.snapshot())).not.toContain(EMAIL);
    expect(h.store.getSnapshot()[0].status).toBe("done");
  });

  it("does not hold a host that has inspection off, and a non-JSON body to an inspected host: both are refused with a reason", async () => {
    const net = fakeNetwork();
    const h = installGuard({ rules: STRICT_RULES, fetchImpl: net.impl, scope: [HOST, "other.example"] });
    handle = h;
    const { port } = controlledPort();
    h.engine.setInspection(port);

    await expect(fetch("http://other.example/api", { method: "POST", body: "{}" })).rejects.toThrow(/No profile matches/);
    await expect(fetch(CRM, { method: "POST", body: "not json at all" })).rejects.toThrow(/not JSON/);
    expect(net.calls).toHaveLength(0);
    expect(h.store.getSnapshot().every((v) => v.status === "blocked")).toBe(true);
  });
});

/** Both models are fakes; the engine, registry, dry run and flows are the real ones. */
function wired(opts: { authoringReply: unknown; host?: string; scopeHosts?: string[]; authoringFetch?: (prompt: string) => Promise<string>; answer?: (url: string, body: string) => unknown }) {
  const net = fakeNetwork(opts.answer);
  globalThis.fetch = net.impl;
  const host = opts.host ?? HOST;
  const prompts: string[] = [];
  const classifier: LocalModelLike = {
    async generateContent() {
      return { response: { text: () => JSON.stringify({ fields: [] }), inferenceSource: "on_device" } };
    },
    async initializeDeviceModel() {},
  };
  const kv = memoryKV();
  const installed = installAirlock({ rules: STRICT_RULES,
    kv,
    scope: [host],
    inspectHosts: [host],
    classifierModel: () => classifier,
    authoringModel: () => ({
      name: "gemini-test",
      generationConfig: { responseMimeType: "application/json" },
      model: {
        async generateContent(prompt: string) {
          prompts.push(prompt);
          if (opts.authoringFetch) await opts.authoringFetch(prompt);
          return { response: { text: () => JSON.stringify(opts.authoringReply), inferenceSource: opts.authoringFetch ? "in_cloud" : "on_device" } };
        },
      },
    }),
  });
  handle = installed;
  return { net, installed, kv, prompts };
}

describe("authoring and approval through the engine", () => {
  it("author (fake model) plus the real dry run plus approve: saved, the held request is blocked, the next identical request is protected", async () => {
    const { net, installed } = wired({ authoringReply: CRM_PROFILE });
    const store = installed.inspection!;
    const first = fetch(CRM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(SAMPLE) });
    const firstOutcome = expect(first).rejects.toThrow(/Profile saved\. Send the request again to use it\./);
    await waitFor(() => store.getSnapshot().length === 1, "the held request");
    const id = store.getSnapshot()[0].id;

    await store.author(id);
    expect(store.get(id)?.status).toBe("ready");
    expect(store.get(id)?.dryRun?.ok).toBe(true);
    expect(net.calls).toHaveLength(0);
    expect((await store.approve(id)).ok).toBe(true);
    await firstOutcome;
    expect(net.calls).toHaveLength(0);
    expect(installed.audit.snapshot().find((e) => e.kind === "profile-saved")?.detail).toMatchObject({ author: "on_device", fields: 8 });
    expect(installed.audit.snapshot().some((e) => e.kind === "local-analysis" && e.detail?.step === "author-profile" && e.where === "on_device")).toBe(true);

    // The same request again now goes through field-protect.
    const second = await fetch(CRM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(SAMPLE) });
    expect(second.status).toBe(200);
    expect(net.calls).toHaveLength(1);
    const sent = JSON.parse(net.calls[0].body) as { properties: Record<string, string> };
    for (const v of VALUES) expect(net.calls[0].body).not.toContain(v);
    expect(sent.properties.email.startsWith("tok_")).toBe(true);
    expect(sent.properties.city).toBe("Pune");
    expect("internal_note" in sent.properties).toBe(false);
    expect(installed.store.getSnapshot().some((v) => v.profileId?.startsWith("authored-") && v.status === "done")).toBe(true);
  });

  it("an authoring model that falls back to cloud reaches the Gemini host only with the value-free prompt, without an approval", async () => {
    const authoringBody = (prompt: string) => JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json" } });
    const { net, installed } = wired({
      authoringReply: CRM_PROFILE,
      authoringFetch: async (prompt) => {
        // What the SDK does when PREFER_ON_DEVICE falls back: one generateContent POST through the (guarded) fetch.
        await fetch(`https://${GEMINI_HOST}/v1beta/projects/p/models/gemini-test:generateContent`, { method: "POST", body: authoringBody(prompt) });
        return "";
      },
    });
    const store = installed.inspection!;
    const first = fetch(CRM, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(SAMPLE) });
    void first.catch(() => undefined);
    await waitFor(() => store.getSnapshot().length === 1, "the held request");
    const id = store.getSnapshot()[0].id;

    await store.author(id);
    expect(store.get(id)?.status).toBe("ready");
    expect(store.get(id)?.authored?.source).toBe("in_cloud");
    const cloud = net.calls.filter((c) => c.url.includes(GEMINI_HOST));
    expect(cloud).toHaveLength(1);
    for (const v of VALUES) expect(cloud[0].body).not.toContain(v);
    // Released by allowStructureOnly: audited as internal authoring, and no approval was ever asked.
    expect(installed.audit.snapshot().some((e) => e.kind === "internal-authoring")).toBe(true);
    expect(installed.store.getSnapshot().some((v) => v.status === "awaiting-approval")).toBe(false);
    expect(net.calls.filter((c) => c.url.includes("mock-crm"))).toHaveLength(0);
    store.discard(id);
  });

  it("a Gemini request that is not the registered authoring prompt is not released: it is held for approval and audited as nothing internal", async () => {
    const { net, installed } = wired({ authoringReply: CRM_PROFILE });
    const other = fetch(`https://${GEMINI_HOST}/v1beta/projects/p/models/gemini-test:generateContent`, {
      method: "POST",
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Summarize the contract" }, { text: "Some document text." }] }] }),
    });
    const settled = expect(other).rejects.toThrow(/denied/);
    await waitFor(() => installed.store.getSnapshot().some((v) => v.status === "awaiting-approval"), "the approval prompt");
    expect(net.calls).toHaveLength(0);
    expect(installed.audit.snapshot().some((e) => e.kind === "internal-authoring")).toBe(false);
    installed.store.deny(installed.store.getSnapshot().find((v) => v.status === "awaiting-approval")!.id);
    await settled;
    expect(net.calls).toHaveLength(0);
  });

  it("an OpenAI-style chat authored by the fake model, approved, then masks the content and restores the answer", async () => {
    const reply = {
      name: "OpenAI chat completions",
      kind: "ai",
      match: { hosts: ["HOST"], paths: ["/v1/chat/completions"], methods: ["POST"] },
      request: { fields: [{ path: "$.messages[*].content", category: "free_text", flow: { action: "mask" } }] },
      response: { fields: [{ path: "$.choices[*].message.content" }] },
    };
    const { net, installed } = wired({
      authoringReply: reply,
      host: "api.openai.com",
      answer: (_url, body) => {
        const placeholder = /\[[A-Z_]+_\d+\]/.exec(body)?.[0] ?? "none";
        return { id: "chatcmpl-fixture", choices: [{ index: 0, message: { role: "assistant", content: `Draft reply to ${placeholder}` } }] };
      },
    });
    const url = "https://api.openai.com/v1/chat/completions";
    const body = JSON.stringify({ model: "gpt-fixture", messages: [{ role: "user", content: `Draft a reply to ${EMAIL} about the renewal` }] });
    const store = installed.inspection!;

    const first = fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    const firstOutcome = expect(first).rejects.toThrow(/Profile saved/);
    await waitFor(() => store.getSnapshot().length === 1, "the held chat request");
    const id = store.getSnapshot()[0].id;
    await store.author(id);
    expect(store.get(id)?.status).toBe("ready");
    expect((await store.approve(id)).ok).toBe(true);
    await firstOutcome;
    expect(net.calls).toHaveLength(0);

    // An ai destination asks first: approve it like the user would.
    const second = fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    await waitFor(() => installed.store.getSnapshot().some((v) => v.status === "awaiting-approval"), "the approval prompt");
    installed.store.approve(installed.store.getSnapshot().find((v) => v.status === "awaiting-approval")!.id);
    const res = await second;
    const answer = (await res.json()) as { choices: Array<{ message: { content: string } }> };

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].body).not.toContain(EMAIL);
    expect(net.calls[0].body).toMatch(/\[EMAIL_\d+\]/);
    expect(answer.choices[0].message.content).toBe(`Draft reply to ${EMAIL}`);
  });
});
