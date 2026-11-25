import { detect } from "../core/detect.js";
import { matchProfile } from "../profiles/match.js";
import type { AuthorBy, Category, DryRun, DryRunResult, DryRunSample, Profile, RulesData } from "../profiles/types.js";
import { MAX_FIELDS, validateProfile } from "../profiles/validate.js";
import { wildcardPath, type Capture } from "./capture.js";
import type { Classification } from "./classify.js";
import { extractJsonObject } from "../ai/local.js";
import { assertStructureOnly, buildAuthoringPrompt, MIN_CHECKED_LENGTH, StructureLeakError, type PromptLeaf } from "./prompt.js";

/**
 * Authoring a profile from captured structure. The model's reply is data: it is only JSON-parsed, copied field
 * by field through a whitelist, validated, scope-checked and dry-run. It is never executed and never trusted.
 */

export interface AuthoringModelLike {
  generateContent(prompt: string): Promise<{ response: { text(): string; inferenceSource?: string } }>;
}

export interface BeforeCall {
  (call: { prompt: string; generationConfig: unknown; model: string }): () => void;
}

export interface AuthorInput {
  capture: Capture;
  classification: Classification;
  /** Host with an optional port, as the matcher sees it. Defaults to the capture's host. */
  host?: string;
  method?: string;
  path?: string;
  model: AuthoringModelLike;
  /** Model name and generation config exactly as the SDK will send them, for the structure-only release. */
  modelName?: string;
  generationConfig?: unknown;
  dryRun: DryRun;
  rules?: RulesData;
  /** Registers the call with the engine's structure-only seam and returns the release. */
  beforeCall?: BeforeCall;
  now?: () => Date;
}

export interface AuthorResult {
  status: "ready" | "rejected";
  profile?: Profile;
  /**
   * When the answer was valid JSON that passed validation and scope but failed the dry run: the draft, so the user can
   * correct fields in the editor. It is never saved as it is: Approve vets it again and refuses while it fails.
   */
  draft?: Profile;
  errors: string[];
  /** The exact prompt that was (or would have been) sent. */
  prompt: string;
  /** The SDK-reported source of the call that produced the profile. */
  source?: "on_device" | "in_cloud";
  latencyMs: number;
  calls: number;
  dryRun?: DryRunResult;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const classMap = (c: Classification): Map<string, Category> => new Map(c.fields.map((f) => [`${f.side} ${f.path}`, f.class]));

export function promptLeaves(capture: Capture, classification: Classification): PromptLeaf[] {
  const cls = classMap(classification);
  return capture.leaves().map((l) => ({
    side: l.side,
    path: wildcardPath(l.path),
    valueType: l.valueType,
    class: cls.get(`${l.side} ${l.path}`) ?? "non_sensitive",
    preview: l.preview,
  }));
}

/** Every captured value and every data-looking key, for the structure-only assertion. */
export function checkedValues(capture: Capture): Array<{ path: string; value: string }> {
  return [...capture.entries().map((e) => ({ path: e.path, value: e.value })), ...capture.dataLikeKeys().map((k) => ({ path: "(object key)", value: k }))];
}

/** The dry-run sample: the captured request and response and the values the classifier marked sensitive. */
export function dryRunSample(capture: Capture, classification: Classification): DryRunSample {
  const cls = classMap(classification);
  return {
    request: capture.request(),
    response: capture.response(),
    sensitive: capture
      .entries()
      .filter((e) => e.side === "request" && (cls.get(`request ${e.path}`) ?? "non_sensitive") !== "non_sensitive")
      .map((e) => ({ path: e.path, value: e.value })),
  };
}

const strings = (v: unknown, max: number): string[] | undefined => (Array.isArray(v) ? v.slice(0, max).filter((x): x is string => typeof x === "string") : undefined);

function copyFlow(v: unknown): unknown {
  if (!isRecord(v)) return v;
  const flow: Record<string, unknown> = { action: v.action };
  if (isRecord(v.params)) {
    const params: Record<string, string | number | boolean> = {};
    for (const [k, val] of Object.entries(v.params).slice(0, 17)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") params[k] = val;
    }
    flow.params = params;
  }
  return flow;
}

function copyFields(v: unknown): unknown[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_FIELDS + 1).map((f) => {
    if (!isRecord(f)) return f;
    const out: Record<string, unknown> = { path: f.path };
    if (f.category !== undefined) out.category = f.category;
    if (f.flow !== undefined) out.flow = copyFlow(f.flow);
    return out;
  });
}

