import { detect } from "./detect.js";
import { MASK_TYPES, type EntityType } from "./types.js";

export interface RuleFailure {
  rule: "no-residual-detection" | "no-vault-value" | "clause-not-approved" | "size-budget";
  title: string;
  explain: string;
  /** Character position in the outbound text where the problem starts (-1 when not positional). */
  index: number;
  /** Safe description of what was found: category or clause id, never the secret value itself. */
  found: string;
}

export type PolicyResult = { pass: true } | { pass: false; failures: RuleFailure[] };

export interface PolicyInput {
  /** All outbound text parts joined with newlines. */
  text: string;
  /** Original values held by the vault; none may appear in the outbound text. */
  vaultOriginals: readonly string[];
  /** Clause ids the user's selection allows to appear as [C#] markers. */
  allowedClauseIds: readonly string[];
  maxChars: number;
  protectedTerms?: readonly string[];
  types?: ReadonlySet<EntityType>;
}

export const DEFAULT_MAX_CHARS = 24_000;

/** Deterministic disclosure rules. No model is involved: this is the part that decides. */
export function checkPolicy(input: PolicyInput): PolicyResult {
  const failures: RuleFailure[] = [];
  const types = input.types ?? MASK_TYPES;

  for (const e of detect(input.text, { protectedTerms: input.protectedTerms, types })) {
    failures.push({
      rule: "no-residual-detection",
      title: "Sensitive value still present",
      explain: `A ${e.type} value was detected in the outbound text after masking.`,
      index: e.start,
      found: e.type,
    });
  }

  const lower = input.text.toLowerCase();
  for (const original of input.vaultOriginals) {
    if (original.length < 3) continue;
    const at = lower.indexOf(original.toLowerCase());
    if (at !== -1) {
      failures.push({
        rule: "no-vault-value",
        title: "A protected original value is in the payload",
        explain: "A value that AIRLOCK replaced with a placeholder appears verbatim in the outbound text.",
        index: at,
        found: "protected value",
      });
    }
  }

  const allowed = new Set(input.allowedClauseIds);
  for (const m of input.text.matchAll(/\[(C\d+)\]/g)) {
    if (!allowed.has(m[1])) {
      failures.push({
        rule: "clause-not-approved",
        title: "Clause not approved",
        explain: `Clause ${m[1]} is referenced in the outbound text but was not selected for this task.`,
        index: m.index!,
        found: m[1],
      });
    }
  }

  if (input.text.length > input.maxChars) {
    failures.push({
      rule: "size-budget",
      title: "Payload too large",
      explain: `The outbound text is ${input.text.length} characters; the budget is ${input.maxChars}.`,
      index: -1,
      found: `${input.text.length} chars`,
    });
  }

  return failures.length ? { pass: false, failures } : { pass: true };
}
