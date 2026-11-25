import type { LocalModelLike, LocalState } from "../../airlock/ai/local.js";
import { installAirlock, type InstallOptions, type InstalledAirlock } from "../../airlock/install.js";
import type { AuthoringSpec } from "../../airlock/inspect/session.js";
import { DEFAULT_RULES } from "../../airlock/flows/rules.js";
import { canonicalHost } from "../../airlock/profiles/match.js";
import type { RulesData } from "../../airlock/profiles/types.js";
import { scopeHostOf } from "../protocol.js";
import { FailClosedGate, type GateTimers } from "./failclosed.js";
import { PageLink, type LinkWindow } from "./link.js";
import { RemoteHost } from "./remote.js";

/**
 * In the extension every destination asks: a request to a host the user configured is held until the side panel
 * decides, whatever its kind. (The web demo auto-approves SaaS destinations; stored rules still override both.)
 */
/** The AI destination asks; a SaaS destination is inline (mask and send, review later), so a CRM user never waits. */
export const EXT_DEFAULT_RULES: RulesData = DEFAULT_RULES;

export interface PageRuntimeEnv {
  win: LinkWindow;
  /** location.host of the page: the host that is in scope until the host list arrives. */
  host: string;
  now(): number;
  timers: GateTimers & { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void };
  /** The engine install. Injectable so tests can pass a fetch and XHR fake. */
  install?: (opts: InstallOptions) => InstalledAirlock;
  /** Firebase AI Logic models (factories, so nothing is built until used). Absent: detector-only, labelled. */
  models?: {
    localModel?: () => LocalModelLike;
    classifierModel?: () => LocalModelLike;
    authoringModel?: () => AuthoringSpec;
  };
  holdTimeoutMs?: number;
  publishDelayMs?: number;
  localStatus?: () => Promise<LocalState>;
}

export interface PageRuntime {
  installed: InstalledAirlock;
  link: PageLink;
  gate: FailClosedGate;
  remote: RemoteHost;
  /** The engine scope as it is now, for tests and the console. */
  scope: readonly string[];
  stop(): void;
}

/**
 * Start AIRLOCK inside a page: the engine (fetch + XHR guards, profiles, flows, policy, inspection) in scope for the
 * configured hosts, the bridge link, the fail-closed gate and the remote console adapter. The page's own host is in
 * scope from the first instruction; the full host list replaces it when the bridge delivers it.
 */
export function startPageRuntime(env: PageRuntimeEnv): PageRuntime {
  const scope: string[] = [canonicalHost(env.host)];
  const install = env.install ?? installAirlock;
  let remote!: RemoteHost;
  let gate!: FailClosedGate;

  const link = new PageLink(
    { win: env.win, now: env.now, setTimeout: env.timers.setTimeout },
    {
      onCommand: (cmdId, command) => void remote.run(cmdId, command),
      onHosts: (hosts) => {
        // In place: the engine and the inspection port hold this same array.
        scope.splice(0, scope.length, ...hosts.map((h) => canonicalHost(scopeHostOf(h))));
      },
      onSettings: (ms) => gate.setTimeoutMs(ms),
      onPanelChange: (up) => {
        gate.panelChanged(up);
        if (up) void remote.publish();
      },
      onConnect: () => remote.connected(),
    },
  );
  // Listen before anything else can: the handshake must never reach a page script.
  link.start();

  const installed = install({
    scope,
    rules: EXT_DEFAULT_RULES,
    scopeOnly: true, // requests to hosts the user did not configure are never touched
    inspectHosts: scope,
    localModel: env.models?.localModel,
    classifierModel: env.models?.classifierModel,
    authoringModel: env.models?.authoringModel,
    ui: (inst) => {
      gate = new FailClosedGate({
        store: inst.store,
        inspection: inst.inspection,
        audit: inst.audit,
        panelUp: () => link.panelUp(),
        timeoutMs: env.holdTimeoutMs,
        timers: env.timers,
        verify: () => link.verify(),
      });
      remote = new RemoteHost({
        installed: inst,
        link,
        gate,
        host: canonicalHost(env.host),
        timers: env.timers,
        publishDelayMs: env.publishDelayMs,
        localStatus: env.localStatus,
      });
      gate.start();
      remote.start();
      return () => {
        remote.stop();
        gate.stop();
      };
    },
  });

  return {
    installed,
    link,
    gate,
    remote,
    scope,
    stop: () => {
      link.stop();
      installed.uninstall();
    },
  };
}
