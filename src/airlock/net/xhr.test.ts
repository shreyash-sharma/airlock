import { STRICT_RULES } from "../flows/rules.js";
import { afterEach, describe, expect, it } from "vitest";
import { SAMPLE_CONTRACT } from "../../host/sample-contract.js";
import type { Analyzer, Clause, Selection } from "../core/types.js";
import { installAirlock, type AirlockHandle } from "./guard.js";
import { installXhrAdapter } from "./xhr.js";

const CLOUD = "https://firebasevertexai.googleapis.com/v1beta/projects/p/models/m:generateContent";

const pick = (heads: string[]): Analyzer => ({
  async select(_task: string, clauses: Clause[]): Promise<Selection> {
    const ids = clauses.filter((c) => heads.some((h) => c.heading.toLowerCase().includes(h))).map((c) => c.id);
    return { ids, reasons: Object.fromEntries(ids.map((i) => [i, "needed"])), source: "on_device", latencyMs: 5, calls: 1 };
  },
});

interface NativeSend {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** A minimal XMLHttpRequest stand-in with prototype accessors like the real one (test seam, no network). */
class FakeXhr extends EventTarget {
  static sends: NativeSend[] = [];
  /** What the fake "server" answers: echoes the first placeholder it finds in the request body. */
  static respond = (req: NativeSend): { status: number; text: string } => {
    const token = /\[[A-Z_]+_\d+\]/.exec(String(req.body))?.[0] ?? "none";
    return { status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: `See ${token}` }] } }] }) };
  };
  #state = 0;
  #status = 0;
  #text = "";
  #type = "";
  #method = "";
  #url = "";
  #headers: Record<string, string> = {};
  onload: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onreadystatechange: ((e: Event) => void) | null = null;

  get readyState(): number {
    return this.#state;
  }
  get status(): number {
    return this.#status;
  }
  get statusText(): string {
    return this.#status === 200 ? "OK" : "";
  }
  get responseText(): string {
    if (this.#type !== "" && this.#type !== "text") throw new DOMException("InvalidStateError", "InvalidStateError");
    return this.#state === 4 ? this.#text : "";
  }
  get response(): unknown {
    if (this.#state !== 4) return this.#type === "json" ? null : "";
    if (this.#type === "json") return JSON.parse(this.#text);
    return this.#text;
  }
  get responseType(): string {
    return this.#type;
  }
  set responseType(v: string) {
    if (this.#state >= 3) throw new DOMException("InvalidStateError", "InvalidStateError");
    this.#type = v;
  }

  open(method: string, url: string, async = true): void {
    void async;
    this.#method = method;
    this.#url = url;
    this.#headers = {};
    this.#state = 1;
  }
  setRequestHeader(name: string, value: string): void {
    this.#headers[name.toLowerCase()] = value;
  }
  send(body?: unknown): void {
    if (this.#state !== 1) throw new DOMException("InvalidStateError", "InvalidStateError");
    const req = { method: this.#method, url: this.#url, body, headers: { ...this.#headers } };
    FakeXhr.sends.push(req);
    const answer = FakeXhr.respond(req);
    setTimeout(() => {
      this.#status = answer.status;
      this.#text = answer.text;
      this.#state = 4;
      for (const type of ["readystatechange", "load", "loadend"]) this.dispatchEvent(new Event(type));
    }, 0);
  }
  dispatchEvent(event: Event): boolean {
    const result = super.dispatchEvent(event);
    (this as unknown as Record<string, ((e: Event) => void) | null>)[`on${event.type}`]?.call(this, event);
    return result;
  }
}

const Xhr = FakeXhr as unknown as typeof XMLHttpRequest;
const loadend = (x: EventTarget) => new Promise<void>((resolve) => x.addEventListener("loadend", () => resolve()));
const body = (task: string, doc: string) => JSON.stringify({ contents: [{ role: "user", parts: [{ text: task }, { text: doc }] }] });

let handle: AirlockHandle | undefined;
let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  handle?.uninstall();
  FakeXhr.sends = [];
});

async function setup(options: Parameters<typeof installAirlock>[0] = {}): Promise<AirlockHandle> {
  handle = installAirlock({ rules: STRICT_RULES, analyzer: pick(["salary", "equipment"]), autoApprove: true, ...options });
  uninstall = installXhrAdapter(handle.engine, Xhr);
  await handle.engine.ready;
  return handle;
}

describe("xhr adapter", () => {
  it("leaves out-of-scope requests untouched", async () => {
    const h = await setup();
    const x = new Xhr();
    const done = loadend(x);
    x.open("POST", "https://example.com/data");
    x.setRequestHeader("Content-Type", "text/plain");
    x.send("plain");
    await done;
    expect(FakeXhr.sends).toEqual([{ method: "POST", url: "https://example.com/data", body: "plain", headers: { "content-type": "text/plain" } }]);
    expect(h.store.getSnapshot()).toHaveLength(0);
  });

  it("replaces an in-scope Gemini body and restores responseText", async () => {
    const h = await setup();
    const x = new Xhr();
    const seen: string[] = [];
    x.onreadystatechange = () => seen.push(x.responseText);
    const done = loadend(x);
    x.open("POST", CLOUD);
    x.setRequestHeader("Content-Type", "application/json");
    x.send(body("Which clauses should I negotiate?", SAMPLE_CONTRACT));
    await done;
    expect(FakeXhr.sends).toHaveLength(1);
    const wire = String(FakeXhr.sends[0].body);
    for (const secret of ["GB82 WEST", "sk_live_DEMO", "536-90-4399"]) expect(wire).not.toContain(secret);
    expect(wire).toMatch(/\[[A-Z_]+_\d+\]/);
    const answer = (JSON.parse(x.responseText) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> }).candidates[0].content.parts[0].text;
    expect(answer).not.toMatch(/\[[A-Z_]+_\d+\]/); // restored for the page
    expect(h.store.getSnapshot()[0].status).toBe("done");
    expect(h.store.getSnapshot()[0].cloudView).toMatch(/\[[A-Z_]+_\d+\]/); // what the cloud saw
    // The page never saw the unrestored answer, not even in an intermediate state.
    expect(seen.every((s) => !/\[[A-Z_]+_\d+\]/.test(s))).toBe(true);
  });

  it("returns a parsed, restored response for responseType json", async () => {
    await setup();
    const x = new Xhr();
    x.responseType = "json";
    const done = loadend(x);
    x.open("POST", CLOUD);
    x.send(body("Which clauses should I negotiate?", SAMPLE_CONTRACT));
    await done;
    const parsed = x.response as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    expect(parsed.candidates[0].content.parts[0].text).not.toMatch(/\[[A-Z_]+_\d+\]/);
  });

  it("blocks synchronous XHR with a NetworkError and no native send", async () => {
    const h = await setup();
    const x = new Xhr();
    x.open("POST", CLOUD, false);
    expect(() => x.send(body("t", SAMPLE_CONTRACT))).toThrow(expect.objectContaining({ name: "NetworkError" }));
    expect(FakeXhr.sends).toHaveLength(0);
    expect(h.store.getSnapshot()[0].status).toBe("blocked");
    expect(h.store.getSnapshot()[0].message).toContain("Synchronous");
  });

  it("gives an error event, never a native send, for FormData, blob responseType and an unmatched host", async () => {
    const h = await setup({ scope: ["crm.example.com"] });
    const attempts: Array<[string, (x: XMLHttpRequest) => void]> = [
      ["FormData", (x) => (x.open("POST", CLOUD), x.send(new FormData()))],
      ["blob", (x) => ((x.responseType = "blob"), x.open("POST", CLOUD), x.send(body("t", SAMPLE_CONTRACT)))],
      ["No profile matches", (x) => (x.open("POST", "https://crm.example.com/api/contacts"), x.send("{}"))],
    ];
    for (const [expected, go] of attempts) {
      const x = new Xhr();
      const events: string[] = [];
      for (const type of ["readystatechange", "error", "loadend"]) x.addEventListener(type, () => events.push(type));
      go(x);
      await new Promise((r) => setTimeout(r, 5));
      expect(events, expected).toEqual(["readystatechange", "error", "loadend"]);
      expect(x.readyState).toBe(4);
      expect(x.status).toBe(0);
      expect(h.store.getSnapshot().at(-1)?.message ?? "").toContain(expected);
    }
    expect(FakeXhr.sends).toHaveLength(0);
  });

  it("treats a trailing-dot or upper-case spelling of an in-scope host as in scope", async () => {
    const h = await setup({ scope: ["crm.example.com"] });
    for (const url of ["https://crm.example.com./api/contacts", "https://CRM.example.com../api/contacts", "https://crm.example.com.:443/api/contacts"]) {
      const x = new Xhr();
      x.open("POST", url);
      x.send(JSON.stringify({ email: "rohan.mehta@example.com" }));
      await new Promise((r) => setTimeout(r, 5));
      expect(x.readyState).toBe(4);
      expect(x.status).toBe(0);
    }
    expect(FakeXhr.sends).toHaveLength(0);
    expect(h.store.getSnapshot().every((v) => v.status === "blocked")).toBe(true);
  });

  it("reports an error event when the user denies, and uninstall restores the prototype", async () => {
    const h = await setup({ autoApprove: false });
    const x = new Xhr();
    const done = loadend(x);
    let errored = false;
    x.onerror = () => {
      errored = true;
    };
    x.open("POST", CLOUD);
    x.send(body("Which clauses should I negotiate?", SAMPLE_CONTRACT));
    for (let i = 0; i < 200 && h.store.getSnapshot()[0]?.status !== "awaiting-approval"; i++) await new Promise((r) => setTimeout(r, 5));
    h.store.deny(h.store.getSnapshot()[0].id);
    await done;
    expect(errored).toBe(true);
    expect(FakeXhr.sends).toHaveLength(0);

    const patched = FakeXhr.prototype.send;
    uninstall?.();
    uninstall = undefined;
    expect(FakeXhr.prototype.send).not.toBe(patched);
    const y = new Xhr();
    const finished = loadend(y);
    y.open("POST", CLOUD);
    y.send("raw");
    await finished;
    expect(FakeXhr.sends).toHaveLength(1);
  });
});
