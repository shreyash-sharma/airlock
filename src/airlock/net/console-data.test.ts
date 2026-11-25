import { afterEach, describe, expect, it } from "vitest";
import { installAirlock, type AirlockHandle } from "./guard.js";
import { ORIGINAL_BODY_RETENTION, type RequestView } from "./store.js";
import { KEYS, memoryKV, type KVStore } from "../profiles/storage.js";
import type { Profile } from "../profiles/types.js";

/** The synthetic Rohan Mehta record from src/crm-test/main.tsx. Every value is made up; example.com is reserved. */
const SAMPLE = {
  properties: {
    firstname: "Rohan",
    lastname: "Mehta",
    email: "rohan.mehta@example.com",
    phone: "9876543210",
    city: "Pune",
    plan: "Enterprise",
    salary: "68000",
    internal_note: "Renewal is at risk; the buyer wants a discount before signing.",
  },
};
const SYNTHETIC_VALUES = ["Rohan", "Mehta", "9876543210", "rohan.mehta@example.com", "68000", "Renewal is at risk"];

const field = (name: string, category: string, action: string) => ({ path: `$.properties.${name}`, category, flow: { action } });
const SAAS: Profile = {
  version: 1,
  id: "crm-contacts",
  name: "Example CRM contacts",
  kind: "saas",
  pipeline: "field-protect",
  match: { hosts: ["crm.example.com"], paths: ["/api/**"] },
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
  } as Profile["request"],
  response: { fields: [] },
  author: { by: "user", at: "2026-11-23T10:00:00.000Z" },
};

const CREATE_URL = "https://crm.example.com/api/contacts";
const JSON_HEADERS = { "content-type": "application/json" };

/** A fake SaaS that stores the last body and answers 201 with it. */
function fakeSaas() {
  const sent: Array<{ method: string; body: string | null }> = [];
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : null;
    sent.push({ method: init?.method ?? "GET", body });
    return new Response(body ?? "{}", { status: 201, headers: JSON_HEADERS });
  }) as typeof fetch;
  return { sent, impl };
}

/** A KVStore over memoryKV that records every write. */
function recordingKV(): KVStore & { writes: Array<{ key: string; value: string }> } {
  const inner = memoryKV();
  const writes: Array<{ key: string; value: string }> = [];
  return {
    writes,
    get: (key) => inner.get(key),
    set: async (key, value) => {
      writes.push({ key, value });
      await inner.set(key, value);
    },
  };
}

let handle: AirlockHandle | undefined;
afterEach(() => handle?.uninstall());

function setup(profile: Profile = SAAS) {
  const saas = fakeSaas();
  const kv = recordingKV();
  handle = installAirlock({ fetchImpl: saas.impl, profiles: [profile], kv });
  return { saas, kv, handle: handle as AirlockHandle };
}

const post = (body: string) => ({ method: "POST", headers: JSON_HEADERS, body });

describe("console data for a field-protect request", () => {
  it("records method, path, destination, approval, timing and the exact body the page wrote", async () => {
    const { saas, handle: h } = setup();
    const sentBody = JSON.stringify(SAMPLE);
    await fetch(CREATE_URL, post(sentBody));
    const view = h.store.getSnapshot()[0];
    expect(view.method).toBe("POST");
    expect(view.path).toBe("/api/contacts");
    expect(view.destinationId).toBe("saas-default");
    expect(view.approvedBy).toBe("auto");
    expect(view.startedAt).toBeTypeOf("number");
    expect(view.endedAt).toBeTypeOf("number");
    expect(view.startedAt as number).toBeLessThanOrEqual(view.endedAt as number);
    expect(view.originalBody).toBe(sentBody);
    // What left was protected, not the original.
    expect(saas.sent[0].body).not.toBe(sentBody);
    expect(saas.sent[0].body).not.toContain("Mehta");
  });

  it("leaves approvedBy absent and keeps no originalBody for a request without a body", async () => {
    const { handle: h } = setup();
    await fetch(CREATE_URL, { method: "GET" });
    const view = h.store.getSnapshot()[0];
    expect(view.approvedBy).toBeUndefined();
    expect(view.originalBody).toBeUndefined();
    expect(view.endedAt).toBeTypeOf("number");
  });

  it("never writes an original value into an audit event", async () => {
    const { handle: h } = setup();
    await fetch(CREATE_URL, post(JSON.stringify(SAMPLE)));
    const seen = JSON.stringify(h.audit.snapshot());
    for (const value of SYNTHETIC_VALUES) expect(seen).not.toContain(value);
  });

  it("never writes originalBody or the dropped note to storage, and writes only the Phase 6 keys", async () => {
    const { kv } = setup();
    const sentBody = JSON.stringify(SAMPLE);
    await fetch(CREATE_URL, post(sentBody));
    const allowed = new Set<string>(Object.values(KEYS));
    expect(kv.writes.length).toBeGreaterThan(0);
    for (const w of kv.writes) {
      expect(allowed.has(w.key)).toBe(true);
      expect(w.value).not.toContain("Renewal is at risk");
      expect(w.value).not.toContain(sentBody);
    }
  });

  it("keeps originalBody on only the latest 50 requests", () => {
    const { handle: h } = setup();
    const make = (n: number): RequestView => ({
      id: `r${n}`,
      createdAt: n,
      url: "https://crm.example.com/api/contacts",
      host: "crm.example.com",
      status: "done",
      shape: "unknown",
      task: "",
      originalDocument: "",
      clauses: [],
      originalBody: `{"n":${n}}`,
    });
    let emits = 0;
    h.store.subscribe(() => (emits += 1));
    for (let n = 0; n < 55; n++) h.store.create(make(n));
    expect(emits).toBe(55);
    const views = h.store.getSnapshot();
    expect(ORIGINAL_BODY_RETENTION).toBe(50);
    expect(views.slice(0, 5).every((v) => v.originalBody === undefined)).toBe(true);
    expect(views.slice(5).every((v) => v.originalBody !== undefined)).toBe(true);
    // An update that adds a body to an old view counts as the newest holder.
    h.store.update("r0", { originalBody: "late" });
    const after = h.store.getSnapshot();
    expect(after[0].originalBody).toBe("late");
    expect(after[5].originalBody).toBeUndefined();
    expect(after.filter((v) => v.originalBody !== undefined)).toHaveLength(50);
  });
});
