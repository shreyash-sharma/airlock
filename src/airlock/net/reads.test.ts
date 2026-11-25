import { STRICT_RULES } from "../flows/rules.js";
import { afterEach, describe, expect, it } from "vitest";
import { egressSummary } from "../core/audit.js";
import { isCacheBuster } from "../flows/protect.js";
import { DEFAULT_RULES } from "../flows/rules.js";
import { KEYS, memoryKV } from "../profiles/storage.js";
import type { Profile, RulesData } from "../profiles/types.js";
import { installAirlock, type AirlockHandle } from "./guard.js";
import { installXhrAdapter } from "./xhr.js";

/** Synthetic sample. example.com and .test are reserved. */
const EMAIL = "rohan.mehta@example.com";
const HOST = "crm.test";
const BASE = `https://${HOST}/api/v1/Contact`;
const JSON_HEADERS = { "content-type": "application/json" };

const PROFILE: Profile = {
  version: 1,
  id: "crm-contact",
  name: "CRM contact",
  kind: "saas",
  pipeline: "field-protect",
  match: { hosts: [HOST], paths: ["/api/v1/Contact"], methods: ["POST"], contentTypes: ["application/json"] },
  request: { fields: [{ path: "$.emailAddress", category: "contact", flow: { action: "token" } }] },
  response: { fields: [{ path: "$.list[*]" }, { path: "$" }] },
  author: { by: "on_device", at: "2026-11-24T10:00:00.000Z" },
};

const rules = (allowReads: boolean, hosts: string[] = [HOST]): RulesData => ({
  version: 1,
  destinations: [...STRICT_RULES.destinations.map((d) => ({ ...d, approval: "auto" as const })), { id: "host-rule-1", match: { kind: "saas", hosts }, approval: "auto", defaults: { contact: "token" }, ...(allowReads ? { allowReads: true } : {}) }],
});

/** A fake CRM: a create is stored as sent; a list or a detail answers with it; anything else answers a static metadata object. */
function fakeCrm() {
  const sent: Array<{ method: string; url: string; body: string | null }> = [];
  let stored = "{}";
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : null;
    const method = init?.method ?? "GET";
    sent.push({ method, url, body });
    if (method === "POST" && body) {
      stored = body;
      return new Response(body, { status: 201, headers: JSON_HEADERS });
    }
    if (url.includes("/Metadata")) return new Response(JSON.stringify({ app: { name: "demo" } }), { status: 200, headers: JSON_HEADERS });
    return new Response(JSON.stringify({ total: 1, list: [JSON.parse(stored)] }), { status: 200, headers: JSON_HEADERS });
  }) as typeof fetch;
  return { sent, impl };
}

let handle: AirlockHandle | undefined;
let uninstallXhr: (() => void) | undefined;
afterEach(() => {
  uninstallXhr?.();
  uninstallXhr = undefined;
  handle?.uninstall();
  handle = undefined;
});

function setup(rulesData: RulesData = rules(false), profile: Profile = PROFILE) {
  const crm = fakeCrm();
  handle = installAirlock({ fetchImpl: crm.impl, profiles: [profile], scope: [HOST], rules: rulesData });
  return crm;
}

const createContact = () => fetch(BASE, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ emailAddress: EMAIL }) });

describe("an uncovered read, allow-reads off (the default)", () => {
  it("blocks a GET no profile covers, with no network call", async () => {
    const crm = setup();
    await expect(fetch(`https://${HOST}/api/v1/Metadata`)).rejects.toThrow(/No profile matches GET/);
    expect(crm.sent).toHaveLength(0);
  });

  it("blocks an uncovered GET with a query string and never lets the value out", async () => {
    const crm = setup();
    await expect(fetch(`${BASE}?email=${EMAIL}`)).rejects.toThrow(/No profile matches GET/);
    expect(crm.sent).toHaveLength(0);
    expect(JSON.stringify(handle?.audit.snapshot())).not.toContain(EMAIL);
  });

  it("does not let a write-only profile cover a GET, even on its own path", async () => {
    const crm = setup();
    await expect(fetch(BASE)).rejects.toThrow(/No profile matches GET/);
    expect(crm.sent).toHaveLength(0);
  });
});

