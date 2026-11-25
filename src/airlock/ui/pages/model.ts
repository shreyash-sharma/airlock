import type { AuditEvent } from "../../core/audit.js";
import type { RequestView } from "../../net/store.js";

/**
 * Pure selectors for the console. They read the audit log and the request store and nothing else, so a
 * Chrome extension side panel can reuse them. Every number comes from the audit log: no sample data.
 */

export type ConsoleStatus = "awaiting" | "analyzing" | "sending" | "protected" | "restored" | "passed" | "blocked" | "denied" | "failed";

export const STATUS_LABEL: Record<ConsoleStatus, string> = {
  awaiting: "Awaiting you",
  analyzing: "Analyzing",
  sending: "Sending",
  protected: "Protected",
  restored: "Restored",
  passed: "Passed",
  blocked: "Blocked",
  denied: "Denied",
  failed: "Failed",
};

/** Statuses the table offers as filters, in display order. */
export const FILTER_ORDER: readonly ConsoleStatus[] = ["awaiting", "protected", "restored", "blocked", "passed", "denied", "failed"];

const NON_ALLOW = ["mask", "surrogate", "token", "drop"];

/** How many values or passages were withheld or replaced for a request. */
export function withheldCount(v: RequestView): number {
  if (v.prepared) return v.prepared.maskedTotal + v.prepared.withheldClauses;
  return NON_ALLOW.reduce((n, k) => n + (v.actionCounts?.[k] ?? 0), 0);
}

export function consoleStatus(v: RequestView): ConsoleStatus {
  switch (v.status) {
    case "awaiting-approval":
    case "inspecting":
    case "local-failed":
      return "awaiting";
    case "analyzing":
      return "analyzing";
    case "sending":
      return "sending";
    case "blocked":
      return "blocked";
    case "denied":
      return "denied";
    case "failed":
      return "failed";
    case "done":
      if (v.restoredView !== undefined || (v.restoredCount ?? 0) > 0) return "restored";
      return withheldCount(v) > 0 ? "protected" : "passed";
  }
}

export function countByStatus(views: readonly RequestView[]): Record<ConsoleStatus, number> {
  const out = { awaiting: 0, analyzing: 0, sending: 0, protected: 0, restored: 0, passed: 0, blocked: 0, denied: 0, failed: 0 };
  for (const v of views) out[consoleStatus(v)] += 1;
  return out;
}

export interface Kpis {
  requestsProtected: number;
  valuesMasked: number;
  requestsBlocked: number;
  unprotectedSends: number;
  aiCalls: { on_device: number; in_cloud: number; code: number };
  bytesSent: number;
}

/** Headline numbers from the audit events. The disclosure receipt uses the same function. */
export function kpis(events: readonly AuditEvent[]): Kpis {
  const out: Kpis = {
    requestsProtected: 0,
    valuesMasked: 0,
    requestsBlocked: 0,
    unprotectedSends: 0,
    aiCalls: { on_device: 0, in_cloud: 0, code: 0 },
    bytesSent: 0,
  };
  for (const e of events) {
    if (e.kind === "sent") {
      out.requestsProtected += 1;
      out.valuesMasked += Number(e.detail?.withheld ?? 0);
      out.bytesSent += Number(e.detail?.bytes ?? 0);
    } else if (e.kind === "unprotected-send") {
      out.unprotectedSends += 1;
      out.bytesSent += Number(e.detail?.bytes ?? 0);
    } else if (e.kind === "blocked") out.requestsBlocked += 1;
    else if (e.kind === "local-analysis" && e.where) out.aiCalls[e.where] += 1;
  }
  return out;
}

export interface Series {
  /** Epoch ms of the first bucket. */
  start: number;
  bucketMs: number;
  protected: number[];
  blocked: number[];
}

