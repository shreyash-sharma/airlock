import type { EntityType } from "../core/types.js";

/**
 * The profile contract: plain JSON, version 1. A profile tells the engine how to recognise one kind of
 * request (match), which fields of the request and the response matter (locators plus a category) and
 * what to do with each field (a flow). It is data, never code: the model may author it, deterministic
 * code validates and enforces it. No DOM and no page assumptions live in this module.
 */

/** Classification classes for a leaf field. */
export const CATEGORIES = ["identifier", "contact", "financial", "free_text", "sensitive_other", "non_sensitive"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Protection actions. allow keeps the value; block aborts the request with a named reason. */
export const ACTIONS = ["allow", "mask", "surrogate", "token", "drop", "block"] as const;
export type Action = (typeof ACTIONS)[number];

export type FlowParams = Record<string, string | number | boolean>;

export interface FlowSpec {
  action: Action;
  params?: FlowParams;
}

export interface FieldSpec {
  /** A locator in the JSONPath subset: $, .key, ['key'], [n], [*]. A container means every string leaf beneath it. */
  path: string;
  category?: Category;
  flow?: FlowSpec;
}

export type ProfileKind = "ai" | "saas";
export type PipelineName = "ai-minimize" | "field-protect";
export type AuthorBy = "builtin" | "user" | "on_device" | "in_cloud";

export interface ProfileMatch {
  /** Host names with an optional port. Never wildcards. An empty list matches nothing (templates). */
  hosts: string[];
  /** Path globs: * within a segment, ** across segments. The query string is ignored. */
  paths: string[];
  /** Upper-case HTTP methods. Absent or empty means any. */
  methods?: string[];
  /** Content-type prefixes. Absent or empty means any. */
  contentTypes?: string[];
}

export interface Profile {
  version: 1;
  id: string;
  name: string;
  kind: ProfileKind;
  pipeline: PipelineName;
  match: ProfileMatch;
  request: { fields: FieldSpec[] };
  response: { fields: FieldSpec[] };
  author: { by: AuthorBy; at: string };
}

export type Approval = "ask" | "auto";

export interface Destination {
  id: string;
  match: { kind?: ProfileKind; hosts?: string[] };
  approval: Approval;
  /** Default action per category, used when a field carries no flow of its own. */
  defaults: Partial<Record<Category, Action>>;
  /**
   * User-set, per host, off unless true, and only honoured on a destination that names hosts. A GET or HEAD with no
   * body to those hosts that no profile covers is sent after the URL scan instead of being held or blocked, and
   * every one is audited. POST, PUT, PATCH, DELETE and anything with a body are never affected.
   */
  allowReads?: boolean;
  /**
   * Inline mode: nothing waits and nothing is blocked. Detected values are replaced by local tokens and the request is
   * sent at once; what needs a look is queued for later review. Set by the default SaaS rule, never allowed for "ai". Absent means strict (block and ask).
   */
  inline?: boolean;
}

export interface RulesData {
  version: 1;
  destinations: Destination[];
  /** Who is viewing restored values: owner (default, everything), support, analyst or auditor. */
  viewer?: "owner" | "support" | "analyst" | "auditor";
}

/** One captured request (and optionally its response) with the values the dry run must not let through. */
export interface DryRunSample {
  request: unknown;
  response?: unknown;
  sensitive: Array<{ path: string; value: string }>;
}

export interface DryRunResult {
  ok: boolean;
  /** One entry per failure, formatted "path: rule". Never carries values. */
  failures: string[];
  /** True when the response restore round trip reproduced the originals. */
  restored: boolean;
}

/** Implemented by the flows plan, consumed by the authoring plan. */
export type DryRun = (profile: Profile, sample: DryRunSample, rules?: RulesData) => Promise<DryRunResult>;

/** Which category a regex-detected entity type belongs to. */
export const CATEGORY_OF_ENTITY: Record<EntityType, Category> = {
  EMAIL: "contact",
  PHONE: "contact",
  ADDRESS: "contact",
  IP_ADDRESS: "contact",
  PERSON: "identifier",
  SSN: "identifier",
  COMPANY: "identifier",
  CREDIT_CARD: "financial",
  IBAN: "financial",
  CURRENCY: "financial",
  DATE: "sensitive_other",
  SECRET: "sensitive_other",
  API_KEY: "sensitive_other",
  OTHER: "sensitive_other",
};
