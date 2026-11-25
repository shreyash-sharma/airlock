import { getAll, parsePath, PathError } from "../profiles/jsonpath.js";
import { globMatch, hostMatches } from "../profiles/match.js";
import type { Profile } from "../profiles/types.js";
import { WITHHELD_KEY, type Observation, type ShapeNode } from "./shape.js";

/**
 * Deterministic proposals for a profile's response locators and for covering reads. Code, not a model, chooses them,
 * from value-free shapes of answers AIRLOCK saw from the same host. A locator restores every string below it, and
 * restoring only replaces values this engine itself protected, so a broad container locator is safe to apply.
 */

export interface LocatorSuggestion {
  locator: string;
  /** Where the proposal comes from, in words: "GET /api/v1/Contact" or "the answer to a write". */
  from: string;
  /** String values below the locator in the observed shape. Zero when the answer was empty or not observed. */
  resolves: number;
  /** False for the proposal that is not based on an observed answer. */
  observed: boolean;
}

const isObject = (n: ShapeNode): n is { [key: string]: ShapeNode } => typeof n === "object" && !Array.isArray(n);

function countStrings(node: ShapeNode): number {
  if (node === "$string") return 1;
  if (Array.isArray(node)) return node.reduce((a, n) => a + countStrings(n), 0);
  if (isObject(node)) return Object.values(node).reduce((a, n) => a + countStrings(n), 0);
  return 0;
}

const directStrings = (node: { [key: string]: ShapeNode }): number => Object.values(node).filter((n) => n === "$string").length;
const hasRecords = (node: ShapeNode): boolean => Array.isArray(node) && node.some((n) => isObject(n) || Array.isArray(n));

/** Locators one observed answer supports. */
export function locatorsOfShape(tree: ShapeNode): Array<{ locator: string; resolves: number }> {
  if (Array.isArray(tree)) return [{ locator: "$[*]", resolves: countStrings(tree) }];
  if (!isObject(tree)) return [];
  // A record with strings of its own (a detail answer): the record itself, which reaches nested lists too.
  if (directStrings(tree) > 0) return [{ locator: "$", resolves: countStrings(tree) }];
  // A list answer ({ total, list: [...] }): each array of records.
  const out: Array<{ locator: string; resolves: number }> = [];
  for (const [key, child] of Object.entries(tree)) {
    if (key === WITHHELD_KEY || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    if (Array.isArray(child) && (hasRecords(child) || child.length === 0)) out.push({ locator: `$.${key}[*]`, resolves: countStrings(child) });
  }
  if (out.length === 0 && Object.values(tree).some(isObject)) out.push({ locator: "$", resolves: countStrings(tree) });
  return out;
}

const WRITES = new Set(["POST", "PUT", "PATCH"]);

/** Does an observation belong to this profile: same host and a path the profile covers, or one record below its path. */
function related(profile: Profile, o: Observation): boolean {
  if (!profile.match.hosts.some((h) => hostMatches(h, o.host))) return false;
  return profile.match.paths.some((p) => {
    if (globMatch(p, o.path)) return true;
    const base = p.endsWith("/**") ? p.slice(0, -3) : p.replace(/\/\*+$/, "");
    return !base.includes("*") && (o.path === base || o.path.startsWith(`${base}/`));
  });
}

export interface SuggestionSet {
  locators: LocatorSuggestion[];
  /** True when an observed read exists for the profile's paths and the profile's methods do not name GET. */
  addGet: boolean;
}

export function suggestResponseLocators(profile: Profile, observations: readonly Observation[]): SuggestionSet {
  const seen = new Map<string, LocatorSuggestion>();
  let sawGet = false;
  for (const o of observations) {
    if (!related(profile, o)) continue;
    if (o.method === "GET") sawGet = true;
    for (const l of locatorsOfShape(o.shape.tree)) {
      const prior = seen.get(l.locator);
      if (!prior) seen.set(l.locator, { locator: l.locator, from: `${o.method} ${o.path}`, resolves: l.resolves, observed: true });
      else if (l.resolves > prior.resolves) seen.set(l.locator, { ...prior, resolves: l.resolves });
    }
  }
  // The answer to a write usually carries back the record it saved, and it cannot be observed before the first approved write.
  const writes = (profile.match.methods ?? []).some((m) => WRITES.has(m.toUpperCase()));
  if (writes && !seen.has("$")) {
    seen.set("$", { locator: "$", from: "the answer to a write (not observed yet)", resolves: 0, observed: false });
  }
  const names = (profile.match.methods ?? []).map((m) => m.toUpperCase());
  const addGet = sawGet && !names.includes("GET");
  return { locators: [...seen.values()], addGet };
}

/** The locator parses and is inside the profile's subset; the message names what is wrong. */
export function validateLocator(locator: string): { ok: true } | { ok: false; error: string } {
  try {
    parsePath(locator);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof PathError ? err.message : "not a valid locator" };
  }
}

/** How many string values a locator reaches in a pasted sample answer. */
export function countRestorable(sample: unknown, locator: string): { ok: true; resolves: number } | { ok: false; error: string } {
  const v = validateLocator(locator);
  if (!v.ok) return v;
  let n = 0;
  const walk = (x: unknown): void => {
    if (typeof x === "string") n++;
    else if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === "object" && x !== null) Object.values(x).forEach(walk);
  };
  getAll(sample, locator).forEach((hit) => walk(hit.value));
  return { ok: true, resolves: n };
}

/** The paths a GET addition covers: the profile's own paths, and one record below each exact path (path/*). */
export function pathsWithRecords(paths: readonly string[]): string[] {
  const out = [...paths];
  for (const p of paths) {
    if (p.includes("*")) continue;
    const below = `${p.replace(/\/+$/, "")}/*`;
    if (!out.includes(below)) out.push(below);
  }
  return out;
}
