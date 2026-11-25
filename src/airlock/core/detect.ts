import { detectWithRegex, filterFalsePositives, resolveOverlaps } from "../../vendor/doccloak/pipeline.js";
import { findPhoneNumbersInText } from "libphonenumber-js/min";
import { MASK_TYPES, type DetectedEntity, type EntityType } from "./types.js";

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Placeholders such as [SECRET_1] that the vault already substituted. */
const PLACEHOLDER = /^\[[A-Z_]+_\d+\]/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURE_HEX = /^[0-9a-f]+$/i;

/** Long random-looking tokens: letters and digits mixed, high entropy, and not a git SHA or UUID. */
export function looksLikeGenericSecret(token: string): boolean {
  if (token.length < 28) return false;
  if (UUID.test(token)) return false;
  if (PURE_HEX.test(token) && [32, 40, 64].includes(token.length)) return false;
  if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) return false;
  return shannonEntropy(token) >= 3.3;
}

/** The whitespace-delimited word around a match, without surrounding punctuation. */
function wordAround(text: string, start: number, end: number): string {
  let s = start;
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  let e = end;
  while (e < text.length && !/\s/.test(text[e])) e++;
  return text.slice(s, e).replace(/^[("'[]+|[)"'.,;:\]]+$/g, "");
}

/** Shapes that are identifiers, not personal data: UUIDs, long hex hashes, PREFIX-2026-000184 style ids. */
const IDENTIFIER_SHAPES = [UUID, /^[0-9a-f]{32,64}$/i, /^[A-Za-z]{2,6}-\d[\d-]*$/];
const isIdentifierMatch = (text: string, e: DetectedEntity): boolean =>
  e.detector.startsWith("regex:") && IDENTIFIER_SHAPES.some((re) => re.test(wordAround(text, e.start, e.end)));

function entity(
  type: EntityType,
  start: number,
  end: number,
  text: string,
  confidence: number,
  detector: string,
): DetectedEntity {
  return { type, value: text.slice(start, end), start, end, confidence, detector };
}

/** Secret shapes the DocCloak rules miss in our tests: Stripe-style keys, labelled passwords, bearer tokens. */
function detectSecrets(text: string): DetectedEntity[] {
  const out: DetectedEntity[] = [];
  for (const m of text.matchAll(/\bsk_(?:live|test)_[A-Za-z0-9_]{12,}/g)) {
    out.push(entity("API_KEY", m.index!, m.index! + m[0].length, text, 0.95, "airlock-stripe-key"));
  }
  const labelled = /\b(?:password|passwd|pwd|secret|token|api[_ -]?key|access[_ -]?key)\b\s*[:=]\s*["']?([^\s"',;]{6,})/gi;
  for (const m of text.matchAll(labelled)) {
    if (PLACEHOLDER.test(m[1])) continue; // already masked
    const start = m.index! + m[0].lastIndexOf(m[1]);
    out.push(entity("SECRET", start, start + m[1].length, text, 0.9, "airlock-labelled-secret"));
  }
  for (const m of text.matchAll(/\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g)) {
    if (PLACEHOLDER.test(m[1])) continue;
    const start = m.index! + m[0].lastIndexOf(m[1]);
    out.push(entity("SECRET", start, start + m[1].length, text, 0.9, "airlock-bearer"));
  }
  for (const m of text.matchAll(/[A-Za-z0-9_-]{28,}/g)) {
    if (looksLikeGenericSecret(m[0])) {
      out.push(entity("API_KEY", m.index!, m.index! + m[0].length, text, 0.6, "airlock-entropy"));
    }
  }
  return out;
}

function detectPhones(text: string): DetectedEntity[] {
  try {
    return findPhoneNumbersInText(text, "GB").map((p) =>
      entity("PHONE", p.startsAt, p.endsAt, text, 0.9, "libphonenumber"),
    );
  } catch {
    return [];
  }
}

/** Exact, case-insensitive matches of values the user told AIRLOCK to always protect. */
function detectTerms(text: string, terms: readonly string[]): DetectedEntity[] {
  const out: DetectedEntity[] = [];
  const lower = text.toLowerCase();
  for (const raw of terms) {
    const term = raw.trim();
    if (term.length < 2) continue;
    const type: EntityType = /\d/.test(term) ? "ADDRESS" : "PERSON";
    const needle = term.toLowerCase();
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) {
      out.push(entity(type, i, i + term.length, text, 1, "airlock-protected-term"));
    }
  }
  return out;
}

export interface DetectOptions {
  protectedTerms?: readonly string[];
  /** Keep only these types. Defaults to MASK_TYPES. */
  types?: ReadonlySet<EntityType>;
}

/** Deterministic detection: DocCloak rules + libphonenumber + secret rules + user-protected terms. */
export function detect(text: string, opts: DetectOptions = {}): DetectedEntity[] {
  const all = [
    ...detectWithRegex(text).filter((e) => !isIdentifierMatch(text, e)),
    ...detectPhones(text),
    ...detectSecrets(text),
    ...detectTerms(text, opts.protectedTerms ?? []),
  ];
  const types = opts.types ?? MASK_TYPES;
  return filterFalsePositives(resolveOverlaps(all))
    .filter((e) => types.has(e.type))
    .sort((a, b) => a.start - b.start);
}
