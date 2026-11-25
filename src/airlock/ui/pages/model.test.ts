import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../core/audit.js";
import type { RequestView } from "../../net/store.js";
import { bucketSeries, consoleStatus, countByStatus, decisionLine, diffRows, eventSummary, kpis, pinAwaiting, policyChecks, protectedLineCount } from "./model.js";

const ev = (id: number, ts: number, kind: AuditEvent["kind"], extra: Partial<AuditEvent> = {}): AuditEvent => ({ id, ts, kind, requestId: "r1", ...extra });
const view = (over: Partial<RequestView> = {}): RequestView => ({
  id: "r1",
  createdAt: 1,
  url: "https://crm.example.com/api/x",
  host: "crm.example.com",
  status: "done",
  shape: "unknown",
  task: "",
  originalDocument: "",
  clauses: [],
  ...over,
});

describe("kpis", () => {
  it("counts sent, masked, blocked and AI calls from audit events only", () => {
    const k = kpis([
      ev(1, 1, "sent", { where: "in_cloud", detail: { withheld: 3, bytes: 100 } }),
      ev(2, 2, "sent", { where: "in_cloud", detail: { withheld: 2, bytes: 50 } }),
      ev(3, 3, "blocked", { where: "code" }),
      ev(4, 4, "local-analysis", { where: "on_device" }),
      ev(5, 5, "local-analysis", { where: "in_cloud" }),
      ev(6, 6, "unprotected-send", { detail: { bytes: 10 } }),
    ]);
    expect(k.requestsProtected).toBe(2);
    expect(k.valuesMasked).toBe(5);
    expect(k.requestsBlocked).toBe(1);
    expect(k.aiCalls).toEqual({ on_device: 1, in_cloud: 1, code: 0 });
    expect(k.unprotectedSends).toBe(1);
    expect(k.bytesSent).toBe(160);
  });
  it("is all zero for an empty log", () => {
    expect(kpis([]).requestsProtected).toBe(0);
  });
});

describe("bucketSeries", () => {
  it("puts events into buckets with a 5 s minimum width", () => {
    const s = bucketSeries([ev(1, 1000, "sent"), ev(2, 1500, "blocked")], 2000);
    expect(s.bucketMs).toBe(5000);
    expect(s.protected.reduce((a, b) => a + b, 0)).toBe(1);
    expect(s.blocked.reduce((a, b) => a + b, 0)).toBe(1);
    expect(s.protected).toHaveLength(24);
  });
  it("spreads a long span across 24 buckets and keeps the newest in the last", () => {
    const now = 10_000_000;
    const s = bucketSeries([ev(1, 0, "sent"), ev(2, now - 1, "sent")], now);
    expect(s.protected[23]).toBe(1);
    expect(s.protected.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("consoleStatus", () => {
  it("maps store states to the console chips", () => {
    expect(consoleStatus(view({ status: "awaiting-approval" }))).toBe("awaiting");
    expect(consoleStatus(view({ status: "inspecting" }))).toBe("awaiting");
    expect(consoleStatus(view({ status: "blocked" }))).toBe("blocked");
    expect(consoleStatus(view({ status: "denied" }))).toBe("denied");
    expect(consoleStatus(view({ status: "done", restoredView: "x" }))).toBe("restored");
    expect(consoleStatus(view({ status: "done", restoredCount: 2 }))).toBe("restored");
    expect(consoleStatus(view({ status: "done", actionCounts: { mask: 2 } }))).toBe("protected");
    expect(consoleStatus(view({ status: "done", actionCounts: { allow: 2 } }))).toBe("passed");
  });
  it("counts and pins awaiting rows first", () => {
    const vs = [view({ id: "a", createdAt: 3 }), view({ id: "b", createdAt: 1, status: "awaiting-approval" }), view({ id: "c", createdAt: 2, status: "blocked" })];
    expect(countByStatus(vs).awaiting).toBe(1);
    expect(pinAwaiting(vs).map((v) => v.id)).toEqual(["b", "a", "c"]);
  });
});

describe("policyChecks", () => {
  it("lists only the rules the field pipeline runs and marks the failed one", () => {
    const v = view({
      pipeline: "field-protect",
      policy: { pass: false, failures: [{ rule: "no-residual-detection", title: "t", explain: "An email was found.", index: 0, found: "email" }] },
    });
    const c = policyChecks(v);
    expect(c.map((x) => x.rule)).toEqual(["no-residual-detection", "no-vault-value"]);
    expect(c[0].state).toBe("blocked");
    expect(c[0].explain).toBe("An email was found.");
    expect(c[1].state).toBe("pass");
  });
  it("is pending before the policy ran and covers all four Gemini rules", () => {
    const c = policyChecks(view({ pipeline: "ai-minimize" }));
    expect(c).toHaveLength(4);
    expect(c.every((x) => x.state === "pending")).toBe(true);
  });
});

describe("decisionLine and eventSummary", () => {
  it("states who approved", () => {
    expect(decisionLine(view({ approvedBy: "user" }))).toBe("Approved by you");
    expect(decisionLine(view({ approvedBy: "auto", destinationId: "saas-default" }))).toContain("saas-default");
    expect(decisionLine(view({ status: "denied" }))).toBe("Denied by you");
  });
  it("summarises events without values", () => {
    expect(eventSummary(ev(1, 1, "sent", { detail: { host: "api.example.com", bytes: 42, withheld: 3 } }))).toBe("Sent 42 bytes to api.example.com, 3 value(s) withheld");
    expect(eventSummary(ev(2, 1, "blocked", { detail: { reason: "rule failed" } }))).toBe("Blocked by code: rule failed");
    expect(eventSummary(ev(3, 1, "local-analysis", { where: "on_device", detail: { calls: 1 } }))).toContain("on this device");
  });
});

describe("diffRows", () => {
  it("aligns a protected JSON body line by line", () => {
    const original = JSON.stringify({ a: "keep", email: "x@example.com", note: "secret" });
    const outbound = JSON.stringify({ a: "keep", email: "[EMAIL_1]" });
    const rows = diffRows(original, outbound);
    expect(rows.find((r) => r.left?.includes("keep"))?.kind).toBe("same");
    expect(rows.find((r) => r.left?.includes("x@example.com"))?.kind).toBe("changed");
    expect(rows.find((r) => r.left?.includes("secret"))?.kind).toBe("removed");
    expect(protectedLineCount(rows)).toBeGreaterThanOrEqual(2);
  });
  it("treats identical text as all same", () => {
    expect(diffRows("a\nb", "a\nb").every((r) => r.kind === "same")).toBe(true);
  });
});