describe("an uncovered read, allow-reads on for the host", () => {
  it("releases a GET with no body, audits it, restores the answer at the host's learned locators, and counts it as a request that left", async () => {
    const crm = setup(rules(true));
    await createContact();
    const stored = crm.sent[0].body as string;
    expect(stored).not.toContain(EMAIL);

    const res = await fetch(`https://${HOST}/api/v1/Metadata`);
    expect(await res.json()).toEqual({ app: { name: "demo" } });
    expect(crm.sent[1]).toEqual({ method: "GET", url: `https://${HOST}/api/v1/Metadata`, body: null });

    // A list that no profile path covers still comes back with the real value, through the locators the host's profile carries.
    const list = await fetch(`https://${HOST}/api/v1/GlobalSearch`);
    const body = (await list.json()) as { list: Array<{ emailAddress: string }> };
    expect(body.list[0].emailAddress).toBe(EMAIL);

    const events = handle!.audit.snapshot();
    const released = events.filter((e) => e.kind === "read-released");
    expect(released).toHaveLength(2);
    expect(released[0].detail).toMatchObject({ host: HOST, method: "GET", path: "/api/v1/Metadata", bytes: 0 });
    expect(events.find((e) => e.kind === "read-policy")?.detail).toMatchObject({ state: "on", hosts: HOST });
    expect(egressSummary(events).requests).toBe(3);
    expect(JSON.stringify(events)).not.toContain(EMAIL);
    // Shapes of the answers are kept, values are not.
    expect(handle!.engine.observations.list().length).toBeGreaterThan(0);
    expect(JSON.stringify(handle!.engine.observations.list())).not.toContain(EMAIL);
  });

  it("hands a binary answer back byte for byte instead of reading it as text", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 254, 13, 10]);
    let calls = 0;
    const impl = (async () => {
      calls++;
      return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
    }) as typeof fetch;
    handle = installAirlock({ fetchImpl: impl, profiles: [PROFILE], scope: [HOST], rules: rules(true) });
    const res = await fetch(`https://${HOST}/api/v1/Attachment/view`);
    expect(calls).toBe(1);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("still blocks a read whose URL holds a sensitive value, and sends nothing", async () => {
    const crm = setup(rules(true));
    await expect(fetch(`${BASE}?email=${EMAIL}`)).rejects.toThrow(/Sensitive value in the URL|no-residual-detection/);
    await expect(fetch(`https://${HOST}/api/v1/Contact/${EMAIL}`)).rejects.toThrow();
    await expect(fetch(`https://${HOST}/api/v1/Search?q=9876543210`)).rejects.toThrow();
    expect(crm.sent).toHaveLength(0);
    expect(JSON.stringify(handle?.store.getSnapshot())).not.toContain(EMAIL);
    expect(handle!.audit.snapshot().some((e) => e.kind === "read-released")).toBe(false);
  });

  it("lets a cache-busting timestamp through but still finds a phone number under that key or another", async () => {
    const crm = setup(rules(true));
    await fetch(`https://${HOST}/api/v1/Metadata?t=1795000000000`);
    expect(crm.sent).toHaveLength(1);
    await fetch(`https://${HOST}/api/v1/Metadata?t=1795534565`);
    expect(crm.sent).toHaveLength(2);
    await expect(fetch(`https://${HOST}/api/v1/Metadata?t=9876543210`)).rejects.toThrow();
    await expect(fetch(`https://${HOST}/api/v1/Metadata?phone=1795000000000`)).rejects.toThrow();
    await expect(fetch(`https://${HOST}/api/v1/Metadata?t=1795000000000&email=${EMAIL}`)).rejects.toThrow();
    expect(crm.sent).toHaveLength(2);
    expect(isCacheBuster("t", "1795000000000")).toBe(true);
    expect(isCacheBuster("t", "1795534565")).toBe(true);
    expect(isCacheBuster("T", "1795534565")).toBe(true);
    expect(isCacheBuster("t", "17950000000")).toBe(false);
    expect(isCacheBuster("t", "2125551234")).toBe(false);
    expect(isCacheBuster("phone", "1795534565")).toBe(false);
    expect(isCacheBuster("t", "4915112345678")).toBe(false);
  });

  it("never releases a write or a request with a body", async () => {
    const crm = setup(rules(true));
    await expect(fetch(`https://${HOST}/api/v1/Account`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name: "x" }) })).rejects.toThrow(/No profile matches POST/);
    await expect(fetch(`https://${HOST}/api/v1/Contact/abc`, { method: "PUT", headers: JSON_HEADERS, body: "{}" })).rejects.toThrow(/No profile matches PUT/);
    await expect(fetch(`https://${HOST}/api/v1/Contact/abc`, { method: "DELETE" })).rejects.toThrow(/No profile matches DELETE/);
    expect(crm.sent).toHaveLength(0);
  });

  it("is per host: another configured host stays blocked", async () => {
    const crm = fakeCrm();
    handle = installAirlock({ fetchImpl: crm.impl, profiles: [PROFILE], scope: [HOST, "other.test"], rules: rules(true) });
    await expect(fetch("https://other.test/api/v1/Metadata")).rejects.toThrow(/No profile matches GET/);
    expect(crm.sent).toHaveLength(0);
  });

  it("records a withdrawal in the audit log when the rule is switched off again", async () => {
    const crm = fakeCrm();
    const kv = memoryKV({ [KEYS.rules]: JSON.stringify(rules(true)) });
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: crm.impl, profiles: [PROFILE], scope: [HOST], kv });
    await fetch(`https://${HOST}/api/v1/Metadata`);
    await kv.set(KEYS.rules, JSON.stringify(rules(false)));
    await expect(fetch(`https://${HOST}/api/v1/Metadata`)).rejects.toThrow(/No profile matches GET/);
    const states = handle.audit.snapshot().filter((e) => e.kind === "read-policy").map((e) => e.detail?.state);
    expect(states).toEqual(["on", "off"]);
  });

  it("a whole-kind rule cannot allow reads (it fails validation, so the defaults apply)", async () => {
    const crm = fakeCrm();
    const bad = { version: 1, destinations: [{ id: "x", match: { kind: "saas" }, approval: "auto", defaults: {}, allowReads: true }] };
    const kv = memoryKV({ [KEYS.rules]: JSON.stringify(bad) });
    handle = installAirlock({ rules: STRICT_RULES, fetchImpl: crm.impl, profiles: [PROFILE], scope: [HOST], kv });
    await expect(fetch(`https://${HOST}/api/v1/Metadata`)).rejects.toThrow(/No profile matches GET/);
    expect(crm.sent).toHaveLength(0);
  });
});

