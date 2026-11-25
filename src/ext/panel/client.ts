import type { ChromeLike, PortLike } from "../chrome-api.js";
import { PANEL_PORT_NAME, parseBackgroundToPanel, type PageSnapshot, type PanelCommand } from "../protocol.js";

export interface FrameState {
  frameId: number;
  host: string;
  /** False once the page's bridge disconnected (navigation, reload, extension restart). */
  up: boolean;
  snapshot: PageSnapshot | null;
}

export interface PanelState {
  tabId: number | null;
  connected: boolean;
  frames: readonly FrameState[];
}

export interface CommandResult {
  ok: boolean;
  error?: string;
}

/**
 * The side panel's end of the protocol: connects to the background, attaches to one tab, keeps the latest snapshot of
 * every frame of that tab and sends commands. Part of the console: the React side panel builds its RemoteStore on this.
 * Closing the panel (or this port) is what tells the page to block everything it still holds.
 */
export class PanelClient {
  private port: PortLike | null = null;
  private tabId: number | null = null;
  private frames = new Map<number, FrameState>();
  private listeners = new Set<() => void>();
  private pending = new Map<string, (r: CommandResult) => void>();
  private state: PanelState = { tabId: null, connected: false, frames: [] };
  private counter = 0;
  private closed = false;

  constructor(
    private readonly chrome: Pick<ChromeLike, "runtime">,
    private readonly opts: { commandTimeoutMs?: number; reconnectMs?: number; setTimeout?: (fn: () => void, ms: number) => unknown } = {},
  ) {}

  getState = (): PanelState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(): void {
    this.state = { tabId: this.tabId, connected: this.port !== null, frames: [...this.frames.values()].sort((a, b) => a.frameId - b.frameId) };
    this.listeners.forEach((l) => l());
  }

  /** Attach to a tab. Safe to call again to follow another tab. */
  attach(tabId: number): void {
    this.tabId = tabId;
    this.frames.clear();
    this.connect();
    this.publish();
  }

  private connect(): void {
    if (this.closed || this.tabId === null) return;
    if (this.port) {
      this.port.postMessage({ type: "attach", tabId: this.tabId });
      return;
    }
    const port = this.chrome.runtime.connect({ name: PANEL_PORT_NAME });
    this.port = port;
    port.onMessage.addListener((raw) => this.onMessage(raw));
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.port = null;
      this.frames.forEach((f) => (f.up = false));
      this.pending.forEach((resolve) => resolve({ ok: false, error: "The connection to the extension closed." }));
      this.pending.clear();
      this.publish();
      (this.opts.setTimeout ?? setTimeout)(() => this.connect(), this.opts.reconnectMs ?? 500);
    });
    port.postMessage({ type: "attach", tabId: this.tabId });
  }

  private onMessage(raw: unknown): void {
    const msg = parseBackgroundToPanel(raw);
    if (!msg || msg.tabId !== this.tabId) return;
    if (msg.type === "attached") {
      this.frames = new Map(msg.frames.map((f) => [f.frameId, { frameId: f.frameId, host: f.host, up: true, snapshot: null }]));
    } else if (msg.type === "page") {
      const f = this.frames.get(msg.frameId) ?? { frameId: msg.frameId, host: msg.host, up: msg.up, snapshot: null };
      this.frames.set(msg.frameId, { ...f, host: msg.host || f.host, up: msg.up, snapshot: msg.up ? f.snapshot : null });
    } else if (msg.type === "state") {
      const f = this.frames.get(msg.frameId) ?? { frameId: msg.frameId, host: msg.snapshot.host, up: true, snapshot: null };
      if (f.snapshot && msg.snapshot.seq <= f.snapshot.seq) return; // a stale publication
      this.frames.set(msg.frameId, { ...f, host: msg.snapshot.host, up: true, snapshot: msg.snapshot });
    } else {
      const resolve = this.pending.get(msg.cmdId);
      if (!resolve) return;
      this.pending.delete(msg.cmdId);
      resolve({ ok: msg.ok, error: msg.error });
      return;
    }
    this.publish();
  }

  /** Send a command to one frame of the attached tab. Resolves with the page's answer, or an error after the timeout. */
  command(frameId: number, command: PanelCommand, timeoutMs?: number): Promise<CommandResult> {
    const port = this.port;
    if (!port || this.tabId === null) return Promise.resolve({ ok: false, error: "Not connected to the extension." });
    const cmdId = `p-${++this.counter}`;
    return new Promise<CommandResult>((resolve) => {
      this.pending.set(cmdId, resolve);
      (this.opts.setTimeout ?? setTimeout)(() => {
        if (this.pending.delete(cmdId)) resolve({ ok: false, error: "The page did not answer." });
      }, timeoutMs ?? this.opts.commandTimeoutMs ?? 15_000);
      port.postMessage({ type: "command", tabId: this.tabId, frameId, cmdId, command });
    });
  }

  /** Disconnect for good. The page blocks whatever it still holds. */
  close(): void {
    this.closed = true;
    this.port?.disconnect();
    this.port = null;
    this.publish();
  }
}
