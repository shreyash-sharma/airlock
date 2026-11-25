import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "../flows/rules.js";
import { ROLES, renderFor, type Role } from "../flows/roles.js";
import { installAirlock, type AirlockHandle } from "./guard.js";

const EMAIL = "rohan.mehta@example.com";
const PHONE = "+44 7700 900123";
const HOST = "crm.test";
const H = { "content-type": "application/json" };

let handle: AirlockHandle | undefined;
afterEach(() => {
  handle?.uninstall();
  handle = undefined;
});

/** One write whose answer echoes what the CRM stored, seen by one viewer role. */
async function seenAs(viewer: Role): Promise<string> {
  const impl = (async (_i: RequestInfo | URL, init?: RequestInit) => new Response(String(init?.body ?? "{}"), { status: 200, headers: H })) as typeof fetch;
  handle = installAirlock({ fetchImpl: impl, scope: [HOST], rules: { ...DEFAULT_RULES, viewer } });
  const res = await fetch(`https://${HOST}/api/v1/Whatever`, { method: "POST", headers: H, body: JSON.stringify({ note: `call ${EMAIL} or ${PHONE}` }) });
  const text = await res.text();
  handle.uninstall();
  handle = undefined;
  return text;
}

describe("viewer roles: one stored record, a different view per role", () => {
  it("owner gets everything back", async () => {
    const t = await seenAs("owner");
    expect(t).toContain(EMAIL);
    expect(t).toContain(PHONE);
  });
  it("support sees the email and phone partly hidden", async () => {
    const t = await seenAs("support");
    expect(t).not.toContain(EMAIL);
    expect(t).toContain("@example.com");
    expect(t).toMatch(/r•+@example\.com/);
    expect(t).toContain("0123");
    expect(t).not.toContain("7700 900123");
  });
  it("analyst sees stand-ins only", async () => {
    const t = await seenAs("analyst");
    expect(t).not.toContain(EMAIL);
    expect(t).not.toContain("900123");
    expect(t).toMatch(/@/);
  });
  it("auditor sees that values exist, never what they are", async () => {
    const t = await seenAs("auditor");
    expect(t).toContain("[restricted]");
    expect(t).not.toContain("example.com");
  });
  it("renderFor is a plain table: every role other than owner hides the raw email", () => {
    for (const r of ROLES) if (r !== "owner") expect(renderFor(r, EMAIL, "x@y.test", "EMAIL")).not.toBe(EMAIL);
  });
});
