import type { AuditEvent } from "../airlock/core/audit.js";
import type { LocalState } from "../airlock/ai/local.js";
import type { InspectItem } from "../airlock/inspect/session.js";
import type { RequestView } from "../airlock/net/store.js";
import type { ProfileEntry } from "../airlock/profiles/storage.js";
import { ACTIONS, CATEGORIES, type Action, type Category, type RulesData } from "../airlock/profiles/types.js";

/**
 * The message protocol of the AIRLOCK Chrome extension. Three hops, each validated on arrival:
 *
 *   page (MAIN world engine)  <-- MessagePort, per-page nonce -->  bridge (ISOLATED content script)
 *   bridge                    <-- chrome.runtime port -->          background service worker
 *   background                <-- chrome.runtime port -->          side panel (extension page)
 *
 * Everything stays inside the browser. No message is ever sent to a remote host.
 */

export const PROTOCOL_VERSION = 1;

/** chrome.storage.local key holding the configured host list (an array of Chrome match patterns). */
export const HOSTS_STORAGE_KEY = "airlock.ext.hosts.v1";

/** A held request that nobody decides within this long is blocked. */
export const DEFAULT_HOLD_TIMEOUT_MS = 120_000;
/**
 * The bridge pushes a heartbeat (with the panel status) this often and whenever the panel status changes. The page does
 * not trust the clock for liveness, because a hidden tab's timers are throttled: while a request waits it probes the
 * bridge with a ping and treats the bridge as gone when no heartbeat answers within BRIDGE_STALE_MS.
 */
export const HEARTBEAT_INTERVAL_MS = 1_000;
export const BRIDGE_STALE_MS = 3_500;

/** chrome.storage.local key for settings the panel may change. */
export const SETTINGS_STORAGE_KEY = "airlock.ext.settings.v1";
export const MIN_HOLD_TIMEOUT_MS = 1_000;
export const MAX_HOLD_TIMEOUT_MS = 600_000;

/** A usable hold timeout: a number clamped to the allowed range, otherwise the default. */
export function clampHoldTimeout(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? Math.min(MAX_HOLD_TIMEOUT_MS, Math.max(MIN_HOLD_TIMEOUT_MS, Math.round(x))) : DEFAULT_HOLD_TIMEOUT_MS;
}

export const PAGE_PORT_NAME = "airlock-page";
export const PANEL_PORT_NAME = "airlock-panel";

/** The host list a fresh install starts with. Only the local test page; the owner edits it in the side panel. */
export const DEV_DEFAULT_HOSTS: readonly string[] = ["http://127.0.0.1:5173/*"];

/* ---------------------------------------------------------------- host patterns */

const HOST_PATTERN = /^https?:\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?\/\*$/i;

/** A Chrome match pattern AIRLOCK accepts: http or https, a host (optionally *.domain and a port), path /*. */
export function isValidHostPattern(pattern: unknown): pattern is string {
  if (typeof pattern !== "string" || pattern.length > 253 || !HOST_PATTERN.test(pattern)) return false;
  const host = pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
  const name = host.replace(/:\d+$/, "").replace(/^\*\./, "");
  return !name.includes("..") && !name.includes("*") && name.length > 0;
}

/** The engine scope entry of a pattern: "http://127.0.0.1:5173/*" becomes "127.0.0.1:5173". */
export function scopeHostOf(pattern: string): string {
  return pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
}

/** Validate and de-duplicate a host list. Returns the problems with the offending entries. */
export function normalizeHosts(input: unknown): { hosts: string[]; errors: string[] } {
  if (!Array.isArray(input)) return { hosts: [], errors: ["The host list must be an array of match patterns."] };
  const hosts: string[] = [];
  const errors: string[] = [];
  for (const entry of input) {
    if (!isValidHostPattern(entry)) {
      errors.push(`"${String(entry).slice(0, 80)}" is not a valid host pattern (use http(s)://host/* or https://*.domain/*).`);
      continue;
    }
    const lower = entry.toLowerCase();
    if (!hosts.includes(lower)) hosts.push(lower);
  }
  return { hosts, errors };
}

/* ---------------------------------------------------------------- window handshake (page <-> bridge) */

