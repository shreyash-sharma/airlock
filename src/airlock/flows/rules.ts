import { canonicalHost } from "../profiles/match.js";
import type { Action, Category, Destination, ProfileKind, RulesData } from "../profiles/types.js";

/**
 * Destination rules: editable JSON that says, per destination, whether the user is asked before a protected
 * request leaves and which action a category gets when a profile field carries no flow of its own. AI hosts
 * ask and tokenize or mask; SaaS hosts send automatically and keep the records usable (surrogate names,
 * tokenized contact and financial values).
 */
export const DEFAULT_RULES: RulesData = {
  version: 1,
  destinations: [
    {
      id: "ai-default",
      match: { kind: "ai" },
      approval: "ask",
      defaults: {
        identifier: "token",
        contact: "token",
        financial: "mask",
        free_text: "mask",
        sensitive_other: "mask",
        non_sensitive: "allow",
      },
    },
    {
      id: "saas-default",
      match: { kind: "saas" },
      approval: "auto",
      inline: true,
      defaults: {
        identifier: "surrogate",
        contact: "token",
        financial: "token",
        free_text: "mask",
        sensitive_other: "drop",
        non_sensitive: "allow",
      },
    },
  ],
};

/** The same rules with SaaS inline mode off: a request no profile covers, or a violation, is blocked and nothing waits to be masked. Opt-in strict mode. */
export const STRICT_RULES: RulesData = {
  version: 1,
  destinations: DEFAULT_RULES.destinations.map((d) => (d.inline ? { ...d, inline: false } : d)),
};

/** Used when no destination matches: ask every time and name no defaults, so sensitive fields are blocked. */
export const FAIL_CLOSED_DESTINATION: Destination = { id: "fail-closed", match: {}, approval: "ask", defaults: {} };

/** Categories whose values must never pass silently: they need a flow or a destination default. */
export const SENSITIVE_CATEGORIES: ReadonlySet<Category> = new Set<Category>(["identifier", "contact", "financial"]);

/** First destination naming this host, else the first of this kind, else fail closed (ask, no defaults). */
export function resolveDestination(rules: RulesData, host: string, kind: ProfileKind): Destination {
  const h = canonicalHost(host);
  const byHost = rules.destinations.find((d) => d.match.hosts?.some((x) => canonicalHost(x) === h));
  if (byHost) return byHost;
  const byKind = rules.destinations.find((d) => d.match.kind === kind && !d.match.hosts);
  return byKind ?? FAIL_CLOSED_DESTINATION;
}

/**
 * Where a field's action comes from when its profile entry has no flow:
 * - the destination's default for the category;
 * - else, for a value a detector found, mask (the detected-value fallback);
 * - else, for a declared sensitive category with no default, block: it can never pass silently;
 * - else allow (nothing sensitive was declared or detected).
 * source says how the category is known: declared by the profile, found by a detector, or not at all.
 */
export function defaultAction(dest: Destination, category: Category | undefined, source: "declared" | "detected" | "none"): Action {
  if (category !== undefined) {
    const configured = dest.defaults[category];
    if (configured !== undefined) return configured;
    if (source === "detected") return "mask";
    if (SENSITIVE_CATEGORIES.has(category)) return "block";
    return "allow";
  }
  return source === "detected" ? "mask" : "allow";
}
