import { AuditLog } from "../core/audit.js";
import type { Analyzer } from "../core/types.js";
import { runFieldProtect } from "../flows/protect.js";
import { runReadThrough } from "../flows/read.js";
import { DEFAULT_RULES, GEMINI_PROFILE, GENERIC_JSON_TEMPLATE } from "../profiles/builtins.js";
import { memoryKV, ProfileRegistry, type KVStore } from "../profiles/storage.js";
import type { Profile, RulesData } from "../profiles/types.js";
import { runAiMinimize } from "./ai-minimize.js";
import { createEngine, resolveUrl, unsupportedBodyType, type BodyKind, type Engine, type NormalizedRequest, type Pipeline } from "./engine.js";
import { AirlockStore } from "./store.js";

export { DEFAULT_GUARDED_HOSTS } from "../profiles/builtins.js";
export { INJECTED_LEAK } from "./ai-minimize.js";
export { sha256Hex } from "./engine.js";

export interface AirlockOptions {
  /** Hosts whose Gemini requests are held and inspected. Replaces the hosts of the built-in Gemini profile. */
  hosts?: string[];
  /** On-device clause chooser. Without one, the labelled keyword fallback is used. */
  analyzer?: Analyzer | null;
  protectedTerms?: string[];
  maxChars?: number;
  /** Tests only: approve automatically instead of waiting for the user. */
  autoApprove?: boolean;
  /** Tests only: the fetch to wrap and to forward approved requests to. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Profiles supplied by the host app. Validated like stored ones, never persisted. */
  profiles?: unknown[];
  /** Hosts that are protected even when no profile names them: with no matching profile they are blocked. */
  scope?: string[];
  /** Only `scope` decides what is in scope; profiles naming other hosts do not extend it (the Chrome extension). */
  scopeOnly?: boolean;
  /** Where profiles, rules and (later) the vault persist. Defaults to memory. */
  kv?: KVStore;
  /** Default destination rules, used when none are stored. */
  rules?: RulesData;
}

export interface AirlockHandle {
  store: AirlockStore;
  audit: AuditLog;
  engine: Engine;
  registry: ProfileRegistry;
  /** Profile and rules problems found on load, each prefixed by the offending field path. */
  profileErrors(): readonly string[];
  /** Destination rules: stored ones when valid, otherwise the defaults. */
  rules(): Promise<RulesData>;
  setProtectedTerms(terms: string[]): void;
  uninstall(): void;
}

/** Pipelines by profile.pipeline. */
const PIPELINES: Record<string, Pipeline> = {
  "ai-minimize": runAiMinimize,
  "field-protect": runFieldProtect,
};

const isRequest = (x: unknown): x is Request => typeof Request !== "undefined" && x instanceof Request;

function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (h === undefined || h === null) return out;
  new Headers(h).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Turn a fetch call (string, URL or Request, plus init) into the engine's normalized request. */
async function normalizeFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  where: { url: string; host: string; path: string },
): Promise<NormalizedRequest> {
  const method = (init?.method ?? (isRequest(input) ? input.method : "GET")).toUpperCase();
  // As in the fetch spec, init.headers replaces the Request's headers instead of merging with them.
  const headers = headerRecord(init?.headers !== undefined ? init.headers : isRequest(input) ? input.headers : undefined);
  let kind: BodyKind = "none";
  let body: string | null = null;
  let bodyType: string | undefined;
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === "string") {
      kind = "text";
      body = init.body;
    } else {
      kind = "unsupported";
      bodyType = unsupportedBodyType(init.body) ?? "non-text value";
    }
  } else if (isRequest(input) && input.body !== null) {
    if ((headers["content-type"] ?? "").startsWith("multipart/")) {
      kind = "unsupported";
      bodyType = "FormData";
    } else {
      kind = "text";
      body = await input.clone().text();
    }
  }
  return {
    transport: "fetch",
    url: where.url,
    host: where.host,
    path: where.path,
    method,
    headers,
    contentType: headers["content-type"] ?? "",
    body,
    bodyKind: kind,
    bodyType,
  };
}

