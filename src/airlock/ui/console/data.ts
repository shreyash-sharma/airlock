import { createContext, useContext, useSyncExternalStore } from "react";
import type { AuditEvent, AuditLog } from "../../core/audit.js";
import type { AirlockStore, RequestView } from "../../net/store.js";
import type { LocalState, NanoAnalyzer } from "../../ai/local.js";
import type { InspectionStore, InspectItem } from "../../inspect/session.js";
import type { ProfileEntry, ProfileRegistry } from "../../profiles/storage.js";
import type { Action, Category, RulesData } from "../../profiles/types.js";

/**
 * The parts of the engine objects the console really uses, as interfaces. The page build passes the engine's own
 * store, audit log, registry and inspection store; the Chrome extension side panel passes remote ones that read
 * published snapshots and send commands to the page that owns the engine.
 */
export type StoreLike = Pick<AirlockStore, "getSnapshot" | "subscribe" | "approve" | "deny" | "useFallback"> & {
  /** The web demo's "inject a secret" tool. Absent in the extension, which does not offer it. */
  injectLeak?: (id: string) => void;
};
export type AuditLike = Pick<AuditLog, "snapshot" | "subscribe">;
export type RegistryLike = Pick<ProfileRegistry, "subscribe" | "version" | "entries" | "save" | "saveMany" | "remove" | "saveRules">;
export interface InspectionLike {
  getSnapshot(): readonly InspectItem[];
  subscribe(listener: () => void): () => void;
  classify(id: string): Promise<unknown>;
  author(id: string): Promise<void>;
  edit(id: string, path: string, action: Action | undefined, category?: Category): Promise<void>;
  setLocatorAccepted(id: string, locator: string, accepted: boolean): Promise<void>;
  addLocator(id: string, locator: string): Promise<{ ok: boolean; error?: string }>;
  addGet(id: string): Promise<void>;
  approve(id: string): Promise<{ ok: boolean; errors: string[] }>;
  discard(id: string): void;
  passThrough(id: string): void;
}
// Compile-time proof the real engine objects satisfy the interfaces.
type Assignable<T extends U, U> = T;
export type _EngineMatches = [Assignable<InspectionStore, InspectionLike>, Assignable<AirlockStore, StoreLike>, Assignable<ProfileRegistry, RegistryLike>];

/** One configured host as the Hosts page shows it (extension only). */
export interface HostRow {
  /** The Chrome match pattern that is stored, for example https://crm.example.com/*. */
  pattern: string;
  /** The host name the user typed, for display. */
  name: string;
  /** Whether the browser has granted AIRLOCK access to this host. */
  granted: boolean;
  /** Whether AIRLOCK's scripts are registered for it right now. */
  registered: boolean;
}

export interface HostsView {
  rows: readonly HostRow[];
  /** The hold timeout in force, in ms. */
  holdTimeoutMs: number;
  /** False until the first answer from the extension arrived. */
  loaded: boolean;
  /** A problem reading or changing the list, in plain words. */
  problem: string | null;
}

/** The extension's host list, permissions and hold timeout. Only the side panel provides it. */
export interface HostsController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): HostsView;
  /** Validate, ask the browser for access (this must run inside the click that calls it), then store and register. */
  add(input: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Remove from the list (scripts unregister) and give the browser access back. */
  remove(pattern: string): Promise<{ ok: true; note?: string } | { ok: false; error: string }>;
  setHoldTimeout(seconds: number): Promise<{ ok: true; seconds: number } | { ok: false; error: string }>;
}

/** What the extension side panel says about the tab it watches. */
export interface Attachment {
  /** True while the panel is connected to the extension's background. */
  connected: boolean;
  tabId: number | null;
  /** Hosts of the AIRLOCK-protected frames in that tab. */
  hosts: readonly string[];
  /** True once a protected page in that tab reports in. */
  attached: boolean;
  /** True while the panel follows the active tab. False when it is pinned to one tab (a panel opened as a normal tab). */
  following: boolean;
  /** Seconds a held request waits before it is blocked, as reported by the page. */
  timeoutMs: number | null;
}

/**
 * What the console needs from the engine: the request store and the audit log, both observable. Nothing here
 * reaches for host globals, so a Chrome extension side panel can supply the same two objects over a bridge.
 */
export interface ConsoleSource {
  store: StoreLike;
  audit: AuditLike;
  /** Number of profile or rules problems found on load. */
  profileErrors(): readonly string[];
  /** True once the engine can hold requests. */
  isReady(): boolean;
  setProtectedTerms(terms: string[]): void;
  clearLocalData(): Promise<void>;
  /** Stored, app-supplied and built-in profiles, observable. */
  registry: RegistryLike;
  /** The destination rules in force: stored when valid, otherwise the defaults. */
  loadRules(): Promise<RulesData>;
  /** The defaults the rules fall back to. */
  defaultRules: RulesData;
  /** The inspection store, or null when no host has inspection on. */
  inspection: InspectionLike | null;
  /** Hosts with inspection on (empty when inspection is off). */
  inspectHosts: readonly string[];
  /** Where the engine runs and what the panel watches, when the console is the extension's side panel. */
  extension?: {
    hosts: HostsController;
    /** Observable: the same object is returned until the attachment changes. */
    subscribe(listener: () => void): () => void;
    attachment(): Attachment;
    /** Status of the on-device model as seen by the protected page, and a way to ask that page to prepare it. */
    model: { state(): LocalState; prepare(): Promise<void> };
  };
}

export interface ConsoleEnv {
  source: ConsoleSource;
  analyzer: NanoAnalyzer | null;
  environment: string;
  initialTerms: string;
}

export const ConsoleContext = createContext<ConsoleEnv | null>(null);

export function useEnv(): ConsoleEnv {
  const env = useContext(ConsoleContext);
  if (!env) throw new Error("ConsoleContext is missing");
  return env;
}

export function useViews(): readonly RequestView[] {
  const { source } = useEnv();
  return useSyncExternalStore(source.store.subscribe, source.store.getSnapshot);
}

export function useEvents(): readonly AuditEvent[] {
  const { source } = useEnv();
  return useSyncExternalStore(
    (cb) => source.audit.subscribe(cb),
    () => source.audit.snapshot(),
  );
}

/** The audit events of one request, oldest first. */
export function eventsFor(events: readonly AuditEvent[], id: string): AuditEvent[] {
  return events.filter((e) => e.requestId === id);
}

/** The inference source the audit recorded for a request: on_device or in_cloud, or undefined when none ran. */
export function inferenceOf(v: RequestView, events: readonly AuditEvent[]): "on_device" | "in_cloud" | undefined {
  if (v.selection?.source === "on_device") return "on_device";
  const e = events.find((x) => x.requestId === v.id && x.kind === "local-analysis" && (x.where === "on_device" || x.where === "in_cloud"));
  return e?.where === "on_device" || e?.where === "in_cloud" ? e.where : undefined;
}

/** Every profile with its origin; re-renders on any save, delete, import or reload. */
export function useProfileEntries(): readonly ProfileEntry[] {
  const { source } = useEnv();
  useSyncExternalStore(source.registry.subscribe, source.registry.version);
  return source.registry.entries();
}

const NO_ITEMS: readonly InspectItem[] = [];
const NEVER = (): (() => void) => () => undefined;

/** The held inspection items, or an empty list when inspection is off. */
export function useInspectItems(): readonly InspectItem[] {
  const { source } = useEnv();
  const insp = source.inspection;
  return useSyncExternalStore(insp ? insp.subscribe : NEVER, insp ? insp.getSnapshot : () => NO_ITEMS);
}
