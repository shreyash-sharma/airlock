import type { Profile } from "./types.js";

export const DEFAULT_GUARDED_HOSTS = ["firebasevertexai.googleapis.com", "generativelanguage.googleapis.com"];

/**
 * Gemini generateContent. Paths are the catch-all on purpose: the v1 pipeline keeps its own streaming
 * and method messages, so behaviour on this host does not change.
 */
export const GEMINI_PROFILE: Profile = {
  version: 1,
  id: "gemini-generate-content",
  name: "Gemini generateContent",
  kind: "ai",
  pipeline: "ai-minimize",
  match: { hosts: DEFAULT_GUARDED_HOSTS, paths: ["/**"] },
  request: { fields: [] },
  response: { fields: [] },
  author: { by: "builtin", at: "2026-11-23T00:00:00.000Z" },
};

/**
 * A template for any JSON SaaS API. hosts is empty, so it matches nothing until a copy binds a host.
 * Both locators are $: a container means every string leaf beneath it.
 */
export const GENERIC_JSON_TEMPLATE: Profile = {
  version: 1,
  id: "generic-json",
  name: "Generic JSON API (template)",
  kind: "saas",
  pipeline: "field-protect",
  match: { hosts: [], paths: ["/**"], contentTypes: ["application/json"] },
  request: { fields: [{ path: "$", category: "free_text", flow: { action: "mask" } }] },
  response: { fields: [{ path: "$" }] },
  author: { by: "builtin", at: "2026-11-23T00:00:00.000Z" },
};

/** Matching order among built-ins; stored and authored profiles are always tried first. */
export const BUILTIN_PROFILES: Profile[] = [GEMINI_PROFILE, GENERIC_JSON_TEMPLATE];

/** Destination defaults live with the flows that interpret them: AI hosts ask, SaaS hosts send automatically. */
export { DEFAULT_RULES } from "../flows/rules.js";
