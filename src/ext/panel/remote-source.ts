import type { LocalState } from "../../airlock/ai/local.js";
import type { AuditEvent } from "../../airlock/core/audit.js";
import { DEFAULT_RULES } from "../../airlock/flows/rules.js";
import type { InspectItem } from "../../airlock/inspect/session.js";
import type { RequestView } from "../../airlock/net/store.js";
import type { ProfileEntry, SaveResult } from "../../airlock/profiles/storage.js";
import type { Profile, RulesData } from "../../airlock/profiles/types.js";
import { validateProfile, validateRules } from "../../airlock/profiles/validate.js";
import type { Attachment, ConsoleSource, HostsController, InspectionLike, RegistryLike, StoreLike } from "../../airlock/ui/console/data.js";
import type { PageSnapshot, PanelCommand } from "../protocol.js";
import type { CommandResult, FrameState, PanelClient, PanelState } from "./client.js";

const NO_REQUESTS: readonly RequestView[] = [];
const NO_EVENTS: readonly AuditEvent[] = [];
const NO_ITEMS: readonly InspectItem[] = [];
const NO_ENTRIES: ProfileEntry[] = [];
const NO_STRINGS: readonly string[] = [];

/** A request waits on the user in these states; a frame with more of them is the one the panel shows. */
const NEEDS_USER = new Set(["awaiting-approval", "local-failed", "inspecting"]);

/**
 * Which frame of the attached tab the console shows. The top frame by default; a frame that holds requests waiting
 * for the user wins, so a decision is never hidden in an iframe the panel is not showing. Only a frame that is up and
 * has reported its state can be shown.
 */
export function pickFrame(frames: readonly FrameState[]): FrameState | null {
  const live = frames.filter((f) => f.up && f.snapshot);
  if (live.length === 0) return null;
  const waiting = (f: FrameState): number => (f.snapshot?.requests.filter((r) => NEEDS_USER.has(r.status)).length ?? 0) + (f.snapshot?.inspection?.filter((i) => i.status === "held").length ?? 0);
  return [...live].sort((a, b) => waiting(b) - waiting(a) || a.frameId - b.frameId)[0];
}

/** The attachment the panel reports for a client state: pure, so it is tested without a browser. */
export function attachmentOf(state: PanelState, following: boolean): Attachment {
  const shown = pickFrame(state.frames);
  const live = state.frames.filter((f) => f.up && f.snapshot);
  return {
    connected: state.connected,
    tabId: state.tabId,
    hosts: [...new Set(live.map((f) => f.host).filter(Boolean))],
    attached: live.length > 0,
    following,
    timeoutMs: shown?.snapshot?.failClosed.timeoutMs ?? null,
  };
}

export interface Notice {
  text: string;
  at: number;
}

export interface RemoteSource {
  source: ConsoleSource;
  /** The last command that did not go through, in plain words, or null. Observable. */
  notice: { subscribe(l: () => void): () => void; get(): Notice | null; clear(): void };
  dispose(): void;
}

interface Options {
  hosts: HostsController;
  /** True when the panel follows the active tab. */
  following: boolean;
  /** How often to ask the page to re-read the on-device model status. 0 turns it off. */
  modelRefreshMs?: number;
  timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void };
}

const LONG_MS = 180_000;
const DOWNLOAD_MS = 600_000;

/**
 * The side panel's engine objects. Each one has the interface the console already uses (store, audit, registry,
 * inspection), but reads the snapshot the protected page last published and sends every change back as a command.
 * The page runs the engine; this only shows its state and asks it to act.
 */
