import type { AuditEvent } from "../../core/audit.js";
import { eventSummary, eventTone, type EventTone } from "./model.js";

/** Pure logic of the Audit page: filters and day grouping. Events carry counts and hashes, never values. */

export type Where = "on_device" | "in_cloud" | "code";
export type Group = "all" | "decisions" | "sends" | "problems" | "inference";

export interface AuditFilter {
  group: Group;
  where?: Where;
  query: string;
}

const GROUP_KINDS: Record<Exclude<Group, "all" | "inference">, readonly string[]> = {
  decisions: ["approved", "denied", "policy", "unprotected-send", "profile-saved", "read-policy"],
  sends: ["sent", "response", "protected", "read-released"],
  problems: ["blocked", "error", "local-failed"],
};

export const GROUP_LABEL: Record<Group, string> = {
  all: "All",
  decisions: "Decisions",
  sends: "Sends",
  problems: "Problems",
  inference: "AI steps",
};

export function filterEvents(events: readonly AuditEvent[], f: AuditFilter): AuditEvent[] {
  const q = f.query.trim().toLowerCase();
  return events.filter((e) => {
    if (f.group === "inference") {
      if (e.kind !== "local-analysis" && e.kind !== "internal-authoring") return false;
    } else if (f.group !== "all" && !GROUP_KINDS[f.group].includes(e.kind)) return false;
    if (f.where && e.where !== f.where) return false;
    if (q) {
      const hay = `${e.kind} ${e.requestId} ${eventSummary(e)} ${e.where ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function groupCounts(events: readonly AuditEvent[]): Record<Group, number> {
  const out = {} as Record<Group, number>;
  for (const g of Object.keys(GROUP_LABEL) as Group[]) out[g] = filterEvents(events, { group: g, query: "" }).length;
  return out;
}

export interface DayGroup {
  day: string;
  events: AuditEvent[];
}

/** Newest first, grouped by local calendar day, labelled "Today" or the date. */
export function groupByDay(events: readonly AuditEvent[], now: number): DayGroup[] {
  const dayOf = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const today = dayOf(now);
  const out: DayGroup[] = [];
  for (const e of [...events].sort((a, b) => b.ts - a.ts || b.id - a.id)) {
    const day = dayOf(e.ts);
    const label = day === today ? "Today" : day;
    const last = out[out.length - 1];
    if (last && last.day === label) last.events.push(e);
    else out.push({ day: label, events: [e] });
  }
  return out;
}

export function toneOf(e: AuditEvent): EventTone {
  return eventTone(e);
}
