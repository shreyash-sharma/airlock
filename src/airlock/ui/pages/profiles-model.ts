import { validateProfile } from "../../profiles/validate.js";
import type { ProfileEntry, ProfileOrigin } from "../../profiles/storage.js";
import type { AuthorBy, Category, FieldSpec, Profile } from "../../profiles/types.js";

/** Pure logic of the Profiles page: rows, edits, validation, import and export. No React, no DOM. */

export const AUTHOR_LABEL: Record<AuthorBy, string> = {
  builtin: "Built-in",
  user: "You",
  on_device: "On-device AI",
  in_cloud: "Cloud AI",
};

export const ORIGIN_LABEL: Record<ProfileOrigin, string> = {
  stored: "Stored in this browser",
  app: "Supplied by the app",
  "built-in": "Built into AIRLOCK",
};

export interface ProfileRow {
  id: string;
  name: string;
  hosts: string[];
  kind: Profile["kind"];
  pipeline: Profile["pipeline"];
  authoredBy: AuthorBy;
  origin: ProfileOrigin;
  fields: number;
  flows: number;
  changedAt: number | undefined;
  /** Only profiles stored in this browser can be edited or deleted. */
  editable: boolean;
}

/** Fields (request and response locators) and flows (fields that carry an action of their own). */
export function countFields(p: Profile): { fields: number; flows: number } {
  const all = [...p.request.fields, ...p.response.fields];
  return { fields: all.length, flows: all.filter((f) => f.flow !== undefined).length };
}

export function profileRows(entries: readonly ProfileEntry[]): ProfileRow[] {
  return entries.map(({ profile: p, origin }) => {
    const c = countFields(p);
    const at = Date.parse(p.author.at);
    return {
      id: p.id,
      name: p.name,
      hosts: p.match.hosts,
      kind: p.kind,
      pipeline: p.pipeline,
      authoredBy: p.author.by,
      origin,
      fields: c.fields,
      flows: c.flows,
      changedAt: Number.isNaN(at) ? undefined : at,
      editable: origin === "stored",
    };
  });
}

/** "just now", "5 min ago", "3 h ago" or a date, from an ISO time and the current time. */
export function changedLabel(at: number | undefined, now: number): string {
  if (at === undefined) return "unknown";
  const diff = now - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/** Hosts for display: names the hosts, or says a template matches nothing yet. */
export function hostsLabel(hosts: readonly string[]): string {
  return hosts.length === 0 ? "no host yet (template)" : hosts.join(", ");
}

export type ParseResult = { ok: true; profile: Profile } | { ok: false; errors: string[] };

/** Parse and validate profile JSON text. Nothing is returned for a profile that is invalid. */
export function parseProfileText(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`json: ${e instanceof Error ? e.message : "not valid JSON"}`] };
  }
  const r = validateProfile(raw);
  return r.ok ? { ok: true, profile: r.profile } : { ok: false, errors: r.errors };
}

/** A profile the user changed by hand is recorded as authored by the user, with the time of the change. */
export function stampUser(p: Profile, now: number): Profile {
  return { ...p, author: { by: "user", at: new Date(now).toISOString() } };
}

export type Side = "request" | "response";

export function setField(p: Profile, side: Side, index: number, field: FieldSpec): Profile {
  const fields = p[side].fields.map((f, i) => (i === index ? field : f));
  return { ...p, [side]: { fields } };
}

export function addField(p: Profile, side: Side): Profile {
  return { ...p, [side]: { fields: [...p[side].fields, { path: "$.field", category: "non_sensitive" as Category }] } };
}

export function removeField(p: Profile, side: Side, index: number): Profile {
  return { ...p, [side]: { fields: p[side].fields.filter((_, i) => i !== index) } };
}

/** Validation errors for a draft, or an empty list when it can be saved. */
export function draftErrors(p: Profile): string[] {
  const r = validateProfile(p);
  return r.ok ? [] : r.errors;
}

/** What deleting a profile removes, in words the confirm dialog shows. */
export function deleteSummary(p: Profile): string {
  const c = countFields(p);
  const what = `the profile "${p.name}" (${p.id}), with ${c.fields} field locator(s) and ${c.flows} flow(s)`;
  if (p.match.hosts.length === 0) return `This removes ${what}. It names no host yet, so no request changes.`;
  return `This removes ${what}, for ${p.match.hosts.join(", ")}. Requests to ${p.match.hosts.length === 1 ? "that host are" : "those hosts are"} blocked, or held for inspection, until a profile covers them again.`;
}

/** The download for one or all profiles. A single profile is exported as an object, several as an array. */
export function exportJson(profiles: readonly Profile[]): string {
  return JSON.stringify(profiles.length === 1 ? profiles[0] : profiles, null, 2);
}

export type ImportResult = { ok: true; items: unknown[] } | { ok: false; errors: string[] };

/** Parse an import file: one profile object or an array. Validation is done by the registry before anything is written. */
export function parseImport(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`json: ${e instanceof Error ? e.message : "not valid JSON"}`] };
  }
  const items = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) return { ok: false, errors: ["file: contains no profile"] };
  if (items.length > 50) return { ok: false, errors: ["file: at most 50 profiles can be imported at once"] };
  return { ok: true, items };
}

/** A new, empty profile for a host, authored by the user. */
export function blankProfile(host: string, now: number): Profile {
  const id = `user-${host.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "profile"}`;
  return {
    version: 1,
    id,
    name: host ? `Profile for ${host}` : "New profile",
    kind: "saas",
    pipeline: "field-protect",
    match: { hosts: host ? [host.toLowerCase()] : [], paths: ["/**"], contentTypes: ["application/json"] },
    request: { fields: [{ path: "$", category: "free_text", flow: { action: "mask" } }] },
    response: { fields: [{ path: "$" }] },
    author: { by: "user", at: new Date(now).toISOString() },
  };
}