/** Protected (sent) and blocked events in equal time buckets across the audit span, at least minBucketMs wide. */
export function bucketSeries(events: readonly AuditEvent[], now: number, buckets = 24, minBucketMs = 5000): Series {
  const relevant = events.filter((e) => e.kind === "sent" || e.kind === "blocked");
  const first = events.length > 0 ? events[0].ts : now;
  const span = Math.max(now - first, 1);
  const bucketMs = Math.max(minBucketMs, Math.ceil(span / buckets));
  const protectedCounts = new Array<number>(buckets).fill(0);
  const blockedCounts = new Array<number>(buckets).fill(0);
  // Anchor so the newest bucket ends at "now" when the span is short, and the first event starts bucket 0 otherwise.
  const start = span >= bucketMs * buckets ? now - bucketMs * buckets : first;
  for (const e of relevant) {
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((e.ts - start) / bucketMs)));
    if (e.kind === "sent") protectedCounts[i] += 1;
    else blockedCounts[i] += 1;
  }
  return { start, bucketMs, protected: protectedCounts, blocked: blockedCounts };
}

export type CheckState = "pass" | "blocked" | "pending";

export interface PolicyCheck {
  rule: string;
  title: string;
  explain: string;
  state: CheckState;
}

const RULE_COPY: Record<string, { title: string; pass: string }> = {
  "no-residual-detection": {
    title: "No sensitive value left in the payload",
    pass: "The detectors found no sensitive value in what will leave.",
  },
  "no-vault-value": {
    title: "No protected original in the payload",
    pass: "No value AIRLOCK replaced appears verbatim in what will leave.",
  },
  "clause-not-approved": {
    title: "Only chosen passages included",
    pass: "Every passage in the payload is one you can see in the Original pane.",
  },
  "size-budget": {
    title: "Payload within the size budget",
    pass: "The outbound text is under the configured size limit.",
  },
};

const GEMINI_RULES = ["no-residual-detection", "no-vault-value", "clause-not-approved", "size-budget"];
const FIELD_RULES = ["no-residual-detection", "no-vault-value"];

/** The real deterministic rules checkPolicy runs, with this request's result for each. */
export function policyChecks(v: RequestView): PolicyCheck[] {
  const rules = v.pipeline === "field-protect" ? FIELD_RULES : GEMINI_RULES;
  return rules.map((rule) => {
    const copy = RULE_COPY[rule];
    if (!v.policy) return { rule, title: copy.title, explain: "Not checked yet.", state: "pending" as const };
    if (v.policy.pass) return { rule, title: copy.title, explain: copy.pass, state: "pass" as const };
    const failed = v.policy.failures.find((f) => f.rule === rule);
    if (failed) return { rule, title: copy.title, explain: failed.explain, state: "blocked" as const };
    return { rule, title: copy.title, explain: copy.pass, state: "pass" as const };
  });
}

/** "Approved by you", "Approved automatically by destination rule saas-default", "Denied by you", "Blocked by code". */
export function decisionLine(v: RequestView): string | null {
  if (v.status === "denied") return "Denied by you";
  if (v.status === "blocked") return "Blocked by code";
  if (v.approvedBy === "user") return "Approved by you";
  if (v.approvedBy === "auto") return `Approved automatically by destination rule ${v.destinationId ?? "(unknown)"}`;
  if (v.status === "sending" || v.status === "done") return "Sent after checks, no approval was needed";
  return null;
}

const num = (e: AuditEvent, key: string): number => Number(e.detail?.[key] ?? 0);
const str = (e: AuditEvent, key: string): string => String(e.detail?.[key] ?? "");

