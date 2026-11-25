import { STRICT_RULES } from "../../flows/rules.js";
import { afterEach, describe, expect, it } from "vitest";
import { installAirlock, type AirlockHandle } from "../../net/guard.js";
import { memoryKV } from "../../profiles/storage.js";
import type { Profile } from "../../profiles/types.js";
import { buildReceipt, collectForbidden, receiptFilename } from "./receipt.js";

/** Synthetic values of the Rohan Mehta sample. Every value is made up; example.com is reserved. */
const SYNTHETIC_VALUES = ["Rohan", "Mehta", "9876543210", "rohan.mehta@example.com", "68000", "Renewal is at risk"];
const CREATE_URL = "https://crm.example.com/api/contacts";
const post = (body: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body });
const field = (name: string, category: string, action: string) => ({ path: `$.properties.${name}`, category, flow: { action } });
const SAAS = {
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
  },
  response: { fields: [] },
  author: { by: "user", at: "2026-11-23T10:00:00.000Z" },
} as Profile;

let installed: AirlockHandle | undefined;
afterEach(() => installed?.uninstall());

/** The guard over a fake SaaS that answers 201 with whatever it was sent. */
function setup() {
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Response(typeof init?.body === "string" ? init.body : "{}", { status: 201, headers: { "content-type": "application/json" } })) as typeof fetch;
  installed = installAirlock({ rules: STRICT_RULES, fetchImpl: impl, profiles: [SAAS], kv: memoryKV() });
  return { handle: installed };
}

const SAMPLE_BODY = JSON.stringify({
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
});
const BLOCKED_BODY = JSON.stringify({ properties: { city: "Pune", backup_contact: "ops@example.com" } });
const NOW = new Date(2026, 10, 23, 14, 5, 9);

describe("receipt value scan (D3)", () => {
  it("builds from a protected run and a blocked run and holds none of the synthetic values", async () => {
    const { handle } = setup();
    await fetch(CREATE_URL, post(SAMPLE_BODY));
    await expect(fetch(CREATE_URL, post(BLOCKED_BODY))).rejects.toThrow();
    const views = handle.store.getSnapshot();
    expect(views.map((v) => v.status)).toEqual(["done", "blocked"]);

    const forbidden = collectForbidden(views, []);
    // The whole note is one leaf, so the phrase is covered by it.
    for (const value of SYNTHETIC_VALUES) expect(forbidden.some((f) => f.includes(value))).toBe(true);

    const built = await buildReceipt({ events: handle.audit.snapshot(), selection: "all", profiles: [], forbidden, now: NOW });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    for (const value of SYNTHETIC_VALUES) expect(built.json.toLowerCase()).not.toContain(value.toLowerCase());
    expect(built.json).not.toContain("ops@example.com");
    expect(built.filename).toBe("airlock-receipt-20261123-140509.json");
    expect(built.receipt.counts.requestsProtected).toBe(1);
    expect(built.receipt.counts.requestsBlocked).toBe(1);
  });

  it("refuses to build when an audit reason holds an original value, and returns no json", async () => {
    const { handle } = setup();
    await fetch(CREATE_URL, post(SAMPLE_BODY));
    const seeded = handle.audit.add({ kind: "blocked", requestId: "req-seeded", where: "code", detail: { reason: "Rohan Mehta" } });
    const events = handle.audit.snapshot();
    const at = events.findIndex((e) => e.id === seeded.id);
    const built = await buildReceipt({ events, selection: "all", profiles: [], forbidden: collectForbidden(handle.store.getSnapshot(), []), now: NOW });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.rule).toBe("forbidden-value");
    expect(built.path).toBe(`events[${at}].detail.reason`);
    expect("json" in built).toBe(false);
  });

  it("drops detail keys that are not on the allow-list", async () => {
    const { handle } = setup();
    handle.audit.add({ kind: "local-analysis", requestId: "req-x", where: "code", detail: { step: "classify-fields", calls: 1, mode: "ONLY_ON_DEVICE" } });
    const built = await buildReceipt({ events: handle.audit.snapshot(), selection: "all", profiles: [], forbidden: [], now: NOW });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.receipt.events[0].detail).toEqual({ mode: "ONLY_ON_DEVICE" });
  });

  it("names the file airlock-receipt-YYYYMMDD-HHMMSS.json", () => {
    expect(receiptFilename(NOW)).toMatch(/^airlock-receipt-\d{8}-\d{6}\.json$/);
  });
});