export function createRemoteSource(client: PanelClient, opts: Options): RemoteSource {
  const timers = opts.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
  const shown = (): { frame: FrameState | null; snap: PageSnapshot | null } => {
    const frame = pickFrame(client.getState().frames);
    return { frame, snap: frame?.snapshot ?? null };
  };

  let notice: Notice | null = null;
  const noticeListeners = new Set<() => void>();
  const setNotice = (text: string | null): void => {
    notice = text === null ? null : { text, at: Date.now() };
    noticeListeners.forEach((l) => l());
  };

  async function send(command: PanelCommand, timeoutMs?: number): Promise<CommandResult> {
    const { frame } = shown();
    if (!frame) {
      const r = { ok: false, error: "No protected page is attached. Open a page on a host from your list in the watched tab." };
      setNotice(r.error);
      return r;
    }
    const r = await client.command(frame.frameId, command, timeoutMs);
    if (!r.ok) setNotice(r.error ?? "The page refused that.");
    return r;
  }
  const fire = (command: PanelCommand): void => void send(command);

  const store: StoreLike = {
    getSnapshot: () => shown().snap?.requests ?? NO_REQUESTS,
    subscribe: client.subscribe,
    approve: (id) => fire({ kind: "decide", id, decision: "approve" }),
    deny: (id) => fire({ kind: "decide", id, decision: "deny" }),
    useFallback: (id) => fire({ kind: "decide", id, decision: "fallback" }),
  };

  /** A version that moves only when the profiles or rules really changed, so editors are not reset by every snapshot. */
  let versionSnap: PageSnapshot | null = null;
  let versionSig = "";
  let rev = 0;
  const version = (): number => {
    const snap = shown().snap;
    if (snap !== versionSnap) {
      versionSnap = snap;
      const sig = JSON.stringify([snap?.profiles ?? null, snap?.rules ?? null]);
      if (sig !== versionSig) {
        versionSig = sig;
        rev++;
      }
    }
    return rev;
  };

  const registry: RegistryLike = {
    subscribe: client.subscribe,
    version,
    entries: () => shown().snap?.profiles ?? NO_ENTRIES,
    async save(input: unknown): Promise<SaveResult> {
      const v = validateProfile(input);
      if (!v.ok) return v;
      const r = await send({ kind: "profile-save", profile: v.profile });
      return r.ok ? { ok: true, profile: v.profile } : { ok: false, errors: [r.error ?? "The profile was not saved."] };
    },
    async saveMany(inputs) {
      const valid: Profile[] = [];
      const errors: string[] = [];
      inputs.forEach((raw, i) => {
        const r = validateProfile(raw);
        if (r.ok) valid.push(r.profile);
        else r.errors.forEach((e) => errors.push(`${e} (profile ${i + 1})`));
      });
      if (errors.length > 0) return { ok: false as const, errors };
      for (const profile of valid) {
        const r = await send({ kind: "profile-save", profile });
        if (!r.ok) return { ok: false as const, errors: [r.error ?? "A profile was not saved."] };
      }
      return { ok: true as const, profiles: valid };
    },
    async remove(id) {
      const r = await send({ kind: "profile-remove", id });
      return r.ok ? { ok: true } : { ok: false, reason: r.error };
    },
    async saveRules(input: unknown) {
      const v = validateRules(input);
      if (!v.ok) return v;
      const r = await send({ kind: "rules-save", rules: v.rules });
      return r.ok ? { ok: true as const, rules: v.rules } : { ok: false as const, errors: [r.error ?? "The rules were not saved."] };
    },
  };

  const inspection: InspectionLike = {
    getSnapshot: () => shown().snap?.inspection ?? NO_ITEMS,
    subscribe: client.subscribe,
    classify: async (id) => void (await send({ kind: "inspect", id, op: "classify" }, LONG_MS)),
    author: async (id) => void (await send({ kind: "inspect", id, op: "author" }, LONG_MS)),
    edit: async (id, path, action, category) => void (await send({ kind: "inspect-edit", id, path, ...(action ? { action } : {}), ...(category ? { category } : {}) }, LONG_MS)),
    setLocatorAccepted: async (id, locator, accepted) => void (await send({ kind: "inspect-locator", id, locator, accepted }, LONG_MS)),
    addLocator: async (id, locator) => {
      const r = await send({ kind: "inspect-add-locator", id, locator }, LONG_MS);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    addGet: async (id) => void (await send({ kind: "inspect-add-get", id }, LONG_MS)),
    approve: async (id) => {
      const r = await send({ kind: "inspect", id, op: "approve" }, LONG_MS);
      return r.ok ? { ok: true, errors: [] } : { ok: false, errors: (r.error ?? "The profile was not saved.").split("; ") };
    },
    discard: (id) => fire({ kind: "inspect", id, op: "discard" }),
    passThrough: (id) => fire({ kind: "inspect", id, op: "passThrough" }),
  };

  let lastState: PanelState | null = null;
  let lastAttachment: Attachment | null = null;
  const attachment = (): Attachment => {
    const s = client.getState();
    if (s !== lastState || lastAttachment === null) {
      lastState = s;
      lastAttachment = attachmentOf(s, opts.following);
    }
    return lastAttachment;
  };

  const source: ConsoleSource = {
    store,
    audit: { snapshot: () => shown().snap?.audit ?? NO_EVENTS, subscribe: (l) => client.subscribe(l) },
    registry,
    // Read live, not copied once: they depend on which snapshot is shown.
    get inspection(): InspectionLike | null {
      return shown().snap?.inspection ? inspection : null;
    },
    get inspectHosts(): readonly string[] {
      return shown().snap?.inspectHosts ?? NO_STRINGS;
    },
    get defaultRules(): RulesData {
      return shown().snap?.defaultRules ?? DEFAULT_RULES;
    },
    profileErrors: () => shown().snap?.profileErrors ?? NO_STRINGS,
    isReady: () => shown().snap?.ready ?? false,
    setProtectedTerms: (terms) => fire({ kind: "terms", terms }),
    clearLocalData: async () => {
      const r = await send({ kind: "clear-local-data" });
      if (!r.ok) throw new Error(r.error ?? "Local data was not cleared.");
    },
    loadRules: async (): Promise<RulesData> => {
      const snap = shown().snap;
      return snap?.rules ?? snap?.defaultRules ?? DEFAULT_RULES;
    },
    extension: {
      hosts: opts.hosts,
      subscribe: client.subscribe,
      attachment,
      model: {
        state: (): LocalState => shown().snap?.model.state ?? "unavailable",
        prepare: async () => {
          const r = await send({ kind: "model", op: "prepare" }, DOWNLOAD_MS);
          if (!r.ok) throw new Error(r.error ?? "The on-device model could not be prepared.");
        },
      },
    },
  };
  const refreshMs = opts.modelRefreshMs ?? 5000;
  const timer = refreshMs > 0 ? timers.setInterval(() => shown().frame && void client.command(shown().frame?.frameId ?? 0, { kind: "model", op: "refresh" }), refreshMs) : null;

  return {
    source,
    notice: {
      subscribe: (l) => (noticeListeners.add(l), () => noticeListeners.delete(l)),
      get: () => notice,
      clear: () => setNotice(null),
    },
    dispose: () => {
      if (timer !== null) timers.clearInterval(timer);
    },
  };
}
