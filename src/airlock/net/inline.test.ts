import { afterEach, describe, expect, it } from "vitest";
import type { Profile } from "../profiles/types.js";
import { installAirlock, type AirlockHandle } from "./guard.js";

/** Synthetic sample. example.com and .test are reserved. */
const EMAIL = "rohan.mehta@example.com";
const PHONE = "+44 7700 900123";
const HOST = "crm.test";
const JSON_HEADERS = { "content-type": "application/json" };

const PROFILE: Profile = {
  version: 1,
  id: "crm-contact",
  name: "CRM contact",
  kind: "saas",
  pipeline: "field-protect",
  match: { hosts: [HOST], paths: ["/api/v1/Contact"], methods: ["POST"], contentTypes: ["application/json"] },
  request: { fields: [{ path: "$.emailAddress", category: "contact", flow: { action: "token" } }] },
  response: { fields: [{ path: "$" }] },
  author: { by: "on_device", at: "2026-11-24T10:00:00.000Z" },
};

function fakeCrm() {
  const sent: Array<{ method: string; url: string; body: string | null }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : null;
    sent.push({ method: init?.method ?? "GET", url: String(input), body });
    return new Response(body ?? JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
  }) as typeof fetch;
  return { sent, impl };
}

let handle: AirlockHandle | undefined;
afterEach(() => {
  handle?.uninstall();
  handle = undefined;
});

const wire = (sent: Array<{ url: string; body: string | null }>): string => sent.map((s) => `${s.url} ${s.body ?? ""}`).join("\n");

describe("inline mode for a CRM destination: nothing waits, nothing is blocked", () => {
  it("masks an unprofiled write and sends it at once, then restores the answer", async () => {
    const crm = fakeCrm();
    handle = installAirlock({ fetchImpl: crm.impl, scope: [HOST] });
    const res = await fetch(`https://${HOST}/api/v1/Whatever`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ note: `call ${EMAIL} or ${PHONE}` }) });
    expect(crm.sent).toHaveLength(1);
    expect(wire(crm.sent)).not.toContain(EMAIL);
    expect(wire(crm.sent)).not.toContain("7700 900123");
    // an email and a phone become same-shape stand-ins (a CRM would reject a bare token there)
    expect(wire(crm.sent)).toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+/);
    // the CRM echoed the tokens; the page sees the real values again
    expect(await res.text()).toContain(EMAIL);
    const view = handle.store.getSnapshot().at(-1)!;
    expect(view.reviewReasons?.join(" ")).toMatch(/No profile covered/);
    expect(view.status).toBe("done");
  });

  it("tokenizes a value in the URL of an uncovered GET and still sends it", async () => {
    const crm = fakeCrm();
    handle = installAirlock({ fetchImpl: crm.impl, scope: [HOST] });
    await fetch(`https://${HOST}/api/v1/Contact?email=${encodeURIComponent(EMAIL)}&t=1795534565000`);
    expect(crm.sent).toHaveLength(1);
    expect(crm.sent[0].url).not.toContain("rohan");
    expect(crm.sent[0].url).not.toContain("example.com");
    expect(decodeURIComponent(crm.sent[0].url)).toMatch(/email=[^&]+@[^&]+/);
    expect(crm.sent[0].url).toContain("t=1795534565000"); // a cache-buster stays
  });

  it("sends a body it cannot inspect as it is and flags it for review", async () => {
    const crm = fakeCrm();
    handle = installAirlock({ fetchImpl: crm.impl, scope: [HOST] });
    const form = new FormData();
    form.append("a", "b");
    await fetch(`https://${HOST}/upload`, { method: "POST", body: form });
    expect(crm.sent).toHaveLength(1);
    expect(handle.store.getSnapshot().at(-1)!.reviewReasons?.join(" ")).toMatch(/cannot be inspected/);
  });

  it("falls back to masking instead of blocking when the covering profile's result still holds a value", async () => {
    const crm = fakeCrm();
    handle = installAirlock({ fetchImpl: crm.impl, profiles: [PROFILE], scope: [HOST] });
    // The email is declared (tokenized by the profile); the phone sits in an undeclared field, which strict mode blocks.
    await fetch(`https://${HOST}/api/v1/Contact`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ emailAddress: EMAIL, extra: `phone ${PHONE}` }) });
    expect(crm.sent).toHaveLength(1);
    expect(wire(crm.sent)).not.toContain(EMAIL);
    expect(wire(crm.sent)).not.toContain("7700 900123");
  });

  it("never waits for approval on a CRM request", async () => {
    const crm = fakeCrm();
    handle = installAirlock({ fetchImpl: crm.impl, profiles: [PROFILE], scope: [HOST], autoApprove: false });
    await fetch(`https://${HOST}/api/v1/Contact`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ emailAddress: EMAIL }) });
    expect(crm.sent).toHaveLength(1);
    expect(handle.store.getSnapshot().some((r) => r.status === "awaiting-approval")).toBe(false);
  });
});

describe("the AI destination is unchanged by inline mode", () => {
  it("still blocks an unprofiled request to an AI host and sends nothing", async () => {
    const ai = fakeCrm();
    handle = installAirlock({ fetchImpl: ai.impl, hosts: ["ai.test"], scope: ["ai.test"] });
    await expect(fetch("https://ai.test/v1/other", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ x: EMAIL }) })).rejects.toThrow();
    expect(ai.sent).toHaveLength(0);
  });
});
