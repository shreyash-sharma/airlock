import { detect } from "../core/detect.js";

/**
 * Viewer roles: who is looking at a restored value. The vault holds one original per token; the role decides how much
 * of it this viewer gets back. The policy is plain code, so the answer to "what does an analyst see?" is a table, not a model.
 * Scope: this runs in the browser on the viewer's own machine. It shows the policy; it is not authentication.
 */
export const ROLES = ["owner", "support", "analyst", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner (full)",
  support: "Support agent",
  analyst: "Analyst",
  auditor: "Auditor",
};

export const ROLE_SUMMARY: Record<Role, string> = {
  owner: "Sees every value as it was entered.",
  support: "Sees names and cities. Emails and phones are partly hidden. Notes and secrets are hidden.",
  analyst: "Sees stand-ins only: no real names, emails or phones. Cities stay.",
  auditor: "Sees that a value exists, never what it is.",
};

export const isRole = (x: unknown): x is Role => typeof x === "string" && (ROLES as readonly string[]).includes(x);

const star = (n: number): string => "•".repeat(Math.max(3, Math.min(n, 10)));

function partialEmail(v: string): string {
  const [local = "", domain = ""] = v.split("@");
  return `${local.slice(0, 1)}${star(local.length - 1)}@${domain}`;
}

function lastFour(v: string): string {
  const digits = v.replace(/\D/g, "");
  return `${star(6)} ${digits.slice(-4)}`;
}

/** What `role` sees for a restored `original`. `standIn` is the text the CRM holds (surrogate or token). */
export function renderFor(role: Role, original: string, standIn: string, entityType?: string): string {
  if (role === "owner") return original;
  const type = entityType ?? detect(original)[0]?.type;
  // A short plain label such as a city; names are typed PERSON, so they are not mistaken for it.
  const label = type === undefined && /^[\p{L}][\p{L} .'-]{1,28}$/u.test(original);
  if (role === "support") {
    if (type === "EMAIL") return partialEmail(original);
    if (type === "PHONE") return lastFour(original);
    if (type === "PERSON" || label) return original;
    return "[hidden for your role]";
  }
  if (role === "analyst") return label ? original : standIn;
  return "[restricted]";
}
