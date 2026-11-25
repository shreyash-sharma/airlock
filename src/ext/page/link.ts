import {
  BRIDGE_STALE_MS,
  isHandshake,
  parseBridgeMessage,
  unwrap,
  WINDOW_CHANNEL,
  wrap,
  type PageMessage,
  type PanelCommand,
} from "../protocol.js";

/** The slice of a MessagePort the link uses. */
export interface PortEnd {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface LinkEvent {
  data: unknown;
  source: unknown;
  ports?: readonly unknown[];
  stopImmediatePropagation(): void;
}

/** The slice of window the link uses. */
export interface LinkWindow {
  addEventListener(type: "message", listener: (e: LinkEvent) => void, capture?: boolean): void;
  removeEventListener(type: "message", listener: (e: LinkEvent) => void, capture?: boolean): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface LinkDeps {
  win: LinkWindow;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
}

export interface LinkHandlers {
  onCommand(cmdId: string, command: PanelCommand): void;
  onHosts(hosts: string[]): void;
  onSettings(holdTimeoutMs: number): void;
  /** The side panel (or the bridge that reports it) went up or down. Down includes a silent bridge. */
  onPanelChange(up: boolean): void;
  /** The handshake just completed (or the bridge came back): publish the current state. */
  onConnect(): void;
}

/**
 * The page end of the bridge, running in the MAIN world next to untrusted page scripts.
 *
 * The page script registers this listener at document_start, before any page script exists, and swallows every
 * handshake message with stopImmediatePropagation so page code never sees the transferred port. Only the first
 * handshake from window itself is accepted; after it, all traffic flows over the private MessagePort and each
 * message must carry the per-page nonce. Anything else is dropped and counted.
 *
 * Residual limit, stated honestly: nothing in the MAIN world can authenticate against a page script that wins a
 * race to send the handshake. Both content scripts run at document_start before page scripts, which closes it in
 * practice; the fail-closed gate means a missing or stale bridge denies every held request regardless.
 */
export class PageLink {
  private port: PortEnd | null = null;
  private nonce = "";
  private lastHeartbeat = 0;
  private panel = false;
  private alive = false;
  private readonly onWindowMessage = (e: LinkEvent): void => this.handleWindowMessage(e);
  /** Messages dropped: wrong source, wrong nonce, unknown shape, second handshake. For tests and the console. */
  rejected = 0;

  constructor(
    private readonly deps: LinkDeps,
    private readonly handlers: LinkHandlers,
  ) {}

  start(): void {
    this.deps.win.addEventListener("message", this.onWindowMessage, true);
    // Tell a bridge that started first that this end is listening. Carries no secret.
    this.deps.win.postMessage({ channel: WINDOW_CHANNEL, kind: "ready" }, "*");
  }

  stop(): void {
    this.deps.win.removeEventListener("message", this.onWindowMessage, true);
    if (this.port) {
      this.port.onmessage = null;
      this.port.close();
    }
    this.port = null;
    this.setAlive(false);
  }

  /** True while a handshake has completed. */
  connected(): boolean {
    return this.port !== null;
  }

  /** True when the bridge is fresh AND it reports a side panel attached to this tab. */
  panelUp(): boolean {
    return this.alive && this.panel;
  }

  send(msg: PageMessage): void {
    if (!this.port) return;
    this.port.postMessage(wrap(this.nonce, msg));
  }

  private handleWindowMessage(e: LinkEvent): void {
    const data = e.data;
    if (!isHandshake(data)) return;
    // Swallow every handshake, valid or not, so no page listener registered later sees it or its port.
    e.stopImmediatePropagation();
    if (e.source !== this.deps.win || this.port || !e.ports || e.ports.length !== 1) {
      this.rejected++;
      return;
    }
    const port = e.ports[0] as PortEnd;
    this.port = port;
    this.nonce = data.nonce;
    this.lastHeartbeat = this.deps.now();
    port.onmessage = (ev) => this.handlePortMessage(ev.data);
    this.handlers.onConnect();
  }

  private handlePortMessage(raw: unknown): void {
    const inner = unwrap(raw, this.nonce);
    const msg = inner === null ? null : parseBridgeMessage(inner);
    if (!msg) {
      this.rejected++;
      return;
    }
    if (msg.type === "hb") {
      this.lastHeartbeat = this.deps.now();
      const wasPanel = this.panelUp();
      this.panel = msg.panel;
      this.setAlive(true, wasPanel);
    } else if (msg.type === "hosts") {
      this.handlers.onHosts(msg.hosts);
    } else if (msg.type === "settings") {
      this.handlers.onSettings(msg.holdTimeoutMs);
    } else {
      this.handlers.onCommand(msg.cmdId, msg.command);
    }
  }

  /**
   * Probe the bridge now. If no heartbeat answers within BRIDGE_STALE_MS (extension reloaded, worker gone, bridge
   * dead) the panel counts as down, which makes the gate block everything that waits. Message delivery is not
   * throttled in a hidden tab, so a live bridge always answers; the timeout only has to outlast a slow worker.
   */
  verify(): void {
    if (!this.port) return;
    const sentAt = this.deps.now();
    this.send({ type: "ping" });
    this.deps.setTimeout(() => {
      if (this.port && this.lastHeartbeat < sentAt) this.setAlive(false);
    }, BRIDGE_STALE_MS);
  }

  private setAlive(alive: boolean, wasPanelUp = this.panelUp()): void {
    this.alive = alive;
    const up = this.panelUp();
    if (up !== wasPanelUp) this.handlers.onPanelChange(up);
  }
}
