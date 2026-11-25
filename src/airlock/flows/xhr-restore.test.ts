import { afterEach, describe, expect, it } from "vitest";
import { installAirlock, type AirlockHandle } from "../net/guard.js";
import { installXhrAdapter } from "../net/xhr.js";
import type { Profile } from "../profiles/types.js";

/** Synthetic sample. example.com is a reserved domain. */
const EMAIL = "rohan.mehta@example.com";
const BASE = "https://crm.example.com/api/contacts";

const PROFILE: Profile = {
  version: 1,
  id: "crm-contacts",
  name: "Example CRM contacts",
  kind: "saas",
  pipeline: "field-protect",
  match: { hosts: ["crm.example.com"], paths: ["/api/**"] },
  request: {
    fields: [
      { path: "$.properties.email", category: "contact", flow: { action: "token" } },
      { path: "$.properties.internal_note", category: "free_text", flow: { action: "drop" } },
    ],
  },
  response: { fields: [{ path: "$.results[*].properties.email" }] },
  author: { by: "user", at: "2026-11-23T10:00:00.000Z" },
};

interface NativeSend {
  method: string;
  url: string;
  body: unknown;
}

/** A minimal XMLHttpRequest stand-in with prototype accessors like the real one (test seam, no network). */
class FakeXhr extends EventTarget {
  static sends: NativeSend[] = [];
  /** The fake SaaS: a create is stored as sent, a list answers with what is stored. */
  static stored = "{}";
  #state = 0;
  #status = 0;
  #text = "";
  #type = "";
  #method = "";
  #url = "";
  onload: ((e: Event) => void) | null = null;

  get readyState(): number {
    return this.#state;
  }
  get status(): number {
    return this.#status;
  }
  get statusText(): string {
    return "OK";
  }
  get responseText(): string {
    if (this.#type !== "" && this.#type !== "text") throw new DOMException("InvalidStateError", "InvalidStateError");
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
    let text: string;
    if (this.#method === "POST") {
      FakeXhr.stored = String(body);
      text = JSON.stringify({ id: "1" });
    } else {
      const properties = (JSON.parse(FakeXhr.stored) as { properties?: unknown }).properties ?? {};
      text = JSON.stringify({ results: [{ id: "1", properties }] });
    }
    setTimeout(() => {
      this.#status = 200;
      this.#text = text;
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

let handle: AirlockHandle | undefined;
let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  handle?.uninstall();
  FakeXhr.sends = [];
  FakeXhr.stored = "{}";
});

async function setup(): Promise<void> {
  handle = installAirlock({ profiles: [PROFILE] });
  uninstall = installXhrAdapter(handle.engine, Xhr);
  await handle.engine.ready;
}

async function create(): Promise<void> {
  const x = new Xhr();
  const done = loadend(x);
  x.open("POST", BASE);
  x.setRequestHeader("Content-Type", "application/json");
  x.send(JSON.stringify({ properties: { email: EMAIL, internal_note: "budget signed off" } }));
  await done;
}

describe("field-protect through the XHR adapter", () => {
  it("protects the create body and restores responseText of a later list", async () => {
    await setup();
    await create();
    const wire = String(FakeXhr.sends[0].body);
    expect(wire).not.toContain(EMAIL);
    expect(wire).not.toContain("budget");
    expect(wire).toMatch(/tok_[a-z2-7]{22}/);

    const x = new Xhr();
    const seen: string[] = [];
    (x as unknown as { onreadystatechange: () => void }).onreadystatechange = () => seen.push(x.responseText);
    const done = loadend(x);
    x.open("GET", BASE);
    x.send();
    await done;
    expect(FakeXhr.sends[1].body ?? null).toBeNull(); // a GET has nothing to protect and goes out without a body
    const text = JSON.parse(x.responseText) as { results: Array<{ properties: { email: string } }> };
    expect(text.results[0].properties.email).toBe(EMAIL);
    // The page never saw the unrestored token, not even in an intermediate state.
    expect(seen.every((s) => !s.includes("tok_"))).toBe(true);
    expect(handle?.store.getSnapshot().map((v) => v.status)).toEqual(["done", "done"]);
  });

  it("returns a parsed, restored response for responseType json", async () => {
    await setup();
    await create();
    const x = new Xhr();
    x.responseType = "json";
    const done = loadend(x);
    x.open("GET", BASE);
    x.send();
    await done;
    const parsed = x.response as { results: Array<{ properties: { email: string } }> };
    expect(parsed.results[0].properties.email).toBe(EMAIL);
  });
});
