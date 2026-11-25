import type { AuditEvent } from "../../core/audit.js";
import { detect } from "../../core/detect.js";
import type { RequestView } from "../../net/store.js";
import { kpis } from "./model.js";

/**
 * The disclosure receipt: a JSON record of what AIRLOCK did, made only of counts, hashes and allow-listed
 * detail fields. Pure TypeScript, no React and no DOM. The builder refuses to produce a receipt when any
 * value the page realm holds locally (a request's original body, a vault original, an undecided capture)
 * appears in it.
 */

/** Audit detail keys a receipt may carry. Every other key is dropped, because `where` and `latencyMs` already carry provenance. */
export const DETAIL_ALLOWLIST: readonly string[] = [
  "profileId",
  "author",
  "destination",
  "host",
  "bytes",
  "wireHash",
  "withheld",
  "clauses",
  "withheldClauses",
  "masked",
  "pass",
  "failures",
  "rules",
  "kind",
  "status",
  "mode",
  "source",
  "approvedOnce",
  "shape",
  "approvedBy",
  "by",
  "stage",
  "allow",
  "mask",
  "surrogate",
  "token",
  "drop",
  "block",
];

/** A plain-words reason is exported too, but only after the value scan passes over it. */
export const REASON_KEY = "reason";

/** Values shorter than this are not scanned for: they would match ordinary words. */
export const MIN_FORBIDDEN_LENGTH = 4;

export interface ReceiptCheck {
  id: "allow-list" | "forbidden-values" | "detectors" | "counts";
  label: string;
  passed: boolean;
}

export interface ReceiptCounts {
  requestsProtected: number;
  valuesMasked: number;
  requestsBlocked: number;
  unprotectedSends: number;
  aiCalls: { on_device: number; in_cloud: number; code: number };
  bytesSent: number;
}

export interface ExportedEvent {
  id: number;
  ts: number;
  kind: string;
  where?: string;
  latencyMs?: number;
  requestId: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface Receipt {
  receiptVersion: 1;
  generatedAt: string;
  scope: "since page load";
  selection: "all" | "filtered";
  counts: ReceiptCounts;
  events: ExportedEvent[];
  profiles: Array<{ id: string; authoredBy?: string; sha256?: string }>;
  integrity: { algorithm: "SHA-256"; eventsSha256: string; note: string };
}

export type BuildResult =
  | { ok: true; receipt: Receipt; json: string; filename: string; checks: ReceiptCheck[] }
  | { ok: false; rule: string; path: string; checks: ReceiptCheck[] };

export interface BuildInput {
  events: readonly AuditEvent[];
  selection: "all" | "filtered";
  profiles: Receipt["profiles"];
  /** Every value the receipt must not contain (see collectForbidden). */
  forbidden: readonly string[];
  now: number | Date;
}

/** JSON with every object's keys sorted, so the same data always gives the same text and the same hash. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const item = (v as Record<string, unknown>)[key];
        if (item !== undefined) out[key] = walk(item);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** airlock-receipt-YYYYMMDD-HHMMSS.json, in the viewer's local time. */
export function receiptFilename(now: number | Date): string {
  const d = new Date(now);
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `airlock-receipt-${day}-${time}.json`;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every string and number leaf of a parsed JSON value, as text. */
function leavesOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) value.forEach((v) => leavesOf(v, out));
  else if (value !== null && typeof value === "object") Object.values(value).forEach((v) => leavesOf(v, out));
  return out;
}

/**
 * The values a receipt must never contain: the leaves of each request's original body (parsed as JSON, or the
 * whole text when it is not JSON), the values the detectors find in the task and the original document, and
 * any extra values the caller holds (vault originals, undecided captures). Values under four characters are dropped.
 */