/** Per-request settings that live on a Request object and must survive when the engine rebuilds the call. */
function requestDefaults(input: RequestInfo | URL): RequestInit {
  if (!isRequest(input)) return {};
  return {
    credentials: input.credentials,
    signal: input.signal,
    cache: input.cache,
    redirect: input.redirect,
    keepalive: input.keepalive,
    mode: input.mode === "navigate" ? undefined : input.mode,
  };
}

/**
 * Wrap fetch so every request to a protected host is held and run through the profile engine: Gemini
 * through its built-in pipeline (minimized, masked, policy-checked, approved, restored), anything else
 * only if a profile matches. Call this before any SDK call: a fetch reference captured earlier would
 * bypass the guard.
 */
export function installAirlock(options: AirlockOptions = {}): AirlockHandle {
  const target = globalThis as unknown as { fetch: typeof fetch };
  const previous = target.fetch;
  const realFetch: typeof fetch = (options.fetchImpl ?? previous).bind(globalThis);
  const store = new AirlockStore();
  const audit = new AuditLog();
  let protectedTerms = options.protectedTerms ?? [];

  const gemini: Profile = options.hosts ? { ...GEMINI_PROFILE, match: { ...GEMINI_PROFILE.match, hosts: options.hosts } } : GEMINI_PROFILE;
  const kv = options.kv ?? memoryKV();
  const registry = new ProfileRegistry(kv, {
    builtins: [gemini, GENERIC_JSON_TEMPLATE],
    extra: options.profiles,
  });
  // Read on every request so rules edited in storage apply at once; invalid stored rules fall back with an error.
  const rules = async (): Promise<RulesData> => {
    await registry.ready;
    return registry.loadRules(options.rules ?? DEFAULT_RULES);
  };
  const engine = createEngine({
    source: registry,
    kv,
    rules,
    scope: options.scope,
    scopeOnly: options.scopeOnly,
    store,
    audit,
    pipelines: PIPELINES,
    readPipeline: runReadThrough,
    analyzer: options.analyzer ?? null,
    maxChars: options.maxChars,
    autoApprove: options.autoApprove,
    getProtectedTerms: () => protectedTerms,
  });

  async function guarded(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    await engine.ready;
    const raw = isRequest(input) ? input.url : input instanceof URL ? input.href : String(input);
    const where = resolveUrl(raw);
    if (!where || !engine.isInScope(where.host)) return realFetch(input, init);

    const req = await normalizeFetch(input, init, where);
    const outcome = await engine.process(req);
    if (outcome.kind === "pass") return realFetch(input, init);
    if (outcome.kind === "block") throw new TypeError(`AIRLOCK blocked the request: ${outcome.reason}`);

    const forwarded = { ...req.headers };
    delete forwarded["content-length"];
    const started = Date.now();
    let res: Response;
    try {
      res = await realFetch(outcome.url ?? (isRequest(input) ? input.url : input), {
        ...requestDefaults(input),
        ...init,
        method: req.method,
        headers: forwarded,
        body: outcome.body,
      });
    } catch (err) {
      outcome.onError(err);
      throw err;
    }
    const latency = Date.now() - started;
    // A binary answer (an image, a font, a download) cannot be read as text without corrupting it, and there is nothing to restore in it.
    if (/^(image|audio|video|font)\//i.test(res.headers.get("content-type") ?? "") || /octet-stream|pdf|zip|wasm/i.test(res.headers.get("content-type") ?? "")) {
      outcome.onResponse(res.status, "", latency);
      return res;
    }
    const text = outcome.onResponse(res.status, await res.text(), latency);
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    const noBody = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(noBody ? null : text, { status: res.status, statusText: res.statusText, headers });
  }

  target.fetch = guarded as typeof fetch;
  return {
    store,
    audit,
    engine,
    registry,
    profileErrors: () => registry.errors(),
    rules,
    setProtectedTerms: (terms) => {
      protectedTerms = terms;
    },
    uninstall: () => {
      target.fetch = previous;
    },
  };
}