describe("a profile that names GET covers reads of its paths", () => {
  const WITH_GET: Profile = { ...PROFILE, match: { ...PROFILE.match, methods: ["POST", "GET"], paths: ["/api/v1/Contact", "/api/v1/Contact/*"] } };

  it("matches a GET with no content type, restores the list, and still scans the URL", async () => {
    const crm = setup(rules(false), WITH_GET);
    await createContact();
    const body = (await (await fetch(BASE)).json()) as { list: Array<{ emailAddress: string }> };
    expect(body.list[0].emailAddress).toBe(EMAIL);
    expect(crm.sent[1].body).toBeNull();
    await expect(fetch(`${BASE}?email=${EMAIL}`)).rejects.toThrow(/Sensitive value in the URL|no-residual-detection/);
    expect(crm.sent).toHaveLength(2);
    // Other paths are not covered: held or blocked, never passed.
    await expect(fetch(`https://${HOST}/api/v1/Metadata`)).rejects.toThrow(/No profile matches GET/);
  });
});

describe("the XHR adapter handles reads like fetch", () => {
  interface Sent {
    method: string;
    url: string;
    body: unknown;
  }
  class FakeXhr extends EventTarget {
    static sends: Sent[] = [];
    static stored = "{}";
    #state = 0;
    #status = 0;
    #text = "";
    #type = "";
    #method = "";
    #url = "";
    get readyState(): number {
      return this.#state;
    }
    get status(): number {
      return this.#status;
    }
    get responseText(): string {
      return this.#state === 4 ? this.#text : "";
    }
    get response(): unknown {
      if (this.#state !== 4) return this.#type === "json" ? null : "";
      return this.#type === "json" ? JSON.parse(this.#text) : this.#text;
    }
    get responseType(): string {
      return this.#type;
    }
    set responseType(v: string) {
      this.#type = v;
    }
    open(method: string, url: string): void {
      this.#method = method;
      this.#url = url;
      this.#state = 1;
    }
    setRequestHeader(): void {}
    send(body?: unknown): void {
      FakeXhr.sends.push({ method: this.#method, url: this.#url, body });
      if (this.#method === "POST") FakeXhr.stored = String(body);
      const text = this.#method === "POST" ? String(body) : JSON.stringify({ total: 1, list: [JSON.parse(FakeXhr.stored)] });
      setTimeout(() => {
        this.#status = 200;
        this.#text = text;
        this.#state = 4;
        for (const type of ["readystatechange", "load", "loadend"]) this.dispatchEvent(new Event(type));
      }, 0);
    }
  }
  const Xhr = FakeXhr as unknown as typeof XMLHttpRequest;
  const loadend = (x: EventTarget) => new Promise<void>((resolve) => x.addEventListener("loadend", () => resolve()));
  const failed = (x: EventTarget) => new Promise<string>((resolve) => ["error", "abort"].forEach((t) => x.addEventListener(t, () => resolve(t))));
  afterEach(() => {
    FakeXhr.sends = [];
    FakeXhr.stored = "{}";
  });

  async function xhrSetup(allow: boolean): Promise<void> {
    handle = installAirlock({ fetchImpl: fakeCrm().impl, profiles: [PROFILE], scope: [HOST], rules: rules(allow) });
    uninstallXhr = installXhrAdapter(handle.engine, Xhr);
    await handle.engine.ready;
  }

  async function xhrCreate(): Promise<void> {
    const x = new Xhr();
    const done = loadend(x);
    x.open("POST", BASE);
    x.setRequestHeader("Content-Type", "application/json");
    x.send(JSON.stringify({ emailAddress: EMAIL }));
    await done;
  }

  it("releases a body-less GET and restores responseText when allowed", async () => {
    await xhrSetup(true);
    await xhrCreate();
    expect(String(FakeXhr.sends[0].body)).not.toContain(EMAIL);
    const x = new Xhr();
    const done = loadend(x);
    x.open("GET", `https://${HOST}/api/v1/GlobalSearch`);
    x.send();
    await done;
    expect(FakeXhr.sends[1].body ?? null).toBeNull();
    expect((JSON.parse(x.responseText) as { list: Array<{ emailAddress: string }> }).list[0].emailAddress).toBe(EMAIL);
    expect(handle!.audit.snapshot().filter((e) => e.kind === "read-released")).toHaveLength(1);
  });

  it("blocks the same GET when allow-reads is off, a GET with the email in the query, and an unprofiled write", async () => {
    await xhrSetup(false);
    for (const [method, url, body] of [
      ["GET", `https://${HOST}/api/v1/GlobalSearch`, undefined],
      ["GET", `${BASE}?email=${EMAIL}`, undefined],
      ["PUT", `https://${HOST}/api/v1/Contact/abc`, "{}"],
    ] as const) {
      const x = new Xhr();
      const f = failed(x);
      x.open(method, url);
      x.send(body);
      expect(await f).toBe("error");
    }
    expect(FakeXhr.sends).toHaveLength(0);
  });

  it("with allow-reads on still blocks a sensitive URL and a write", async () => {
    await xhrSetup(true);
    for (const [method, url, body] of [
      ["GET", `${BASE}?email=${EMAIL}`, undefined],
      ["PUT", `https://${HOST}/api/v1/Contact/abc`, "{}"],
      ["DELETE", `https://${HOST}/api/v1/Contact/abc`, undefined],
    ] as const) {
      const x = new Xhr();
      const f = failed(x);
      x.open(method, url);
      x.send(body);
      expect(await f).toBe("error");
    }
    expect(FakeXhr.sends).toHaveLength(0);
  });
});