export const WINDOW_CHANNEL = "airlock-ext-v1";

export interface HandshakeMessage {
  channel: typeof WINDOW_CHANNEL;
  kind: "handshake";
  /** Per-page secret chosen by the bridge. Every later message over the transferred port must carry it. */
  nonce: string;
}

export interface ReadyMessage {
  channel: typeof WINDOW_CHANNEL;
  kind: "ready";
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export function isHandshake(x: unknown): x is HandshakeMessage {
  return isObject(x) && x.channel === WINDOW_CHANNEL && x.kind === "handshake" && typeof x.nonce === "string" && x.nonce.length >= 16;
}

export function isReady(x: unknown): x is ReadyMessage {
  return isObject(x) && x.channel === WINDOW_CHANNEL && x.kind === "ready";
}

/** Anything that looks like it belongs to this channel, valid or not. The page script swallows these so page code never sees them. */
export function isChannelTraffic(x: unknown): boolean {
  return isObject(x) && x.channel === WINDOW_CHANNEL;
}

/* ---------------------------------------------------------------- what the page publishes */

export interface PageSnapshot {
  /** Increases with every publication, so the panel can drop a stale one. */
  seq: number;
  host: string;
  /** True once the engine can hold requests. */
  ready: boolean;
  requests: RequestView[];
  audit: AuditEvent[];
  profiles: ProfileEntry[];
  profileErrors: string[];
  rules: RulesData | null;
  defaultRules: RulesData;
  /** Null when no host has inspection on. */
  inspection: InspectItem[] | null;
  inspectHosts: string[];
  model: { state: LocalState };
  /** The fail-closed settings in force, so the console can state them. */
  failClosed: { timeoutMs: number; panelUp: boolean };
  protectedTerms: string[];
}

/* ---------------------------------------------------------------- what the panel may ask for */

export type DecisionKind = "approve" | "deny" | "fallback";
export type InspectOp = "classify" | "author" | "approve" | "discard" | "passThrough";

export type PanelCommand =
  | { kind: "snapshot" }
  | { kind: "decide"; id: string; decision: DecisionKind }
  | { kind: "inspect"; id: string; op: InspectOp }
  | { kind: "inspect-edit"; id: string; path: string; action?: Action; category?: Category }
  | { kind: "inspect-locator"; id: string; locator: string; accepted: boolean }
  | { kind: "inspect-add-locator"; id: string; locator: string }
  | { kind: "inspect-add-get"; id: string }
  | { kind: "profile-save"; profile: unknown }
  | { kind: "profile-remove"; id: string }
  | { kind: "rules-save"; rules: unknown }
  | { kind: "terms"; terms: string[] }
  | { kind: "clear-local-data" }
  | { kind: "model"; op: "prepare" | "warm" | "refresh" };

const isId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 200;

/** Validate a command that arrived from outside the page engine. Returns null for anything that is not exactly a known command. */
export function parsePanelCommand(x: unknown): PanelCommand | null {
  if (!isObject(x) || typeof x.kind !== "string") return null;
  switch (x.kind) {
    case "snapshot":
    case "clear-local-data":
      return { kind: x.kind };
    case "decide":
      return isId(x.id) && (x.decision === "approve" || x.decision === "deny" || x.decision === "fallback") ? { kind: "decide", id: x.id, decision: x.decision } : null;
    case "inspect":
      return isId(x.id) && (x.op === "classify" || x.op === "author" || x.op === "approve" || x.op === "discard" || x.op === "passThrough")
        ? { kind: "inspect", id: x.id, op: x.op }
        : null;
    case "inspect-edit": {
      if (!isId(x.id) || typeof x.path !== "string" || x.path.length > 500) return null;
      if (x.action !== undefined && !(ACTIONS as readonly unknown[]).includes(x.action)) return null;
      if (x.category !== undefined && !(CATEGORIES as readonly unknown[]).includes(x.category)) return null;
      return { kind: "inspect-edit", id: x.id, path: x.path, action: x.action as Action | undefined, category: x.category as Category | undefined };
    }
    case "inspect-locator":
      return isId(x.id) && typeof x.locator === "string" && x.locator.length > 0 && x.locator.length <= 200 && typeof x.accepted === "boolean"
        ? { kind: "inspect-locator", id: x.id, locator: x.locator, accepted: x.accepted }
        : null;
    case "inspect-add-locator":
      return isId(x.id) && typeof x.locator === "string" && x.locator.length > 0 && x.locator.length <= 200 ? { kind: "inspect-add-locator", id: x.id, locator: x.locator } : null;
    case "inspect-add-get":
      return isId(x.id) ? { kind: "inspect-add-get", id: x.id } : null;
    case "profile-save":
      return isObject(x.profile) ? { kind: "profile-save", profile: x.profile } : null;
    case "profile-remove":
      return isId(x.id) ? { kind: "profile-remove", id: x.id } : null;
    case "rules-save":
      return isObject(x.rules) ? { kind: "rules-save", rules: x.rules } : null;
    case "terms":
      return Array.isArray(x.terms) && x.terms.length <= 200 && x.terms.every((t) => typeof t === "string" && t.length <= 200) ? { kind: "terms", terms: x.terms as string[] } : null;
    case "model":
      return x.op === "prepare" || x.op === "warm" || x.op === "refresh" ? { kind: "model", op: x.op } : null;
    default:
      return null;
  }
}

/* ---------------------------------------------------------------- page <-> bridge (over the transferred MessagePort) */

export interface Wire<T> {
  v: typeof PROTOCOL_VERSION;
  nonce: string;
  msg: T;
}

export function wrap<T>(nonce: string, msg: T): Wire<T> {
  return { v: PROTOCOL_VERSION, nonce, msg };
}

/** Unwrap a port message. Null unless it is a version-1 wire message with exactly the expected nonce. */
export function unwrap(x: unknown, nonce: string): unknown | null {
  if (!isObject(x) || x.v !== PROTOCOL_VERSION || typeof x.nonce !== "string" || x.nonce !== nonce || !("msg" in x)) return null;
  return x.msg;
}

export type PageMessage =
  | { type: "hello"; host: string }
  | { type: "state"; snapshot: PageSnapshot }
  | { type: "result"; cmdId: string; ok: boolean; error?: string }
  /** Liveness probe: the bridge answers at once with a heartbeat. Event-driven, so a throttled background tab cannot fake silence. */
  | { type: "ping" };

export type BridgeMessage =
  | { type: "hb"; panel: boolean }
  | { type: "hosts"; hosts: string[] }
  | { type: "settings"; holdTimeoutMs: number }
  | { type: "command"; cmdId: string; command: PanelCommand };

export function parsePageMessage(x: unknown): PageMessage | null {
  if (!isObject(x)) return null;
  if (x.type === "ping") return { type: "ping" };
  if (x.type === "hello") return typeof x.host === "string" && x.host.length <= 300 ? { type: "hello", host: x.host } : null;
  if (x.type === "state") return isObject(x.snapshot) && typeof x.snapshot.seq === "number" && Array.isArray(x.snapshot.requests) ? { type: "state", snapshot: x.snapshot as unknown as PageSnapshot } : null;
  if (x.type === "result") return isId(x.cmdId) && typeof x.ok === "boolean" ? { type: "result", cmdId: x.cmdId, ok: x.ok, error: typeof x.error === "string" ? x.error.slice(0, 500) : undefined } : null;
  return null;
}

export function parseBridgeMessage(x: unknown): BridgeMessage | null {
  if (!isObject(x)) return null;
  if (x.type === "settings") return { type: "settings", holdTimeoutMs: clampHoldTimeout(x.holdTimeoutMs) };
  if (x.type === "hb") return typeof x.panel === "boolean" ? { type: "hb", panel: x.panel } : null;
  if (x.type === "hosts") {
    const n = normalizeHosts(x.hosts);
    return Array.isArray(x.hosts) && n.errors.length === 0 ? { type: "hosts", hosts: n.hosts } : null;
  }
  if (x.type === "command") {
    const command = parsePanelCommand(x.command);
    return isId(x.cmdId) && command ? { type: "command", cmdId: x.cmdId, command } : null;
  }
  return null;
}

/* ---------------------------------------------------------------- bridge <-> background (chrome.runtime page port) */

/** Sent by the background to a page's bridge. The bridge turns panel/hosts into heartbeats and forwards the rest. */
export type BackgroundToBridge =
  | { type: "panel"; up: boolean }
  | { type: "hosts"; hosts: string[] }
  | { type: "settings"; holdTimeoutMs: number }
  | { type: "command"; cmdId: string; command: PanelCommand };

export function parseBackgroundToBridge(x: unknown): BackgroundToBridge | null {
  if (!isObject(x)) return null;
  if (x.type === "settings") return { type: "settings", holdTimeoutMs: clampHoldTimeout(x.holdTimeoutMs) };
  if (x.type === "panel") return typeof x.up === "boolean" ? { type: "panel", up: x.up } : null;
  if (x.type === "hosts") {
    const n = normalizeHosts(x.hosts);
    return Array.isArray(x.hosts) && n.errors.length === 0 ? { type: "hosts", hosts: n.hosts } : null;
  }
  if (x.type === "command") {
    const command = parsePanelCommand(x.command);
    return isId(x.cmdId) && command ? { type: "command", cmdId: x.cmdId, command } : null;
  }
  return null;
}

/* ---------------------------------------------------------------- background <-> side panel (chrome.runtime panel port) */

export type PanelToBackground =
  | { type: "attach"; tabId: number }
  | { type: "command"; tabId: number; frameId: number; cmdId: string; command: PanelCommand };

export type BackgroundToPanel =
  | { type: "attached"; tabId: number; frames: Array<{ frameId: number; host: string }> }
  | { type: "page"; tabId: number; frameId: number; host: string; up: boolean }
  | { type: "state"; tabId: number; frameId: number; snapshot: PageSnapshot }
  | { type: "result"; tabId: number; frameId: number; cmdId: string; ok: boolean; error?: string };

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

export function parsePanelToBackground(x: unknown): PanelToBackground | null {
  if (!isObject(x)) return null;
  if (x.type === "attach") return isInt(x.tabId) ? { type: "attach", tabId: x.tabId } : null;
  if (x.type === "command") {
    const command = parsePanelCommand(x.command);
    return isInt(x.tabId) && isInt(x.frameId) && isId(x.cmdId) && command ? { type: "command", tabId: x.tabId, frameId: x.frameId, cmdId: x.cmdId, command } : null;
  }
  return null;
}

export function parseBackgroundToPanel(x: unknown): BackgroundToPanel | null {
  if (!isObject(x) || typeof x.type !== "string" || !isInt(x.tabId)) return null;
  if (x.type === "attached") return Array.isArray(x.frames) ? (x as unknown as BackgroundToPanel) : null;
  if (!isInt(x.frameId)) return null;
  if (x.type === "page") return typeof x.host === "string" && typeof x.up === "boolean" ? (x as unknown as BackgroundToPanel) : null;
  if (x.type === "state") return isObject(x.snapshot) && typeof x.snapshot.seq === "number" ? (x as unknown as BackgroundToPanel) : null;
  if (x.type === "result") return isId(x.cmdId) && typeof x.ok === "boolean" ? (x as unknown as BackgroundToPanel) : null;
  return null;
}

/* ---------------------------------------------------------------- extension-page messages (chrome.runtime.sendMessage) */

export type ExtensionRequest = { type: "hosts:get" } | { type: "hosts:set"; hosts: string[] };

export interface HostsState {
  /** The configured match patterns. */
  hosts: string[];
  /** The subset the browser has granted host access to, so scripts are registered for exactly these. */
  granted: string[];
  /** The subset that currently has its scripts registered. */
  registered: string[];
}

export type ExtensionResponse = { ok: true; state: HostsState } | { ok: false; errors: string[] };

export function parseExtensionRequest(x: unknown): ExtensionRequest | null {
  if (!isObject(x)) return null;
  if (x.type === "hosts:get") return { type: "hosts:get" };
  if (x.type === "hosts:set") return Array.isArray(x.hosts) ? { type: "hosts:set", hosts: x.hosts as string[] } : null;
  return null;
}
