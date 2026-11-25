import type { HostRow, HostsController, HostsView } from "../../airlock/ui/console/data.js";
import {
  clampHoldTimeout,
  DEFAULT_HOLD_TIMEOUT_MS,
  HOSTS_STORAGE_KEY,
  MAX_HOLD_TIMEOUT_MS,
  MIN_HOLD_TIMEOUT_MS,
  scopeHostOf,
  SETTINGS_STORAGE_KEY,
  type ExtensionResponse,
  type HostsState,
} from "../protocol.js";
import { patternFromInput, timeoutFromInput } from "./host-input.js";

/** The slice of the Chrome API the Hosts page uses. Written structurally so a test passes a fake. */
export interface HostsChrome {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  permissions: {
    request(query: { origins: string[] }): Promise<boolean>;
    remove(query: { origins: string[] }): Promise<boolean>;
    onAdded?: { addListener(l: () => void): void };
    onRemoved?: { addListener(l: () => void): void };
  };
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
    onChanged?: { addListener(l: (changes: Record<string, unknown>, area: string) => void): void };
  };
}

const rowsOf = (s: HostsState): HostRow[] =>
  s.hosts.map((pattern) => ({ pattern, name: scopeHostOf(pattern), granted: s.granted.includes(pattern), registered: s.registered.includes(pattern) }));

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * The host list, its permissions and the hold timeout, as the Hosts page uses them. The list itself lives in the
 * background (chrome.storage.local, and the content scripts that follow it); this asks the background to change it and
 * asks the browser for (or gives back) access to each host. chrome.permissions.request runs first inside add(), so
 * it is still inside the click that started it.
 */
export function createHostsController(chrome: HostsChrome): HostsController & { refresh(): Promise<void> } {
  let view: HostsView = { rows: [], holdTimeoutMs: DEFAULT_HOLD_TIMEOUT_MS, loaded: false, problem: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<HostsView>): void => {
    view = { ...view, ...patch };
    listeners.forEach((l) => l());
  };

  async function ask(message: unknown): Promise<ExtensionResponse> {
    try {
      return (await chrome.runtime.sendMessage(message)) as ExtensionResponse;
    } catch (e) {
      return { ok: false, errors: [`The extension did not answer: ${messageOf(e)}`] };
    }
  }

  async function readTimeout(): Promise<number> {
    try {
      const stored = (await chrome.storage.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY] as { holdTimeoutMs?: unknown } | undefined;
      return clampHoldTimeout(stored?.holdTimeoutMs);
    } catch {
      return DEFAULT_HOLD_TIMEOUT_MS;
    }
  }

  async function refresh(): Promise<void> {
    const r = await ask({ type: "hosts:get" });
    const holdTimeoutMs = await readTimeout();
    if (r && r.ok) set({ rows: rowsOf(r.state), holdTimeoutMs, loaded: true, problem: null });
    else set({ holdTimeoutMs, loaded: true, problem: (r && !r.ok ? r.errors.join(" ") : "The extension did not answer.") });
  }

  const onChange = (): void => void refresh();
  chrome.permissions.onAdded?.addListener(onChange);
  chrome.permissions.onRemoved?.addListener(onChange);
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && (HOSTS_STORAGE_KEY in changes || SETTINGS_STORAGE_KEY in changes)) onChange();
  });

  return {
    refresh,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    getSnapshot: () => view,

    add(input: string) {
      const p = patternFromInput(input);
      if (!p.ok) return Promise.resolve({ ok: false as const, error: p.error });
      // Ask the browser first and synchronously: this still runs inside the user's click.
      const requested = chrome.permissions.request({ origins: [p.pattern] }).then(
        (granted) => ({ granted, error: null as string | null }),
        (e: unknown) => ({ granted: false, error: messageOf(e) }),
      );
      return requested.then(async (r) => {
        if (r.error) return { ok: false as const, error: `Chrome could not ask for access to ${p.name}: ${r.error}` };
        if (!r.granted) return { ok: false as const, error: `Chrome did not grant access to ${p.name}, so AIRLOCK was not turned on for it.` };
        const next = [...new Set([...view.rows.map((row) => row.pattern), p.pattern])];
        const res = await ask({ type: "hosts:set", hosts: next });
        if (!res.ok) return { ok: false as const, error: res.errors.join(" ") };
        set({ rows: rowsOf(res.state), problem: null, loaded: true });
        return { ok: true as const };
      });
    },

    async remove(pattern: string) {
      const next = view.rows.map((row) => row.pattern).filter((x) => x !== pattern);
      const res = await ask({ type: "hosts:set", hosts: next });
      if (!res.ok) return { ok: false as const, error: res.errors.join(" ") };
      set({ rows: rowsOf(res.state), problem: null, loaded: true });
      let note: string | undefined;
      try {
        const removed = await chrome.permissions.remove({ origins: [pattern] });
        if (!removed) note = "AIRLOCK no longer protects this host. Chrome kept the access it was granted at install.";
      } catch (e) {
        note = `AIRLOCK no longer protects this host. Chrome kept the access: ${messageOf(e)}`;
      }
      await refresh();
      return { ok: true as const, ...(note ? { note } : {}) };
    },

    async setHoldTimeout(seconds: number) {
      const t = timeoutFromInput(seconds, MIN_HOLD_TIMEOUT_MS, MAX_HOLD_TIMEOUT_MS);
      if (!t.ok) return { ok: false as const, error: t.error };
      try {
        await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: { holdTimeoutMs: t.ms } });
      } catch (e) {
        return { ok: false as const, error: `The timeout was not saved: ${messageOf(e)}` };
      }
      set({ holdTimeoutMs: t.ms });
      return { ok: true as const, seconds: t.ms / 1000 };
    },
  };
}
