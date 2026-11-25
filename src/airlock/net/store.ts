import type { PolicyResult } from "../core/policy.js";

export type Status =
  /** Held for inspection: nothing was sent, and the Inspect tab waits for the user's decision. */
  | "inspecting"
  | "analyzing"
  | "local-failed"
  | "awaiting-approval"
  | "blocked"
  | "sending"
  | "done"
  | "denied"
  | "failed";

export interface ClauseView {
  id: string;
  heading: string;
  tokens: number;
  /** Local-only copy of the clause text, for the side-by-side view. */
  text: string;
  selected: boolean;
  reason?: string;
  /** Plain-words reason this clause was withheld as instruction-like text. */
  flag?: string;
}

export interface RequestView {
  id: string;
  createdAt: number;
  url: string;
  host: string;
  status: Status;
  shape: "task+document" | "single" | "unknown";
  /** Local-only copies for the side-by-side view. They never leave the device. */
  task: string;
  originalDocument: string;
  clauses: ClauseView[];
  selection?: { source: "on_device" | "deterministic"; latencyMs: number; calls: number };
  prepared?: {
    maskedTask: string;
    outboundText: string;
    outboundBody: string;
    maskedCounts: Record<string, number>;
    maskedTotal: number;
    withheldClauses: number;
    mode: "minimize" | "mask-only";
  };
  /** Clauses withheld because they read like instructions to an AI. */
  flagged?: Array<{ id: string; why: string }>;
  policy?: PolicyResult;
  wireHash?: string;
  bytesSent?: number;
  cloudView?: string;
  restoredView?: string;
  unresolved?: string[];
  cloudLatencyMs?: number;
  /** Clause ids the answer cites, and any that were not part of what was sent. */
  citations?: { cited: string[]; outside: string[] };
  /** True when the demo injected an unauthorized value into the held payload. */
  injected?: boolean;
  /** Why a request was blocked or failed, in plain words. */
  message?: string;
  /** Why the local model could not run, when status is local-failed. */
  localError?: string;
  /** Which profile handled the request and which pipeline ran (absent for requests blocked before a profile matched). */
  profileId?: string;
  pipeline?: "ai-minimize" | "field-protect";
  /** Who wrote the profile: builtin, user, on_device or in_cloud. */
  authoredBy?: string;
  /** One entry per protected field: path, category and action only. Never a value. */
  fieldSummary?: FieldSummary[];
  /** How many fields got each action. */
  actionCounts?: Record<string, number>;
  /** The exact text that will leave, shown to the user on approval. Local-only copy; it holds no removed original. */
  outboundBody?: string;
  /** Plain-words notes: nothing to protect, answer not JSON, no response field found. */
  notes?: string[];
  /** Inline (CRM) mode only: why a person should look at this request later. Plain words, never a value. */
  reviewReasons?: string[];
  /** HTTP method of the request (upper case). */
  method?: string;
  /** URL path of the request, query string excluded. */
  path?: string;
  /** The destination rule that governed the request (for example saas-default). */
  destinationId?: string;
  /** "user" when the user approved the exact body, "auto" when a destination rule did. Absent when nothing needed approval. */
  approvedBy?: "user" | "auto";
  /** Epoch ms when AIRLOCK first saw the request. */
  startedAt?: number;
  /** Epoch ms when the request reached a terminal state (blocked, denied, failed or done). */
  endedAt?: number;
  /**
   * The exact body the page wrote, a local copy for the console's diff pane. Memory only: it is kept for the
   * latest ORIGINAL_BODY_RETENTION requests, then dropped, and it is never persisted, exported or logged.
   */
  originalBody?: string;
  /** How many leaves of the answer were restored to their original values (field-protect). */
  restoredCount?: number;
}

export interface FieldSummary {
  path: string;
  category?: string;
  action: string;
  restorable: boolean;
}

/** A deny may carry the plain-words reason it was made (the extension's fail-closed gate says why). */
export type Decision = { kind: "approve" } | { kind: "deny"; reason?: string } | { kind: "fallback" } | { kind: "inject" };

/** How many of the latest requests keep their originalBody. Older ones lose it. */
export const ORIGINAL_BODY_RETENTION = 50;

/** Observable state for the inspector. Snapshots are immutable so React can subscribe cheaply. */
export class AirlockStore {
  private views: RequestView[] = [];
  private listeners = new Set<() => void>();
  private waiting = new Map<string, (d: Decision) => void>();
  private pendingListeners = new Set<(id: string) => void>();
  /** Ids of views that hold an originalBody, oldest first. */
  private bodyHolders: string[] = [];

  getSnapshot = (): readonly RequestView[] => this.views;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  /** Track who holds an originalBody and drop the oldest copies beyond the retention, in the same state change. */
  private retain(id: string, views: RequestView[]): RequestView[] {
    const holds = views.find((v) => v.id === id)?.originalBody !== undefined;
    if (holds && !this.bodyHolders.includes(id)) this.bodyHolders.push(id);
    if (this.bodyHolders.length <= ORIGINAL_BODY_RETENTION) return views;
    const dropped = new Set(this.bodyHolders.splice(0, this.bodyHolders.length - ORIGINAL_BODY_RETENTION));
    return views.map((v) => {
      if (!dropped.has(v.id)) return v;
      const { originalBody: _gone, ...rest } = v;
      return rest;
    });
  }

  create(view: RequestView): void {
    this.views = this.retain(view.id, [...this.views, view]);
    this.emit();
  }

  update(id: string, patch: Partial<RequestView>): void {
    this.views = this.retain(
      id,
      this.views.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    );
    this.emit();
  }

  get(id: string): RequestView | undefined {
    return this.views.find((v) => v.id === id);
  }

  /** Resolves when the user (or a test) decides. Only one pending decision per request. */
  waitForDecision(id: string): Promise<Decision> {
    const decided = new Promise<Decision>((resolve) => this.waiting.set(id, resolve));
    // Notified after the waiter exists, so a listener may decide at once (fail closed) without a race.
    this.pendingListeners.forEach((l) => l(id));
    return decided;
  }

  /** Ids of requests that wait for a decision right now. */
  pendingIds = (): string[] => [...this.waiting.keys()];

  /** Called each time a request starts waiting for a decision. Returns an unsubscribe function. */
  onPending = (listener: (id: string) => void): (() => void) => {
    this.pendingListeners.add(listener);
    return () => this.pendingListeners.delete(listener);
  };

  private decide(id: string, d: Decision): void {
    const resolve = this.waiting.get(id);
    if (!resolve) return;
    this.waiting.delete(id);
    resolve(d);
  }

  approve = (id: string): void => this.decide(id, { kind: "approve" });
  deny = (id: string, reason?: string): void => this.decide(id, reason ? { kind: "deny", reason } : { kind: "deny" });
  useFallback = (id: string): void => this.decide(id, { kind: "fallback" });
  injectLeak = (id: string): void => this.decide(id, { kind: "inject" });
}
