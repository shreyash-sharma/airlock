import type { ChromeLike, PortLike } from "../chrome-api.js";
import {
  HEARTBEAT_INTERVAL_MS,
  isReady,
  PAGE_PORT_NAME,
  parseBackgroundToBridge,
  parsePageMessage,
  unwrap,
  WINDOW_CHANNEL,
  wrap,
  type BridgeMessage,
  type PageMessage,
} from "../protocol.js";

export interface BridgeEvent {
  data: unknown;
  source: unknown;
}

export interface BridgeWindow {
  addEventListener(type: "message", listener: (e: BridgeEvent) => void): void;
  removeEventListener(type: "message", listener: (e: BridgeEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string, transfer?: unknown[]): void;
}

export interface ChannelPair {
  port1: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void; close(): void };
  port2: unknown;
}

export interface BridgeEnv {
  win: BridgeWindow;
  chrome: Pick<ChromeLike, "runtime">;
  newChannel(): ChannelPair;
  /** A fresh unguessable per-page nonce. */
  nonce(): string;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  /** How long to wait before trying to reconnect to the background, in ms. */
  reconnectMs?: number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const MAX_OFFERS = 4;

export interface BridgeHandle {
  stop(): void;
  /** For tests: whether the page end answered the handshake. */
  paired(): boolean;
}

/**
 * The ISOLATED-world content script. It is the only code that can reach the background (chrome.runtime) and the only
 * code on the page that the page cannot touch. It
 *   - hands the MAIN page script a private MessagePort and a per-page nonce, once, over window.postMessage;
 *   - relays the page's state and command results to the background, and the panel's commands back;
 *   - tells the page every second whether a side panel is attached (the heartbeat the page's fail-closed gate watches).
 * A page script posting to window cannot impersonate either end: window traffic is only the handshake, and everything
 * else needs the nonce and the port.
 */
export function startBridge(env: BridgeEnv): BridgeHandle {
  const nonce = env.nonce();
  /** Handshakes offered and not yet answered. The page script accepts the first one it hears; the rest are closed once one pairs. */
  let offered: ChannelPair[] = [];
  let channel: ChannelPair | null = null; // the one that paired
  let paired = false;
  let panelUp = false;
  let hosts: string[] | null = null;
  let settings: number | null = null;
  let lastHello: PageMessage | null = null;
  let stopped = false;
  let bg: PortLike | null = null;
  let reconnectTimer: unknown = null;

  const toPage = (msg: BridgeMessage): void => channel?.port1.postMessage(wrap(nonce, msg));
  const heartbeat = (): void => {
    if (paired) toPage({ type: "hb", panel: panelUp && bg !== null });
  };

  function handshake(): void {
    // A "ready" can cross our first handshake in flight, so earlier offers stay open until one is answered.
    if (paired || offered.length >= MAX_OFFERS) return;
    const offer = env.newChannel();
    offered.push(offer);
    offer.port1.onmessage = (e) => onPageMessage(offer, e.data);
    env.win.postMessage({ channel: WINDOW_CHANNEL, kind: "handshake", nonce }, "*", [offer.port2]);
  }

  function onPageMessage(from: ChannelPair, raw: unknown): void {
    if (channel && from !== channel) return;
    const inner = unwrap(raw, nonce);
    const msg = inner === null ? null : parsePageMessage(inner);
    if (!msg) return;
    if (msg.type === "ping") {
      heartbeat(); // the answer to a liveness probe
      return;
    }
    if (msg.type === "hello") {
      if (!paired) {
        channel = from;
        for (const o of offered) if (o !== from) o.port1.close();
        offered = [];
      }
      paired = true;
      lastHello = msg;
      if (hosts) toPage({ type: "hosts", hosts });
      if (settings !== null) toPage({ type: "settings", holdTimeoutMs: settings });
      heartbeat();
    }
    bg?.postMessage(msg);
  }

  function onBackgroundMessage(raw: unknown): void {
    const msg = parseBackgroundToBridge(raw);
    if (!msg) return;
    if (msg.type === "panel") {
      panelUp = msg.up;
      heartbeat();
    } else if (msg.type === "hosts") {
      hosts = msg.hosts;
      toPage({ type: "hosts", hosts: msg.hosts });
    } else if (msg.type === "settings") {
      settings = msg.holdTimeoutMs;
      toPage(msg);
    } else {
      toPage({ type: "command", cmdId: msg.cmdId, command: msg.command });
    }
  }

  function connect(): void {
    if (stopped) return;
    try {
      const port = env.chrome.runtime.connect({ name: PAGE_PORT_NAME });
      bg = port;
      port.onMessage.addListener(onBackgroundMessage);
      port.onDisconnect.addListener(() => {
        // The worker went away or the extension reloaded: no panel can be reached any more.
        if (bg === port) bg = null;
        panelUp = false;
        heartbeat();
        scheduleReconnect();
      });
      if (lastHello) port.postMessage(lastHello);
    } catch {
      // Extension context invalidated: there is nothing to reconnect to. The heartbeat keeps saying "no panel".
      bg = null;
      panelUp = false;
    }
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) return;
    reconnectTimer = env.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, env.reconnectMs ?? 1_000);
  }

  const onWindowMessage = (e: BridgeEvent): void => {
    // Only the page script's own "ready" matters, and only before the pair is made.
    if (e.source === env.win && !paired && isReady(e.data)) handshake();
  };

  env.win.addEventListener("message", onWindowMessage);
  connect();
  handshake();
  const timer = env.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);

  return {
    paired: () => paired,
    stop: () => {
      stopped = true;
      env.win.removeEventListener("message", onWindowMessage);
      env.clearInterval(timer);
      if (reconnectTimer !== null) env.clearTimeout(reconnectTimer);
      channel?.port1.close();
      for (const o of offered) o.port1.close();
      bg?.disconnect();
      bg = null;
    },
  };
}
