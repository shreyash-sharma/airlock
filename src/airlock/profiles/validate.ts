import { isRole } from "../flows/roles.js";
import { parsePath, PathError } from "./jsonpath.js";
import {
  ACTIONS,
  CATEGORIES,
  type Action,
  type AuthorBy,
  type Category,
  type Destination,
  type FieldSpec,
  type FlowParams,
  type FlowSpec,
  type PipelineName,
  type Profile,
  type ProfileKind,
  type ProfileMatch,
  type RulesData,
} from "./types.js";

/** Caps on anything a model may author. Constants in one place, per CONTEXT "Caps". */
export const MAX_FIELDS = 200;
export const MAX_DEPTH = 8;
export const MAX_HOSTS = 20;
export const MAX_PATHS = 50;
export const MAX_DESTINATIONS = 50;

export type ProfileResult = { ok: true; profile: Profile } | { ok: false; errors: string[] };
export type RulesResult = { ok: true; rules: RulesData } | { ok: false; errors: string[] };

const KINDS: readonly ProfileKind[] = ["ai", "saas"];
const PIPELINES: readonly PipelineName[] = ["ai-minimize", "field-protect"];
const AUTHORS: readonly AuthorBy[] = ["builtin", "user", "on_device", "in_cloud"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;
/** Letters, digits and - . _ ~ / : % plus * for wildcards. Nothing else can appear in a path glob. */
const SAFE_GLOB = /^[A-Za-z0-9\-._~/:%*]+$/;
const CONTENT_TYPE = /^[a-z0-9.+-]+(\/[a-z0-9.+-]*)?$/i;
const PARAM_KEY = /^[A-Za-z0-9_]{1,40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

function validateHosts(value: unknown, at: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${at}: must be an array of host names`);
    return [];
  }
  if (value.length > MAX_HOSTS) errors.push(`${at}: at most ${MAX_HOSTS} hosts are allowed`);
  const out: string[] = [];
  value.slice(0, MAX_HOSTS).forEach((h, i) => {
    if (typeof h !== "string") errors.push(`${at}[${i}]: must be a string`);
    else if (h.includes("*")) errors.push(`${at}[${i}]: wildcard hosts are not allowed, name the exact host`);
    else if (!HOST.test(h.toLowerCase())) errors.push(`${at}[${i}]: "${h}" is not a host name (letters, digits, dots, hyphens and an optional :port)`);
    else out.push(h.toLowerCase());
  });
  return out;
}

function validateMatch(value: unknown, errors: string[]): ProfileMatch {
  const match: ProfileMatch = { hosts: [], paths: [] };
  if (!isRecord(value)) {
    errors.push("match: must be an object");
    return match;
  }
  match.hosts = validateHosts(value.hosts, "match.hosts", errors);

  if (!Array.isArray(value.paths) || value.paths.length === 0) errors.push("match.paths: must be a non-empty array of path globs");
  else {
    if (value.paths.length > MAX_PATHS) errors.push(`match.paths: at most ${MAX_PATHS} paths are allowed`);
    value.paths.slice(0, MAX_PATHS).forEach((p, i) => {
      if (typeof p !== "string") errors.push(`match.paths[${i}]: must be a string`);
      else if (!p.startsWith("/")) errors.push(`match.paths[${i}]: a path glob must start with /`);
      else if (p.length > 200) errors.push(`match.paths[${i}]: longer than 200 characters`);
      else if (!SAFE_GLOB.test(p)) errors.push(`match.paths[${i}]: only letters, digits, - . _ ~ / : % and * are allowed in a path glob`);
      else match.paths.push(p);
    });
  }

  if (value.methods !== undefined) {
    if (!Array.isArray(value.methods)) errors.push("match.methods: must be an array of HTTP methods");
    else {
      const methods: string[] = [];
      value.methods.forEach((m, i) => {
        if (typeof m !== "string" || !METHODS.includes(m.toUpperCase())) errors.push(`match.methods[${i}]: must be one of ${METHODS.join(", ")}`);
        else methods.push(m.toUpperCase());
      });
      match.methods = methods;
    }
  }
  if (value.contentTypes !== undefined) {
    if (!Array.isArray(value.contentTypes)) errors.push("match.contentTypes: must be an array of content-type prefixes");
    else {
      const types: string[] = [];
      value.contentTypes.forEach((c, i) => {
        if (typeof c !== "string" || !CONTENT_TYPE.test(c)) errors.push(`match.contentTypes[${i}]: must look like application/json`);
        else types.push(c.toLowerCase());
      });
      match.contentTypes = types;
    }
  }
  return match;
}

function validateFlow(value: unknown, at: string, errors: string[]): FlowSpec | undefined {
  if (!isRecord(value)) {
    errors.push(`${at}: must be an object with an action`);
    return undefined;
  }
  let action: Action | undefined;
  if (!oneOf(ACTIONS, value.action)) errors.push(`${at}.action: must be one of ${ACTIONS.join(", ")}`);
  else action = value.action;
  let params: FlowParams | undefined;
  if (value.params !== undefined) {
    if (!isRecord(value.params)) errors.push(`${at}.params: must be an object`);
    else {
      const entries = Object.entries(value.params);
      if (entries.length > 16) errors.push(`${at}.params: at most 16 parameters are allowed`);
      params = {};
      for (const [k, v] of entries.slice(0, 16)) {
        if (!PARAM_KEY.test(k) || FORBIDDEN_KEYS.has(k)) errors.push(`${at}.params: "${k}" is not an allowed parameter name`);
        else if (typeof v === "string" && v.length <= 200) params[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") params[k] = v;
        else errors.push(`${at}.params.${k}: must be a short string, number or boolean`);
      }
    }
  }
  if (!action) return undefined;
  return params ? { action, params } : { action };
}

function validateFields(value: unknown, at: string, errors: string[], restrictAllow = false): FieldSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${at}: must be an array`);
    return [];
  }
  if (value.length > MAX_FIELDS) errors.push(`${at}: ${value.length} fields exceed the cap of ${MAX_FIELDS}`);
  const out: FieldSpec[] = [];
  value.slice(0, MAX_FIELDS).forEach((f, i) => {
    const here = `${at}[${i}]`;
    if (!isRecord(f)) {
      errors.push(`${here}: must be an object`);
      return;
    }
    const before = errors.length;
    const field: FieldSpec = { path: "" };
    if (typeof f.path !== "string") errors.push(`${here}.path: must be a string locator such as $.properties.email`);
    else {
      try {
        const segments = parsePath(f.path);
        if (segments.length > MAX_DEPTH) errors.push(`${here}.path: depth ${segments.length} exceeds the cap of ${MAX_DEPTH}`);
        else field.path = f.path;
      } catch (err) {
        errors.push(`${here}.path: ${err instanceof PathError ? err.message : "not a valid locator"}`);
      }
    }
    if (f.category !== undefined) {
      if (!oneOf(CATEGORIES, f.category)) errors.push(`${here}.category: must be one of ${CATEGORIES.join(", ")}`);
      else field.category = f.category as Category;
    }
    if (f.flow !== undefined) {
      const flow = validateFlow(f.flow, `${here}.flow`, errors);
      if (flow) field.flow = flow;
      // A model-authored profile may let a value through unchanged only when it declares the field non_sensitive.
      if (restrictAllow && flow?.action === "allow" && field.category !== "non_sensitive") {
        errors.push(
          `${here}.flow.action: allow-on-sensitive-category: an authored profile may use allow only on a field declared non_sensitive (this one is ${field.category ?? "undeclared"}); choose mask, token, surrogate, drop or block`,
        );
      }
    }
    if (errors.length === before) out.push(field);
  });
  return out;
}

