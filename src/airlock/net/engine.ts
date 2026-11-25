import type { AuditLog } from "../core/audit.js";
import { detect } from "../core/detect.js";
import type { Analyzer } from "../core/types.js";
import { FlowState } from "../flows/state.js";
import { isReadWithoutBody, type ReadPipeline } from "../flows/read.js";
import { isInlineDestination, runInlineMask } from "../flows/inline.js";
import { resolveDestination } from "../flows/rules.js";
import { ShapeLog } from "../learn/shape.js";
import { canonicalHost, hostMatches, inScope, matchProfile } from "../profiles/match.js";
import { memoryKV, type KVStore } from "../profiles/storage.js";
import type { Destination, Profile, RulesData } from "../profiles/types.js";
import type { AirlockStore } from "./store.js";

/**
 * The transport-agnostic core. An adapter (fetch, XMLHttpRequest, later an extension) normalizes what the
 * page is about to send, asks the engine, and either lets it pass, aborts it, or sends the protected body
 * the engine returned and hands the answer back through onResponse. No DOM, no page assumptions.
 */

export type BodyKind = "none" | "text" | "unsupported";

export interface NormalizedRequest {
  transport: "fetch" | "xhr";
  /** Absolute URL. */
  url: string;
  /** URL host: hostname plus the port when it is not the default. */
  host: string;
  /** URL pathname, query excluded. */
  path: string;
  /** Upper case. */
  method: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  contentType: string;
  body: string | null;
  bodyKind: BodyKind;
  /** Name of the unsupported body type (FormData, Blob ...), for the visible block reason. */
  bodyType?: string;
}

export type Outcome =
  | { kind: "pass" }
  | { kind: "block"; reason: string }
  | {
      kind: "protect";
      /** The body that may leave. Null when the request has none (a GET). */
      body: string | null;
      /** Inline mode only: the URL with detected values tokenized. Absent means the URL is sent as it is. */
      url?: string;
      /** Called once with the real answer; returns the text the page receives. Synchronous so XHR can use it. */
      onResponse(status: number, text: string, latencyMs: number): string;
      /** Called once when the protected send itself fails. */
      onError(err: unknown): void;
    };

export interface EngineContext {
  store: AirlockStore;
  audit: AuditLog;
  analyzer: Analyzer | null;
  maxChars?: number;
  autoApprove?: boolean;
  getProtectedTerms(): string[];
  /** Vault, surrogate session and token index shared by every request of this engine. */
  flow?: FlowState;
  /** Destination rules: stored ones when valid, otherwise the defaults. */
  rules?: () => Promise<RulesData>;
}

export type Pipeline = (ctx: EngineContext, req: NormalizedRequest, profile: Profile) => Promise<Outcome>;

/** What the engine needs from a profile registry. ProfileRegistry satisfies it. */
export interface ProfileSource {
  ready: Promise<void>;
  /** Profiles in matching order: stored and authored first, built-ins last. */
  all(): readonly Profile[];
}

export interface StructureOnlySpec {
  /** The value-free authoring prompt, exactly as the SDK will send it. */
  prompt: string;
  generationConfig?: unknown;
  /** Model name, for example gemini-2.5-flash. */
  model: string;
  ttlMs?: number;
}

export type HoldDecision = "pass-through" | "saved" | "discarded";

/**
 * What the engine needs from an inspection session store (InspectionStore satisfies it). Kept as an interface
 * so the engine does not import the authoring code: the model-calling modules stay out of the request path.
 */
export interface InspectionPort {
  /** Hosts with inspection on: an in-scope request to one of them that no profile matches is held, not blocked. */
  hosts: readonly string[];
  capture(req: { host: string; method: string; path: string; contentType?: string; request: unknown }): { id: string; decision: Promise<HoldDecision> };
  /** Add the observed response of a request that was passed through once. */
  attachResponse(id: string, body: unknown): void;
  get(id: string): { leaves: readonly unknown[]; profile?: Profile } | undefined;
}

