import { detect } from "../core/detect.js";
import { ACTIONS, CATEGORIES, type Category } from "../profiles/types.js";
import { MAX_DEPTH, MAX_FIELDS } from "../profiles/validate.js";
import type { Side, ValueType } from "./capture.js";

/**
 * The structure-only authoring prompt. It is built from paths, value types, classes and shape-only previews:
 * never a captured value. assertStructureOnly proves that before every authoring call, and the exact prompt
 * is shown to the user. The authoring model may run in the cloud (PREFER_ON_DEVICE falls back), which is only
 * safe because of this.
 */

export interface PromptLeaf {
  side: Side;
  /** Wildcard path, for example $.contacts[*].email. */
  path: string;
  valueType: ValueType;
  class: Category;
  preview: string;
}

export interface PromptInput {
  /** Accepted for symmetry but never written into the prompt: hosts can be sensitive or look like an IP address. */
  host?: string;
  method: string;
  /** URL path of the captured request. */
  path: string;
  leaves: readonly PromptLeaf[];
  /** Failures of the previous attempt: "path: rule" strings, never values. */
  feedback?: readonly string[];
}

export class StructureLeakError extends Error {
  /** Paths of the leaves whose value appeared in the prompt. Never the values. */
  readonly paths: string[];
  constructor(paths: string[]) {
    super(`The authoring prompt contains captured value(s) at: ${paths.join(", ")}. No model call was made.`);
    this.name = "StructureLeakError";
    this.paths = paths;
  }
}

/** The fixed instructions. Kept verbatim at the start of every prompt so the assertion can tell them from data. */
export const AUTHORING_INSTRUCTIONS = [
  "You write a protection profile for one HTTP endpoint of a SaaS application. Below is the STRUCTURE of a captured",
  "request and response: field paths, value types, classes and shape previews only. It holds no real values.",
  "Reply with one JSON object and nothing else.",
  "Profile fields:",
  "- name: a short label",
  '- kind: "saas"',
  '- match: {hosts, paths, methods}. hosts must be exactly ["HOST"]; the application puts the real host there. paths are globs: * inside one',
  "  segment, ** across segments, using only letters, digits and - . _ ~ / : % *. methods are upper-case.",
  "- request.fields: [{path, category, flow: {action}}] for every request field that carries personal or sensitive data",
  "- response.fields: [{path}] for response fields that echo those values back, so they can be restored for the user",
  "Locators use only this subset: $, .key, ['key'], [n], [*]. No recursive descent, filters or slices.",
  `At most ${MAX_FIELDS} fields and depth at most ${MAX_DEPTH}.`,
  `Categories: ${CATEGORIES.join(", ")}.`,
  `Actions: ${ACTIONS.join(", ")}. allow keeps the value. mask swaps in a placeholder. surrogate swaps in a realistic fake,`,
  "good for names. token swaps in a stable keyed token, good for emails, phone numbers and amounts. drop removes the",
  "field, good for internal notes. block refuses the whole call. Only fields in the non_sensitive category may use allow.",
  "The pipeline is field-protect and is set by the application.",
  "Use only paths that are listed under STRUCTURE. Do not invent fields. Skip fields that need no protection.",
  "If no response paths are listed, answer with an empty fields list for response.",
  "Answer with indented JSON (two spaces, one key per line) shaped like this:",
  "{",
  '  "name": "a short label",',
  '  "kind": "saas",',
  '  "match": {',
  '    "hosts": ["HOST"],',
  '    "paths": ["the path from TARGET"],',
  '    "methods": ["the method from TARGET"]',
  "  },",
  '  "request": {',
  '    "fields": [',
  '      { "path": "a listed request path", "category": "a category", "flow": { "action": "an action" } }',
  "    ]",
  "  },",
  '  "response": {',
  '    "fields": [',
  '      { "path": "a listed response path" }',
  "    ]",
  "  }",
  "}",
].join("\n");

/** A preview that a detector would flag (an email shape, a long digit run) is withheld from the prompt. */
function promptPreview(preview: string): string {
  return detect(preview).length > 0 ? "[shape withheld]" : preview;
}

export function buildAuthoringPrompt(input: PromptInput): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const leaf of input.leaves) {
    const key = `${leaf.side}|${leaf.path}|${leaf.valueType}|${leaf.class}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`${leaf.side} | ${leaf.path} | ${leaf.valueType} | ${leaf.class} | ${promptPreview(leaf.preview)}`);
  }
  const parts = [
    AUTHORING_INSTRUCTIONS,
    `TARGET: method ${input.method.toUpperCase()}, path ${input.path}`,
    "STRUCTURE (side | path | type | class | shape):",
    rows.join("\n"),
  ];
  if (input.feedback && input.feedback.length > 0) {
    parts.push("YOUR PREVIOUS ANSWER FAILED THESE CHECKS (path: rule). Fix them and answer again:");
    parts.push(input.feedback.slice(0, 20).map((f) => `- ${f.slice(0, 200)}`).join("\n"));
  }
  return parts.join("\n");
}

/** Values shorter than this cannot be told apart from prompt syntax; the builder never emits them. */
export const MIN_CHECKED_LENGTH = 4;

/**
 * Throws StructureLeakError, naming the paths and never the values, when any captured value of
 * MIN_CHECKED_LENGTH or more characters appears in the prompt (case-insensitive). The fixed instruction
 * block is taken out first so a value that happens to be an ordinary word (a status such as "open") does not
 * block authoring; anything the builder inserts elsewhere, or a tampered instruction block, is still checked.
 */
export function assertStructureOnly(prompt: string, values: ReadonlyArray<{ path: string; value: string }>): void {
  const checked = prompt.split(AUTHORING_INSTRUCTIONS).join("\n").toLowerCase();
  const leaked: string[] = [];
  for (const { path, value } of values) {
    const v = value.trim().toLowerCase();
    if (v.length >= MIN_CHECKED_LENGTH && checked.includes(v) && !leaked.includes(path)) leaked.push(path);
  }
  if (leaked.length > 0) throw new StructureLeakError(leaked);
}
