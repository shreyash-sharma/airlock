import type { AuditLog } from "../../airlock/core/audit.js";
import type { InspectionStore } from "../../airlock/inspect/session.js";
import type { AirlockStore } from "../../airlock/net/store.js";
import { DEFAULT_HOLD_TIMEOUT_MS } from "../protocol.js";

export interface GateTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GateOptions {
  store: AirlockStore;
  /** Held inspection requests are discarded the same way. Null when inspection is off. */
  inspection: InspectionStore | null;
  audit: AuditLog;
  /** True only while a side panel is attached and the bridge is fresh. */
  panelUp(): boolean;
  timeoutMs?: number;
  timers: GateTimers;
  /** Probe the bridge for liveness. Called when a request starts waiting and every VERIFY_EVERY_MS while any waits. */
  verify?: () => void;
}

const VERIFY_EVERY_MS = 2_000;

export const REASON_NO_PANEL = "The AIRLOCK side panel is not open, so there is nobody to approve this request. Open the panel and try again. Nothing was sent.";
export const REASON_PANEL_CLOSED = "The AIRLOCK side panel closed or disconnected while this request was waiting. Nothing was sent.";

export const reasonTimeout = (ms: number): string => `Nobody answered within ${Math.round(ms / 1000)} seconds, so AIRLOCK blocked this request. Nothing was sent.`;

/**
 * Fail closed (EXT-04). A request that waits for a decision is blocked when
 *   - the side panel or the bridge is missing at the moment it starts waiting,
 *   - the panel closes, the bridge errors or the port disconnects while it waits, or
 *   - nobody answers within the timeout.
 * Blocking is a deny with a plain-words reason, so the page gets a rejected fetch (or an XHR network error) and the
 * console and audit show why. The gate only ever ends waits: it can never approve anything.
 */
export class FailClosedGate {
  private timeoutMs: number;
  private readonly timers = new Map<string, unknown>();
  private off: Array<() => void> = [];
  private panelWasUp: boolean;
  private verifying = false;

  constructor(private readonly o: GateOptions) {
    this.timeoutMs = o.timeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;
    this.panelWasUp = o.panelUp();
  }

  get timeout(): number {
    return this.timeoutMs;
  }

  /** Applies to requests that start waiting from now on. */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  start(): void {
    this.off.push(this.o.store.onPending((id) => this.watch("request", id)));
    if (this.o.inspection) this.off.push(this.o.inspection.onPending((id) => this.watch("inspection", id)));
  }

  stop(): void {
    this.off.forEach((f) => f());
    this.off = [];
    this.timers.forEach((h) => this.o.timers.clearTimeout(h));
    this.timers.clear();
  }

  /** Call when the panel goes up or down. Going down ends every wait at once. */
  panelChanged(up: boolean): void {
    if (this.panelWasUp && !up) this.denyAll(REASON_PANEL_CLOSED);
    this.panelWasUp = up;
  }

  private watch(kind: "request" | "inspection", id: string): void {
    if (!this.o.panelUp()) {
      this.deny(kind, id, REASON_NO_PANEL);
      return;
    }
    this.verifyLoop();
    const key = `${kind}:${id}`;
    this.timers.set(
      key,
      this.o.timers.setTimeout(() => {
        this.timers.delete(key);
        this.deny(kind, id, reasonTimeout(this.timeoutMs));
      }, this.timeoutMs),
    );
  }

  /** While anything waits, keep checking that the bridge still answers. */
  private verifyLoop(): void {
    if (!this.o.verify) return;
    this.o.verify();
    if (this.verifying) return;
    this.verifying = true;
    const tick = (): void => {
      if (this.o.store.pendingIds().length + (this.o.inspection?.pendingIds().length ?? 0) === 0) {
        this.verifying = false;
        return;
      }
      this.o.verify?.();
      this.o.timers.setTimeout(tick, VERIFY_EVERY_MS);
    };
    this.o.timers.setTimeout(tick, VERIFY_EVERY_MS);
  }

  private denyAll(reason: string): void {
    for (const id of this.o.store.pendingIds()) this.deny("request", id, reason);
    for (const id of this.o.inspection?.pendingIds() ?? []) this.deny("inspection", id, reason);
  }

  private deny(kind: "request" | "inspection", id: string, reason: string): void {
    const key = `${kind}:${id}`;
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      this.o.timers.clearTimeout(timer);
      this.timers.delete(key);
    }
    if (kind === "request") {
      if (!this.o.store.pendingIds().includes(id)) return;
      this.o.store.deny(id, reason);
      return;
    }
    if (!this.o.inspection?.pendingIds().includes(id)) return;
    this.o.audit.add({ kind: "denied", requestId: id, where: "code", detail: { stage: "inspection", reason } });
    this.o.inspection.discard(id);
  }
}
