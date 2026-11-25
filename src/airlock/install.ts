import { NanoAnalyzer, type LocalModelLike } from "./ai/local.js";
import type { AuditLog } from "./core/audit.js";
import { dryRun } from "./flows/dryrun.js";
import { DEFAULT_RULES } from "./flows/rules.js";
import { InspectionStore, type AuthoringSpec } from "./inspect/session.js";
import { installAirlock as installGuard, type AirlockHandle } from "./net/guard.js";
import { installXhrAdapter } from "./net/xhr.js";
import { localStorageKV, type KVStore } from "./profiles/storage.js";
import type { RulesData } from "./profiles/types.js";

export interface InstallOptions {
  /** Factory for the on-device model (a Firebase AI Logic ONLY_ON_DEVICE model with a JSON schema). */
  localModel?: () => LocalModelLike;
  /**
   * Mounts a UI for the installed engine and returns how to unmount it. The page build passes the console here
   * (see index.ts); the Chrome extension passes the remote adapter that publishes to its side panel. Pluggable so
   * this module never imports React.
   */
  ui?: (installed: InstalledAirlock) => (() => void) | void;
  /** Values AIRLOCK always masks, such as the user's own name. */
  protectedTerms?: string[];
  /** Hosts for the built-in Gemini profile. */
  hosts?: string[];
  /** Profiles supplied by the host app (validated, not persisted). */
  profiles?: unknown[];
  /** Hosts that are protected even without a profile: requests to them are blocked until a profile matches. */
  scope?: string[];
  /** Only `scope` decides what is in scope; profiles naming other hosts do not extend it (the Chrome extension). */
  scopeOnly?: boolean;
  /**
   * Hosts with inspection on: an in-scope request to one of them that no profile matches is held (nothing leaves)
   * and the Inspect tab can author a profile for it. Without this, such a request is blocked with a reason.
   */
  inspectHosts?: string[];
  /** ONLY_ON_DEVICE model that classifies the real values of a held request. Without it, labelled detector-only classification. */
  classifierModel?: () => LocalModelLike;
  /** PREFER_ON_DEVICE model that authors the profile from a structure-only prompt, with its name and generation config. */
  authoringModel?: () => AuthoringSpec;
  /** Persistence. Defaults to localStorage when the page has it, otherwise memory. */
  kv?: KVStore;
  rules?: RulesData;
}

export type InstalledAirlock = AirlockHandle & {
  analyzer: NanoAnalyzer | null;
  /** The inspection store, or null when no host has inspection on. */
  inspection: InspectionStore | null;
  inspectHosts: readonly string[];
  defaultRules: RulesData;
};

/**
 * Classification and authoring run from the Inspect tab, not from the engine, so they are audited here: each new
 * result becomes one entry whose `where` is the SDK-reported inference source (never a guess), with its latency
 * and the Firebase AI Logic mode that was asked for.
 */
function auditInspection(inspection: InspectionStore, audit: AuditLog): void {
  const seen = new WeakSet<object>();
  inspection.subscribe(() => {
    for (const item of inspection.getSnapshot()) {
      const c = item.classification;
      if (c && !seen.has(c)) {
        seen.add(c);
        audit.add({
          kind: "local-analysis",
          requestId: item.id,
          where: c.source === "on_device" ? "on_device" : "code",
          latencyMs: c.latencyMs,
          detail: { step: "classify-fields", mode: "ONLY_ON_DEVICE", inferenceSource: c.source, calls: c.calls, fields: c.fields.length },
        });
      }
      const a = item.authored;
      if (a && !seen.has(a)) {
        seen.add(a);
        audit.add({
          kind: "local-analysis",
          requestId: item.id,
          where: a.source ?? "code",
          latencyMs: a.latencyMs,
          detail: { step: "author-profile", mode: "PREFER_ON_DEVICE", inferenceSource: a.source ?? "none", calls: a.calls, result: item.status },
        });
      }
    }
  });
}

/**
 * One call protects every Firebase AI Logic cloud request the page makes, and any other in-scope host a
 * profile covers, over fetch and XMLHttpRequest: held, minimized, masked, checked by code, shown to the
 * user and only then sent. Call it before any SDK request.
 */
export function installAirlock(opts: InstallOptions = {}): InstalledAirlock {
  const analyzer = opts.localModel ? new NanoAnalyzer(opts.localModel) : null;
  const handle = installGuard({
    analyzer,
    protectedTerms: opts.protectedTerms,
    hosts: opts.hosts,
    profiles: opts.profiles,
    scope: opts.scope,
    scopeOnly: opts.scopeOnly,
    rules: opts.rules,
    kv: opts.kv ?? localStorageKV() ?? undefined,
  });
  const uninstallXhr = installXhrAdapter(handle.engine);

  let inspection: InspectionStore | null = null;
  const inspectHosts = opts.inspectHosts ?? [];
  if (inspectHosts.length > 0) {
    inspection = new InspectionStore({
      registry: handle.registry,
      dryRun,
      rules: opts.rules ?? DEFAULT_RULES,
      classifierModel: opts.classifierModel,
      authoringModel: opts.authoringModel,
      observations: handle.engine.observations,
      // Releases exactly one value-free authoring request to the Gemini host if the SDK falls back to the cloud.
      beforeCall: (call) => handle.engine.allowStructureOnly(call),
    });
    const store = inspection;
    handle.engine.setInspection({
      hosts: inspectHosts,
      capture: (req) => store.capture(req),
      attachResponse: (id, body) => store.attachResponse(id, body),
      get: (id) => store.get(id),
    });
    auditInspection(store, handle.audit);
  }

  if (analyzer && typeof document !== "undefined") {
    // The first click anywhere is a user gesture: use it to initialize and warm the on-device model.
    document.addEventListener("pointerdown", () => void analyzer.warm().catch(() => undefined), { once: true });
  }
  let unmountUi: (() => void) | void;
  const installed: InstalledAirlock = {
    ...handle,
    analyzer,
    inspection,
    inspectHosts,
    defaultRules: opts.rules ?? DEFAULT_RULES,
    uninstall: () => {
      if (unmountUi) unmountUi();
      uninstallXhr();
      handle.engine.setInspection(null);
      handle.uninstall();
    },
  };
  if (opts.ui) unmountUi = opts.ui(installed);
  return installed;
}
