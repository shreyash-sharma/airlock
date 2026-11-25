import { validateRules } from "../../profiles/validate.js";
import { CATEGORIES, type Action, type Approval, type Category, type Destination, type RulesData } from "../../profiles/types.js";

/** Pure logic of the destination-rules matrix on the Policies page. Every edit is validated before it is kept. */

export { CATEGORIES };

export const CATEGORY_LABEL: Record<Category, string> = {
  identifier: "Identifiers (names, IDs)",
  contact: "Contact (email, phone, address)",
  financial: "Financial",
  free_text: "Free text",
  sensitive_other: "Other sensitive",
  non_sensitive: "Not sensitive",
};

export type EditResult = { ok: true; rules: RulesData } | { ok: false; errors: string[] };

/** Short name of a destination: its hosts, or "AI hosts" / "SaaS hosts" when it matches by kind. */
export function destinationLabel(d: Destination): string {
  if (d.match.hosts && d.match.hosts.length > 0) return d.match.hosts.join(", ");
  if (d.match.kind === "ai") return "AI hosts";
  if (d.match.kind === "saas") return "SaaS hosts";
  return d.id;
}

export function destinationSub(d: Destination): string {
  if (d.match.hosts && d.match.hosts.length > 0) return `Host rule${d.match.kind ? `, ${d.match.kind === "ai" ? "AI" : "SaaS"}` : ""}`;
  return "Every host of this kind";
}

function replaceDest(rules: RulesData, id: string, fn: (d: Destination) => Destination): RulesData {
  return { ...rules, destinations: rules.destinations.map((d) => (d.id === id ? fn(d) : d)) };
}

function checked(next: RulesData): EditResult {
  const r = validateRules(next);
  return r.ok ? { ok: true, rules: r.rules } : { ok: false, errors: r.errors };
}

/** Set the default action for a category at a destination. An empty action removes the default (such a field then blocks if sensitive). */
export function setDefault(rules: RulesData, destId: string, category: Category, action: Action | ""): EditResult {
  return checked(
    replaceDest(rules, destId, (d) => {
      const defaults = { ...d.defaults };
      if (action === "") delete defaults[category];
      else defaults[category] = action;
      return { ...d, defaults };
    }),
  );
}

export function setApproval(rules: RulesData, destId: string, approval: Approval): EditResult {
  return checked(replaceDest(rules, destId, (d) => ({ ...d, approval })));
}

/**
 * Allow reads without a body for a destination that names hosts. Off by default; refused for a whole kind of host.
 * Turning it off removes the key, so a stored rule never carries a stale false.
 */
export function setAllowReads(rules: RulesData, destId: string, allow: boolean): EditResult {
  return checked(
    replaceDest(rules, destId, (d) => {
      const { allowReads: _gone, ...rest } = d;
      return allow ? { ...rest, allowReads: true } : rest;
    }),
  );
}

/** Replace a destination's host list from comma-separated text. Invalid hosts come back as errors and nothing changes. */
export function setHosts(rules: RulesData, destId: string, text: string): EditResult {
  const hosts = text
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return checked(
    replaceDest(rules, destId, (d) => {
      const match = { ...d.match };
      if (hosts.length === 0) delete match.hosts;
      else match.hosts = hosts;
      return { ...d, match };
    }),
  );
}

/** Add a rule for specific hosts, starting from the defaults of the chosen kind. */
export function addHostRule(rules: RulesData, hostsText: string, kind: "ai" | "saas"): EditResult {
  const hosts = hostsText
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hosts.length === 0) return { ok: false, errors: ["destinations: name at least one host"] };
  const base = rules.destinations.find((d) => d.match.kind === kind && !d.match.hosts);
  let n = 1;
  while (rules.destinations.some((d) => d.id === `host-rule-${n}`)) n++;
  const added: Destination = { id: `host-rule-${n}`, match: { kind, hosts }, approval: base?.approval ?? "ask", defaults: { ...(base?.defaults ?? {}) }, ...(kind === "saas" && base?.inline === true ? { inline: true } : {}) };
  return checked({ ...rules, destinations: [...rules.destinations, added] });
}

/** Only rules for specific hosts can be removed: the kind-wide rules are the fallback for every host. */
export function removeDestination(rules: RulesData, destId: string): EditResult {
  const d = rules.destinations.find((x) => x.id === destId);
  if (!d?.match.hosts) return { ok: false, errors: ["destinations: the rule for a whole kind of host cannot be removed"] };
  return checked({ ...rules, destinations: rules.destinations.filter((x) => x.id !== destId) });
}

/** Rules edited as JSON text: parse and validate, or refuse with the errors. */
export function parseRulesText(text: string): EditResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`json: ${e instanceof Error ? e.message : "not valid JSON"}`] };
  }
  return checked(raw as RulesData);
}