/**
 * Validate untrusted profile JSON (stored, user edited or model written). Collects every error, each
 * prefixed by the field path it is about. On success returns a freshly built profile: unknown keys are
 * dropped and nothing from the input object is reused. An invalid profile is never partially applied.
 */
export function validateProfile(input: unknown): ProfileResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["profile: must be a JSON object"] };

  if (input.version !== 1) errors.push("version: must be 1");
  if (typeof input.id !== "string" || !ID.test(input.id)) errors.push("id: must be 1-64 letters, digits, dots, hyphens or underscores");
  if (typeof input.name !== "string" || input.name.trim() === "" || input.name.length > 120) errors.push("name: must be 1-120 characters");
  if (!oneOf(KINDS, input.kind)) errors.push(`kind: must be one of ${KINDS.join(", ")}`);
  if (!oneOf(PIPELINES, input.pipeline)) errors.push(`pipeline: must be one of ${PIPELINES.join(", ")}`);

  const match = validateMatch(input.match, errors);

  const authoredByModel = isRecord(input.author) && (input.author.by === "on_device" || input.author.by === "in_cloud");
  let requestFields: FieldSpec[] = [];
  if (!isRecord(input.request)) errors.push("request: must be an object with a fields array");
  else requestFields = validateFields(input.request.fields, "request.fields", errors, authoredByModel);
  let responseFields: FieldSpec[] = [];
  if (input.response !== undefined) {
    if (!isRecord(input.response)) errors.push("response: must be an object with a fields array");
    else responseFields = validateFields(input.response.fields, "response.fields", errors, authoredByModel);
  }
  if (requestFields.length + responseFields.length > MAX_FIELDS) {
    errors.push(`fields: request and response together exceed the cap of ${MAX_FIELDS}`);
  }

  let by: AuthorBy = "user";
  let at = "";
  if (!isRecord(input.author)) errors.push("author: must be an object {by, at}");
  else {
    if (!oneOf(AUTHORS, input.author.by)) errors.push(`author.by: must be one of ${AUTHORS.join(", ")}`);
    else by = input.author.by;
    if (typeof input.author.at !== "string" || input.author.at.length > 40 || Number.isNaN(Date.parse(input.author.at))) {
      errors.push("author.at: must be an ISO date-time string");
    } else at = input.author.at;
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    profile: {
      version: 1,
      id: input.id as string,
      name: (input.name as string).trim(),
      kind: input.kind as ProfileKind,
      pipeline: input.pipeline as PipelineName,
      match,
      request: { fields: requestFields },
      response: { fields: responseFields },
      author: { by, at },
    },
  };
}