function slug(host: string): string {
  return host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

interface Whitelisted {
  candidate: Record<string, unknown>;
  errors: string[];
}

/** Copy only known fields out of the model's object into a fresh Profile v1 candidate. Model objects are never spread or reused. */
function whitelist(raw: unknown, ctx: { host: string; by: AuthorBy; at: string; fallbackName: string }): Whitelisted {
  const errors: string[] = [];
  if (!isRecord(raw)) return { candidate: {}, errors: ["profile: the model did not return a JSON object"] };

  if (raw.pipeline !== undefined && raw.pipeline !== "field-protect") {
    errors.push(`pipeline: "${String(raw.pipeline).slice(0, 40)}" is not allowed for an authored profile, it must be field-protect`);
  }
  const m = isRecord(raw.match) ? raw.match : {};
  // The prompt never names the host, so the model writes the placeholder HOST (or omits hosts) and the code
  // substitutes the captured host. Any other host is an attempt to widen the scope.
  let hosts = strings(m.hosts, 21) ?? [ctx.host];
  if (hosts.length === 1 && hosts[0] === "HOST") hosts = [ctx.host];
  if (hosts.length !== 1 || hosts[0].toLowerCase() !== ctx.host) {
    errors.push("match.hosts: must be exactly the captured host (write HOST); an authored profile cannot widen its scope");
  }
  const match: Record<string, unknown> = { hosts, paths: strings(m.paths, 51) ?? [] };
  const methods = strings(m.methods, 10);
  if (methods) match.methods = methods;
  const contentTypes = strings(m.contentTypes, 10);
  if (contentTypes) match.contentTypes = contentTypes;

  const req = isRecord(raw.request) ? raw.request : {};
  const res = isRecord(raw.response) ? raw.response : {};
  return {
    errors,
    candidate: {
      version: 1,
      id: `authored-${slug(ctx.host)}`,
      name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.slice(0, 120) : ctx.fallbackName,
      kind: raw.kind === "ai" ? "ai" : "saas",
      pipeline: "field-protect",
      match,
      request: { fields: copyFields(req.fields) },
      response: { fields: copyFields(res.fields) },
      author: { by: ctx.by, at: ctx.at },
    },
  };
}

/** Vet a candidate against validation, scope and the dry run. Returns the profile or the failures, never both. */
export async function vetProfile(
  candidate: unknown,
  ctx: { capture: Capture; classification: Classification; host: string; method: string; path: string; dryRun: DryRun; rules?: RulesData },
): Promise<{ profile?: Profile; draft?: Profile; errors: string[]; dryRun?: DryRunResult }> {
  const v = validateProfile(candidate);
  if (!v.ok) return { errors: v.errors };
  const profile = v.profile;
  const hit = matchProfile([profile], { host: ctx.host, path: ctx.path, method: ctx.method, contentType: ctx.capture.contentType });
  if (!hit) return { errors: [`match: the profile does not match the captured request (${ctx.method} ${ctx.path})`] };
  const sample = dryRunSample(ctx.capture, ctx.classification);
  if (sample.request === undefined) return { errors: ["capture: the captured values were already cleared, so the dry run cannot run"] };
  const dry = await ctx.dryRun(profile, sample, ctx.rules);
  if (!dry.ok) return { errors: dry.failures, dryRun: dry, draft: profile };
  return { profile, errors: [], dryRun: dry };
}

/** Raw reply cap before anything is parsed. */
export const MAX_RAW_BYTES = 64 * 1024;
const WITHHELD = "(not shown: it would contain a captured value)";
const ATTEMPTS = 2;

/** True when any captured value of four or more characters appears in the text (case-insensitive). */
function carriesValue(text: string, values: ReadonlyArray<{ value: string }>): boolean {
  const lower = text.toLowerCase();
  return values.some(({ value }) => {
    const v = value.trim().toLowerCase();
    return v.length >= MIN_CHECKED_LENGTH && lower.includes(v);
  });
}

/**
 * Author a profile. Model output is data, never executed: it is size-capped, JSON-parsed, copied through a
 * whitelist, validated, scope-checked and dry-run. A failure on validation, scope or the dry run gets exactly one
 * feedback retry (paths and rules only, re-asserted structure-only); a second failure is final.
 */
export async function authorProfile(input: AuthorInput): Promise<AuthorResult> {
  const { capture, classification, dryRun } = input;
  const host = (input.host ?? capture.host).toLowerCase();
  const method = (input.method ?? capture.method).toUpperCase();
  const path = input.path ?? capture.path;
  const now = input.now ?? (() => new Date());
  const values = checkedValues(capture);
  const leaves = promptLeaves(capture, classification);
  const generationConfig = input.generationConfig === undefined ? undefined : JSON.parse(JSON.stringify(input.generationConfig));

  let calls = 0;
  let latencyMs = 0;
  let prompt = "";
  let source: AuthorResult["source"];
  let errors: string[] = [];
  let lastDry: DryRunResult | undefined;
  let lastDraft: Profile | undefined;
  const done = (r: Partial<AuthorResult> = {}): AuthorResult => ({ status: "rejected", errors, prompt, latencyMs, calls, source, dryRun: lastDry, draft: lastDraft, ...r });

  let feedback: string[] | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const built = buildAuthoringPrompt({ host, method, path, leaves, feedback });
    try {
      assertStructureOnly(built, values);
    } catch (err) {
      if (err instanceof StructureLeakError) {
        errors = [`prompt: ${err.message}`];
        return done({ prompt: WITHHELD });
      }
      throw err;
    }
    if (detect(built).length > 0) {
      errors = ["prompt: a detector found sensitive-looking text in the prompt. No model call was made."];
      return done({ prompt: WITHHELD });
    }
    prompt = built;

    const release = input.beforeCall?.({ prompt, generationConfig, model: input.modelName ?? "unknown" });
    const started = Date.now();
    let reply;
    calls++;
    try {
      reply = await input.model.generateContent(prompt);
    } catch (err) {
      latencyMs += Date.now() - started;
      errors = [`model: the authoring call failed (${err instanceof Error ? err.message : String(err)})`];
      return done();
    } finally {
      release?.();
    }
    latencyMs += Date.now() - started;

    const reported = reply.response.inferenceSource;
    if (reported !== "on_device" && reported !== "in_cloud") {
      errors = [`model: the SDK reported inference source "${String(reported).slice(0, 30)}", so the answer was not used`];
      return done();
    }
    source = reported;

    const text = reply.response.text();
    if (text.length > MAX_RAW_BYTES) {
      errors = [`model: the answer is oversized (${text.length} characters, the cap is ${MAX_RAW_BYTES}) and was not parsed`];
      return done();
    }

    errors = [];
    lastDry = undefined;
    lastDraft = undefined;
    const raw = extractJsonObject(text);
    if (raw === null) {
      errors = ["model: the answer was not valid JSON (one JSON object was expected)"];
    } else {
      const w = whitelist(raw, { host, by: reported, at: now().toISOString(), fallbackName: `${host} ${method} ${path}`.slice(0, 120) });
      if (w.errors.length > 0) errors = w.errors;
      else {
        const vetted = await vetProfile(w.candidate, { capture, classification, host, method, path, dryRun, rules: input.rules });
        lastDry = vetted.dryRun;
        lastDraft = vetted.draft;
        if (vetted.profile && vetted.errors.length === 0) return done({ status: "ready", profile: vetted.profile, errors: [] });
        errors = vetted.errors;
      }
    }
    // A failure text that carries a captured value is withheld, so neither the retry prompt nor the panel shows it.
    errors = errors.map((e) => (carriesValue(e, values) ? "dry run: a failure message was withheld because it contained a captured value" : e));
    feedback = errors;
  }
  return done();
}