/** One plain-words line per audit event, built only from counts, hosts and reasons. Never a value. */
export function eventSummary(e: AuditEvent): string {
  switch (e.kind) {
    case "request-held": {
      const method = e.detail?.method ? `${str(e, "method")} ` : "";
      return `Held ${method}${str(e, "host")}. Nothing sent yet`;
    }
    case "local-analysis": {
      const ran = e.where === "on_device" ? "on this device" : e.where === "in_cloud" ? "in the cloud" : "as code, no AI";
      const calls = e.detail?.calls !== undefined ? `, ${num(e, "calls")} call(s)` : "";
      const step = e.detail?.step ? `${str(e, "step")} ` : "Passage selection ";
      return `${step}ran ${ran}${calls}`;
    }
    case "local-failed":
      return "On-device analysis could not run. Nothing sent";
    case "policy":
      return e.detail?.pass === true ? "Checked by code: passed" : `Checked by code: blocked${e.detail?.rules ? ` (${str(e, "rules")})` : ""}`;
    case "protected": {
      const n = ["mask", "surrogate", "token", "drop"].reduce((a, k) => a + num(e, k), 0);
      return `Protected ${n} value(s) for ${str(e, "destination") || "the destination"}`;
    }
    case "approved":
      if (String(e.detail?.by ?? "").startsWith("inline")) return `Sent at once, masked, by inline mode on destination ${str(e, "destination")} (no approval step)`;
      return e.detail?.by === "auto" ? `Approved automatically by destination rule ${str(e, "destination")}` : "Approved by you";
    case "denied":
      // The extension's fail-closed gate denies with a reason (panel closed, no answer in time); a user's own deny has none.
      return str(e, "reason") ? `Not sent: ${str(e, "reason")}` : "Denied by you. Nothing sent";
    case "blocked":
      return `Blocked by code: ${str(e, "reason") || "policy rule failed"}`;
    case "sent": {
      const where = str(e, "host");
      return `Sent ${num(e, "bytes")} bytes${where ? ` to ${where}` : ""}, ${num(e, "withheld")} value(s) withheld`;
    }
    case "response":
      return `Answer received${e.latencyMs !== undefined ? ` in ${e.latencyMs} ms` : ""}`;
    case "error":
      return `Error: ${str(e, "reason") || `HTTP ${str(e, "status")}`}`;
    case "inspection-held":
      return `Held for inspection: ${str(e, "method")} ${str(e, "host")}`;
    case "unprotected-send":
      return `Sent once unprotected, ${num(e, "bytes")} bytes`;
    case "profile-saved":
      return `Profile ${str(e, "profileId") || ""} saved`.trim();
    case "read-released":
      return `Read released: ${str(e, "method")} ${str(e, "host")}${str(e, "path")} under the allow-reads rule (no body)`;
    case "read-policy":
      return str(e, "state") === "on" ? `Allow-reads rule in force for ${str(e, "hosts")}` : `Allow-reads rule withdrawn (${str(e, "hosts") || "no hosts"})`;
    default:
      return e.kind;
  }
}

export type EventTone = "ok" | "blocked" | "attention" | "info" | "neutral";

export function eventTone(e: AuditEvent): EventTone {
  switch (e.kind) {
    case "blocked":
    case "error":
    case "unprotected-send":
    case "local-failed":
      return "blocked";
    case "denied":
      return "neutral";
    case "request-held":
    case "inspection-held":
    case "read-policy":
      return "attention";
    case "sent":
    case "response":
      return "info";
    default:
      return "ok";
  }
}

export interface DiffRow {
  kind: "same" | "changed" | "removed" | "added";
  left?: string;
  right?: string;
}

/** Pretty-print JSON when it parses; otherwise return the text unchanged. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Aligned rows for the dual-pane view: the original on the left, what leaves on the right. */
export function diffRows(original: string, outbound: string): DiffRow[] {
  const a = prettyJson(original).split("\n");
  const b = prettyJson(outbound).split("\n");
  if (a.length * b.length > 400_000) {
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => rowOf(a[i], b[i]));
  }
  // Longest common subsequence over lines.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) out.push(rowOf(dels[k], adds[k]));
    dels = [];
    adds = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      out.push({ kind: "same", left: a[i], right: b[j] });
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      adds.push(b[j++]);
    } else {
      dels.push(a[i++]);
    }
  }
  flush();
  return out;
}

function rowOf(left: string | undefined, right: string | undefined): DiffRow {
  if (left !== undefined && right !== undefined) return { kind: left === right ? "same" : "changed", left, right };
  if (left !== undefined) return { kind: "removed", left };
  return { kind: "added", right };
}

/** How many original lines were replaced or dropped before sending. */
export function protectedLineCount(rows: readonly DiffRow[]): number {
  return rows.filter((r) => r.kind === "changed" || r.kind === "removed").length;
}

/** "H:MM:SS" in the viewer's local time. */
export function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The newest `limit` views, newest first, with requests that await a decision pinned above the rest. */
export function pinAwaiting(views: readonly RequestView[]): RequestView[] {
  const sorted = [...views].sort((x, y) => y.createdAt - x.createdAt);
  return [...sorted.filter((v) => consoleStatus(v) === "awaiting"), ...sorted.filter((v) => consoleStatus(v) !== "awaiting")];
}