/** Same discipline for destination rules: all errors collected, prefixed by field path, nothing partial. */
export function validateRules(input: unknown): RulesResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["rules: must be a JSON object"] };
  if (input.version !== 1) errors.push("version: must be 1");
  const destinations: Destination[] = [];
  if (!Array.isArray(input.destinations)) errors.push("destinations: must be an array");
  else {
    if (input.destinations.length > MAX_DESTINATIONS) errors.push(`destinations: at most ${MAX_DESTINATIONS} destinations are allowed`);
    input.destinations.slice(0, MAX_DESTINATIONS).forEach((d, i) => {
      const here = `destinations[${i}]`;
      if (!isRecord(d)) {
        errors.push(`${here}: must be an object`);
        return;
      }
      const before = errors.length;
      if (typeof d.id !== "string" || !ID.test(d.id)) errors.push(`${here}.id: must be 1-64 letters, digits, dots, hyphens or underscores`);
      const match: Destination["match"] = {};
      if (!isRecord(d.match)) errors.push(`${here}.match: must be an object`);
      else {
        if (d.match.kind !== undefined) {
          if (!oneOf(KINDS, d.match.kind)) errors.push(`${here}.match.kind: must be one of ${KINDS.join(", ")}`);
          else match.kind = d.match.kind;
        }
        if (d.match.hosts !== undefined) match.hosts = validateHosts(d.match.hosts, `${here}.match.hosts`, errors);
      }
      if (d.approval !== "ask" && d.approval !== "auto") errors.push(`${here}.approval: must be ask or auto`);
      const defaults: Destination["defaults"] = {};
      if (!isRecord(d.defaults)) errors.push(`${here}.defaults: must be an object of category to action`);
      else {
        for (const [cat, action] of Object.entries(d.defaults)) {
          if (!oneOf(CATEGORIES, cat)) errors.push(`${here}.defaults.${cat}: not a category (${CATEGORIES.join(", ")})`);
          else if (!oneOf(ACTIONS, action)) errors.push(`${here}.defaults.${cat}: must be one of ${ACTIONS.join(", ")}`);
          else defaults[cat as Category] = action;
        }
      }
      if (d.allowReads !== undefined && typeof d.allowReads !== "boolean") errors.push(`${here}.allowReads: must be true or false`);
      if (d.allowReads === true && match.hosts === undefined) errors.push(`${here}.allowReads: only a rule that names hosts can allow reads, never a whole kind of host`);
      if (d.inline !== undefined && typeof d.inline !== "boolean") errors.push(`${here}.inline: must be true or false`);
      if (d.inline === true && match.kind === "ai") errors.push(`${here}.inline: an AI destination always asks and can never be inline`);
      if (errors.length === before) {
        destinations.push({
          id: d.id as string,
          match,
          approval: d.approval as Destination["approval"],
          defaults,
          ...(d.allowReads === true ? { allowReads: true } : {}),
          ...(typeof d.inline === "boolean" ? { inline: d.inline } : {}),
        });
      }
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  const viewer = isRole(input.viewer) ? { viewer: input.viewer } : {};
  return { ok: true, rules: { version: 1, destinations, ...viewer } };
}