export interface EngineOptions extends Omit<EngineContext, "getProtectedTerms" | "flow"> {
  source: ProfileSource;
  /** Where the vault and the token key persist. Defaults to memory. */
  kv?: KVStore;
  /** Hosts that are in scope even when no profile names them. */
  scope?: string[];
  /**
   * Only the scope list decides what is in scope: a profile that names another host does not pull it in. The Chrome
   * extension sets this so requests to hosts the user did not configure are never touched. The one exception is a
   * registered structure-only authoring request to the Gemini host, which must still be scanned before it leaves.
   */
  scopeOnly?: boolean;
  pipelines: Record<string, Pipeline>;
  /** Releases a GET or HEAD with no body on a host whose destination rule allows reads. Absent: reads are never released this way. */
  readPipeline?: ReadPipeline;
  getProtectedTerms?: () => string[];
}

export interface Engine {
  ready: Promise<void>;
  isReady(): boolean;
  isInScope(host: string): boolean;
  process(req: NormalizedRequest): Promise<Outcome>;
  /** Record a block that an adapter decided on, so it is visible in the inspector and the audit. */
  reject(req: NormalizedRequest, reason: string): Outcome;
  /** Release exactly one request that equals this value-free authoring prompt. Returns a cancel function. */
  allowStructureOnly(spec: StructureOnlySpec): () => void;
  /** Forget every protected value (vault, surrogates, token index and key). Restore afterwards leaves them as they are. */
  clearLocalData(): Promise<void>;
  /** Turn inspection on (a port) or off (null). Late-bound because the inspection store needs this engine's allowStructureOnly. */
  setInspection(port: InspectionPort | null): void;
  /** Value-free shapes of the 2xx JSON answers this engine handled, memory only, for proposing response locators. */
  observations: ShapeLog;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let counter = 0;
export const newId = (): string => `req-${Date.now().toString(36)}-${++counter}`;

/** Resolve a possibly relative URL against the page, the way fetch and XHR do. Null when it is not a URL. */
export function resolveUrl(raw: string, base?: string): { url: string; host: string; path: string } | null {
  try {
    const b = base ?? (globalThis as { location?: { href?: string } }).location?.href;
    const u = new URL(raw, b);
    // The host is canonical (trailing dot and default port gone) so scope never depends on how it was spelled.
    return { url: u.href, host: canonicalHost(u.host), path: u.pathname };
  } catch {
    return null;
  }
}

function isInstance(value: unknown, name: string): boolean {
  const ctor = (globalThis as Record<string, unknown>)[name];
  return typeof ctor === "function" && value instanceof (ctor as new (...a: never[]) => object);
}

/** Names the body types the engine cannot inspect, so the block reason can say which one it was. */
export function unsupportedBodyType(body: unknown): string | null {
  for (const name of ["FormData", "Blob", "ArrayBuffer", "URLSearchParams", "ReadableStream"]) {
    if (isInstance(body, name)) return name;
  }
  if (typeof body === "object" && body !== null && ArrayBuffer.isView(body)) return "ArrayBuffer view";
  return null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function escapeForPath(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface StructureOnlyEntry {
  prompt: string;
  generationConfig: unknown;
  model: string;
  expiresAt: number;
}

const STRUCTURE_ONLY_TTL_MS = 60_000;

/** True only when every leaf of the request is fixed by equality with the registration. */
function releasesStructureOnly(entry: StructureOnlyEntry, req: NormalizedRequest, hosts: readonly string[]): boolean {
  if (req.method !== "POST" || req.bodyKind !== "text" || req.body === null) return false;
  if (!hosts.some((h) => canonicalHost(h) === canonicalHost(req.host))) return false;
  const model = entry.model.replace(/^models\//, "");
  const endpoint = new RegExp(`^/v1(?:beta)?/projects/[A-Za-z0-9_-]+/(?:locations/[A-Za-z0-9_-]+/publishers/google/)?models/${escapeForPath(model)}:generateContent$`);
  if (!endpoint.test(req.path)) return false;
  let body: unknown;
  try {
    body = JSON.parse(req.body);
  } catch {
    return false;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const obj = body as Record<string, unknown>;
  const allowedTop = new Set(["contents", "generationConfig", "safetySettings"]);
  if (!Object.keys(obj).every((k) => allowedTop.has(k))) return false;
  if ("safetySettings" in obj && !(Array.isArray(obj.safetySettings) && obj.safetySettings.length === 0)) return false;
  if (!Array.isArray(obj.contents) || obj.contents.length !== 1) return false;
  const content = obj.contents[0] as Record<string, unknown> | null;
  if (!content || typeof content !== "object") return false;
  if (!Object.keys(content).every((k) => k === "role" || k === "parts")) return false;
  if ("role" in content && content.role !== "user") return false;
  const parts = content.parts;
  if (!Array.isArray(parts) || parts.length !== 1) return false;
  const part = parts[0] as Record<string, unknown> | null;
  if (!part || typeof part !== "object") return false;
  if (Object.keys(part).length !== 1 || part.text !== entry.prompt) return false;
  if (entry.generationConfig === undefined) return !("generationConfig" in obj);
  return deepEqual(obj.generationConfig, entry.generationConfig);
}

export function createEngine(options: EngineOptions): Engine {
  const { source } = options;
  const flow = new FlowState();
  const ctx: EngineContext = {
    store: options.store,
    audit: options.audit,
    analyzer: options.analyzer,
    maxChars: options.maxChars,
    autoApprove: options.autoApprove,
    getProtectedTerms: options.getProtectedTerms ?? (() => []),
    flow,
    rules: options.rules,
  };
  const scope = options.scope ?? [];
  let ready = false;
  // The restore state must be loaded before the first decision, alongside the stored profiles.
  const allReady = Promise.all([source.ready, flow.load(options.kv ?? memoryKV())]).then(() => {
    ready = true;
  });
  const structureOnly: StructureOnlyEntry[] = [];
  const observations = new ShapeLog();
  let readHostsInForce = "";

  /** Keep the shape (never a value) of a 2xx JSON answer before the pipeline's own handling of it. */
  function observe(req: NormalizedRequest, outcome: Outcome): Outcome {
    if (outcome.kind !== "protect") return outcome;
    const inner = outcome.onResponse.bind(outcome);
    return {
      ...outcome,
      onResponse(status, text, latencyMs) {
        observations.record({ host: req.host, method: req.method, path: req.path, status, text });
        return inner(status, text, latencyMs);
      },
    };
  }

  /**
   * The destination rule that lets this read through, or null. Only a GET or HEAD with no body, only a rule that
   * names the request's host, only when the user set it. A rules read that fails means no (fail closed). Each time
   * the set of allowed hosts differs from what was last in force, the change is written to the audit log.
   */
  async function readRule(req: NormalizedRequest): Promise<Destination | null> {
    if (!options.readPipeline || !ctx.rules || !isReadWithoutBody(req)) return null;
    let rules: RulesData;
    try {
      rules = await ctx.rules();
    } catch {
      return null;
    }
    const allowed = rules.destinations.filter((d) => d.allowReads === true && (d.match.hosts?.length ?? 0) > 0);
    const hosts = allowed.flatMap((d) => d.match.hosts ?? []).map(canonicalHost).sort().join(", ");
    if (hosts !== readHostsInForce) {
      ctx.audit.add({ kind: "read-policy", requestId: "settings", where: "code", detail: { state: hosts === "" ? "off" : "on", hosts: hosts === "" ? readHostsInForce : hosts } });
      readHostsInForce = hosts;
    }
    return allowed.find((d) => d.match.hosts?.some((h) => hostMatches(h, req.host))) ?? null;
  }

  const isInScope = (host: string): boolean => {
    if (!options.scopeOnly) return inScope(host, source.all(), scope);
    if (scope.some((s) => hostMatches(s, host))) return true;
    const gemini = source.all().find((p) => p.id === "gemini-generate-content");
    return structureOnly.length > 0 && (gemini?.match.hosts ?? []).some((h) => hostMatches(h, host));
  };

  function reject(req: NormalizedRequest, reason: string): Outcome {
    const id = newId();
    ctx.store.create({
      id,
      createdAt: Date.now(),
      url: req.url,
      host: req.host,
      status: "blocked",
      shape: "unknown",
      task: "",
      originalDocument: "",
      clauses: [],
      message: reason,
    });
    ctx.audit.add({ kind: "blocked", requestId: id, where: "code", detail: { reason } });
    return { kind: "block", reason };
  }

  function takeStructureOnly(req: NormalizedRequest): StructureOnlyEntry | null {
    const now = Date.now();
    for (let i = structureOnly.length - 1; i >= 0; i--) if (structureOnly[i].expiresAt <= now) structureOnly.splice(i, 1);
    const gemini = source.all().find((p) => p.id === "gemini-generate-content");
    const hosts = gemini?.match.hosts ?? [];
    const at = structureOnly.findIndex((e) => releasesStructureOnly(e, req, hosts));
    if (at === -1) return null;
    return structureOnly.splice(at, 1)[0];
  }

  let inspection: InspectionPort | null = null;

  /**
   * Inspection hold: an unprofiled request to a host with inspection on is captured in memory and goes nowhere
   * until the user decides. Saving a profile still sends nothing: the page is told to send again, so the request
   * that leaves is the one the saved profile protects. Only the explicit one-time pass-through releases the
   * original body, and the audit records it as an unprotected send.
   */
  async function hold(req: NormalizedRequest, port: InspectionPort): Promise<Outcome> {
    const text = req.body ?? "";
    let parsed: unknown = {};
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        return reject(req, `The request body to ${req.host} is not JSON, so AIRLOCK cannot inspect it. Nothing was sent.`);
      }
    }
    const id = newId();
    const held = port.capture({ host: req.host, method: req.method, path: req.path, contentType: req.contentType || undefined, request: parsed });
    ctx.store.create({
      id,
      createdAt: Date.now(),
      url: req.url,
      host: req.host,
      status: "inspecting",
      shape: "unknown",
      task: "",
      originalDocument: "",
      clauses: [],
      message: "Held for inspection. Nothing was sent.",
    });
    ctx.audit.add({
      kind: "inspection-held",
      requestId: id,
      where: "code",
      detail: { host: req.host, method: req.method, path: req.path, leaves: port.get(held.id)?.leaves.length ?? 0 },
    });

    const decision = await held.decision;
    if (decision === "saved") {
      const profile = port.get(held.id)?.profile;
      const message = "Profile saved. Send the request again to use it.";
      ctx.store.update(id, { status: "denied", message });
      ctx.audit.add({
        kind: "profile-saved",
        requestId: id,
        where: "code",
        detail: { profileId: profile?.id ?? "unknown", author: profile?.author.by ?? "unknown", fields: profile?.request.fields.length ?? 0 },
      });
      return { kind: "block", reason: message };
    }
    if (decision === "discarded") {
      const message = "Inspection discarded. Nothing was sent.";
      ctx.store.update(id, { status: "denied", message });
      ctx.audit.add({ kind: "blocked", requestId: id, where: "code", detail: { reason: message } });
      return { kind: "block", reason: message };
    }

    // The one-time pass-through: the user clicked the warned button. The original body leaves, unprotected.
    const bytes = new TextEncoder().encode(text).length;
    ctx.store.update(id, { status: "sending", message: "Sent once, unprotected, because you chose to.", bytesSent: bytes });
    ctx.audit.add({ kind: "unprotected-send", requestId: id, where: "in_cloud", detail: { host: req.host, bytes, approvedOnce: true } });
    return {
      kind: "protect",
      body: req.body,
      onError(err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.store.update(id, { status: "failed", message: `The request failed after it was sent: ${message}` });
        ctx.audit.add({ kind: "error", requestId: id, where: "in_cloud", detail: { reason: message } });
      },
      onResponse(status, answer, latency) {
        ctx.store.update(id, { status: status >= 200 && status <= 299 ? "done" : "failed", cloudLatencyMs: latency });
        try {
          port.attachResponse(held.id, JSON.parse(answer));
        } catch {
          // Not JSON: nothing to attach. The answer goes back to the page unchanged either way.
        }
        return answer;
      },
    };
  }

  /** The inline destination for this request, or null. Never for a host an AI profile names, never when rules cannot be read. */
  async function inlineDestination(req: NormalizedRequest): Promise<Destination | null> {
    if (!ctx.rules || !ctx.flow) return null;
    if (source.all().some((p) => p.kind === "ai" && p.match.hosts.some((h) => hostMatches(h, req.host)))) return null;
    try {
      const dest = resolveDestination(await ctx.rules(), req.host, "saas");
      return isInlineDestination(dest) ? dest : null;
    } catch {
      return null;
    }
  }

  async function process(req: NormalizedRequest): Promise<Outcome> {
    await allReady;
    if (!isInScope(req.host)) return { kind: "pass" };
    // Who is viewing: the rules name the viewer role, and every answer restored from here on is shown as that role may see it.
    if (ctx.flow && ctx.rules) {
      try {
        ctx.flow.role = (await ctx.rules()).viewer ?? "owner";
      } catch {
        ctx.flow.role = "auditor"; // rules unreadable: show the least
      }
    }
    // CRM (inline) destinations never block or wait: an unprofiled or uncoverable request is masked by the detectors and sent.
    // On a host in Inspection the request is also captured, without waiting for a decision, so a profile can be authored
    // from it later and applied to future traffic. The request in flight is never held for that.
    const inlineDest = await inlineDestination(req);
    if (inlineDest && (req.bodyKind === "unsupported" || !matchProfile(source.all(), req))) {
      if (inspection && inspection.hosts.some((h) => hostMatches(h, req.host)) && req.bodyKind === "text") {
        try {
          const parsed: unknown = req.body && req.body.trim() !== "" ? JSON.parse(req.body) : {};
          void inspection.capture({ host: req.host, method: req.method, path: req.path, contentType: req.contentType || undefined, request: parsed }).decision.catch(() => undefined);
        } catch {
          // Not JSON: nothing to capture for authoring. The request is still masked and sent.
        }
      }
      return observe(req, await runInlineMask(ctx, req, inlineDest));
    }
    if (req.bodyKind === "unsupported") {
      return reject(req, `The request body is a ${req.bodyType ?? "non-text type"}, which AIRLOCK cannot inspect. Only text bodies to protected hosts are allowed.`);
    }

    const released = takeStructureOnly(req);
    if (released) {
      const hits = detect(released.prompt, { protectedTerms: ctx.getProtectedTerms() });
      if (hits.length > 0) {
        return reject(req, `The structure-only authoring prompt contains ${hits.length} sensitive value(s), so it was not released.`);
      }
      const body = req.body ?? "";
      const wireHash = await sha256Hex(body);
      ctx.audit.add({
        kind: "internal-authoring",
        requestId: newId(),
        where: "in_cloud",
        detail: { host: req.host, bytes: new TextEncoder().encode(body).length, wireHash },
      });
      return { kind: "pass" };
    }

    const profile = matchProfile(source.all(), req);
    if (!profile) {
      const readDest = await readRule(req);
      if (readDest && options.readPipeline) {
        const hostProfiles = source.all().filter((p) => p.match.hosts.some((h) => hostMatches(h, req.host)));
        return observe(req, await options.readPipeline(ctx, req, readDest, hostProfiles));
      }
      if (inspection && inspection.hosts.some((h) => hostMatches(h, req.host))) return observe(req, await hold(req, inspection));
      return reject(
        req,
        `No profile matches ${req.method} ${req.host}${req.path}; AIRLOCK blocks unprofiled requests to protected hosts.`,
      );
    }
    const pipeline = options.pipelines[profile.pipeline];
    if (!pipeline) return reject(req, `Profile "${profile.id}" needs the "${profile.pipeline}" pipeline, which is not available.`);
    const outcome = await pipeline(ctx, req, profile);
    return profile.pipeline === "ai-minimize" ? outcome : observe(req, outcome);
  }

  return {
    ready: allReady,
    isReady: () => ready,
    isInScope,
    process,
    reject,
    observations,
    clearLocalData: async () => {
      observations.clear();
      await flow.clear();
    },
    setInspection(port) {
      inspection = port;
    },
    allowStructureOnly(spec) {
      const entry: StructureOnlyEntry = {
        prompt: spec.prompt,
        generationConfig: spec.generationConfig,
        model: spec.model,
        expiresAt: Date.now() + (spec.ttlMs ?? STRUCTURE_ONLY_TTL_MS),
      };
      structureOnly.push(entry);
      return () => {
        const at = structureOnly.indexOf(entry);
        if (at !== -1) structureOnly.splice(at, 1);
      };
    },
  };
}