export function collectForbidden(views: readonly RequestView[], extra: readonly string[] = []): string[] {
  const found = new Set<string>();
  const add = (text: string): void => {
    if (text.length >= MIN_FORBIDDEN_LENGTH) found.add(text);
  };
  for (const view of views) {
    if (view.originalBody !== undefined && view.originalBody.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(view.originalBody);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined || parsed === null || typeof parsed !== "object") add(view.originalBody);
      else leavesOf(parsed).forEach(add);
    }
    for (const text of [view.task, view.originalDocument]) {
      if (text) detect(text).forEach((e) => add(e.value));
    }
  }
  extra.forEach(add);
  return [...found];
}

function exportEvent(e: AuditEvent): ExportedEvent {
  const out: ExportedEvent = { id: e.id, ts: e.ts, kind: e.kind, requestId: e.requestId };
  if (e.where !== undefined) out.where = e.where;
  if (e.latencyMs !== undefined) out.latencyMs = e.latencyMs;
  if (e.detail) {
    const detail: Record<string, string | number | boolean | null> = {};
    for (const key of [...DETAIL_ALLOWLIST, REASON_KEY]) {
      if (key in e.detail) detail[key] = e.detail[key];
    }
    if (Object.keys(detail).length > 0) out.detail = detail;
  }
  return out;
}

const LABELS = {
  "allow-list": "Allow-listed fields only",
  "forbidden-values": "No stored original or captured value found",
  detectors: "No sensitive-looking value in free text",
  counts: "Counts match the exported events",
} as const;

const failed = (rule: string, path: string, checks: ReceiptCheck[]): BuildResult => ({ ok: false, rule, path, checks });

/** Build the receipt, or refuse with the rule and the path that failed. A refusal returns no JSON at all. */
export async function buildReceipt(input: BuildInput): Promise<BuildResult> {
  const events = input.events.map(exportEvent);
  const checks: ReceiptCheck[] = [
    { id: "allow-list", label: LABELS["allow-list"], passed: false },
    { id: "forbidden-values", label: LABELS["forbidden-values"], passed: false },
  ];
  const mark = (id: ReceiptCheck["id"], passed: boolean): void => {
    const check = checks.find((c) => c.id === id);
    if (check) check.passed = passed;
  };

  // 1. Allow-list: verified on the built events, not assumed from how they were built.
  const allowed = new Set([...DETAIL_ALLOWLIST, REASON_KEY]);
  for (let i = 0; i < events.length; i++) {
    for (const key of Object.keys(events[i].detail ?? {})) {
      if (!allowed.has(key)) return failed("allow-list", `events[${i}].detail.${key}`, checks);
    }
  }
  mark("allow-list", true);

  // 2. Forbidden values: every string of every exported event, case-insensitively.
  const forbidden = input.forbidden.filter((f) => f.length >= MIN_FORBIDDEN_LENGTH).map((f) => f.toLowerCase());
  const holdsForbidden = (text: string): boolean => {
    const lower = text.toLowerCase();
    return forbidden.some((f) => lower.includes(f));
  };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    for (const key of ["kind", "where", "requestId"] as const) {
      const text = e[key];
      if (typeof text === "string" && holdsForbidden(text)) return failed("forbidden-value", `events[${i}].${key}`, checks);
    }
    for (const [key, text] of Object.entries(e.detail ?? {})) {
      if (typeof text === "string" && holdsForbidden(text)) return failed("forbidden-value", `events[${i}].detail.${key}`, checks);
    }
  }
  mark("forbidden-values", true);

  const eventsSha256 = await sha256(canonicalJson(events));
  const receipt: Receipt = {
    receiptVersion: 1,
    generatedAt: new Date(input.now).toISOString(),
    scope: "since page load",
    selection: input.selection,
    counts: kpis(input.events),
    events,
    profiles: input.profiles,
    integrity: { algorithm: "SHA-256", eventsSha256, note: "A hash for tamper evidence, not a signature." },
  };
  return { ok: true, receipt, json: JSON.stringify(receipt, null, 2), filename: receiptFilename(input.now), checks };
}
