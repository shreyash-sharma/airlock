import type { ChromeEvent, ChromeLike, PortLike, RegisteredScript, SenderLike } from "../chrome-api.js";
import type { BridgeEvent, BridgeWindow } from "../bridge/bridge.js";
import type { LinkEvent, LinkWindow } from "../page/link.js";

/** Test doubles: a fake Chrome extension API and a fake window with real MessagePorts. Used by unit tests and nothing else. */

class Emitter<F extends (...args: never[]) => unknown> implements ChromeEvent<F> {
  readonly listeners = new Set<F>();
  addListener(f: F): void {
    this.listeners.add(f);
  }
  removeListener(f: F): void {
    this.listeners.delete(f);
  }
  emit(...args: Parameters<F>): void {
    [...this.listeners].forEach((l) => l(...args));
  }
}

export class FakePort implements PortLike {
  onMessage = new Emitter<(m: unknown) => void>();
  onDisconnect = new Emitter<() => void>();
  peer: FakePort | null = null;
  closed = false;
  /** Everything posted to this end, for assertions. */
  readonly posted: unknown[] = [];

  constructor(
    public name: string,
    public sender?: SenderLike,
  ) {}

  postMessage(message: unknown): void {
    if (this.closed) throw new Error("Attempting to use a disconnected port object");
    // Chrome serializes port messages as JSON: do the same so tests see what the real thing delivers.
    const copy: unknown = JSON.parse(JSON.stringify(message));
    this.posted.push(copy);
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer && !peer.closed) peer.onMessage.emit(copy);
    });
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    if (peer && !peer.closed) {
      peer.closed = true;
      queueMicrotask(() => peer.onDisconnect.emit());
    }
  }
}

export class FakeChrome implements ChromeLike {
  /** Who the next runtime.connect() call appears to be, as the background sees it. */
  nextSender: SenderLike = {};
  /** The background-side ends of every port opened. */
  readonly serverPorts: FakePort[] = [];
  readonly storageData: Record<string, unknown> = {};
  readonly registered = new Map<string, RegisteredScript>();
  /** Patterns the browser has granted. */
  readonly granted = new Set<string>();
  readonly extensionId = "ombmjhkmnofdcbfafhjcnppjdkalekan";

  private readonly onConnect = new Emitter<(port: PortLike) => void>();
  private readonly onMessage = new Emitter<(m: unknown, s: SenderLike, r: (x: unknown) => void) => boolean | void>();
  private readonly onChanged = new Emitter<(c: Record<string, { newValue?: unknown }>, area: string) => void>();

  runtime: ChromeLike["runtime"] = {
    id: this.extensionId,
    getURL: (path: string) => `chrome-extension://${this.extensionId}/${path}`,
    connect: (info) => {
      const client = new FakePort(info.name);
      const server = new FakePort(info.name, this.nextSender);
      client.peer = server;
      server.peer = client;
      this.serverPorts.push(server);
      queueMicrotask(() => this.onConnect.emit(server));
      return client;
    },
    onConnect: this.onConnect,
    onMessage: this.onMessage,
    onInstalled: new Emitter<() => void>(),
    onStartup: new Emitter<() => void>(),
  };

  storage: ChromeLike["storage"] = {
    local: {
      get: async (key) => (key in this.storageData ? { [key]: this.storageData[key] } : {}),
      set: async (items) => {
        const changes: Record<string, { newValue?: unknown }> = {};
        for (const [k, v] of Object.entries(items)) {
          this.storageData[k] = v;
          changes[k] = { newValue: v };
        }
        this.onChanged.emit(changes, "local");
      },
    },
    onChanged: this.onChanged,
  };

  scripting: ChromeLike["scripting"] = {
    registerContentScripts: async (scripts) => {
      for (const s of scripts) {
        if (this.registered.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
        for (const m of s.matches ?? []) if (!this.granted.has(m)) throw new Error(`Cannot access contents of the page for ${m}`);
      }
      for (const s of scripts) this.registered.set(s.id, s);
    },
    unregisterContentScripts: async (filter) => {
      for (const id of filter?.ids ?? [...this.registered.keys()]) {
        if (!this.registered.delete(id)) throw new Error(`Nonexistent script ID '${id}'`);
      }
    },
    getRegisteredContentScripts: async (filter) => [...this.registered.values()].filter((s) => !filter?.ids || filter.ids.includes(s.id)),
  };

  permissions: ChromeLike["permissions"] = {
    contains: async ({ origins }) => origins.every((o) => this.granted.has(o)),
    onAdded: new Emitter<() => void>(),
    onRemoved: new Emitter<() => void>(),
  };

  /** Deliver chrome.runtime.sendMessage from a sender and collect the response. */
  async sendMessage(message: unknown, sender: SenderLike): Promise<unknown> {
    return new Promise((resolve) => {
      let answered = false;
      const respond = (x: unknown): void => {
        answered = true;
        resolve(x);
      };
      let async = false;
      for (const l of this.onMessage.listeners) if (l(message, sender, respond) === true) async = true;
      if (!async && !answered) resolve(undefined);
    });
  }
}

/** The page's window, shared by the MAIN-world link and the ISOLATED-world bridge, as in a real tab. */
export class FakeWindow implements LinkWindow, BridgeWindow {
  private readonly listeners: Array<(e: LinkEvent & BridgeEvent) => void> = [];
  /** Messages a hostile page script posted (for tests that spoof). */
  readonly seenByPage: unknown[] = [];

  addEventListener(_type: "message", listener: (e: LinkEvent & BridgeEvent) => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: "message", listener: (e: LinkEvent & BridgeEvent) => void): void {
    const at = this.listeners.indexOf(listener);
    if (at !== -1) this.listeners.splice(at, 1);
  }

  /** window.postMessage: delivered asynchronously to every listener in registration order, unless one stops it. */
  postMessage(message: unknown, _targetOrigin: string, transfer: unknown[] = []): void {
    this.deliver(message, this, transfer);
  }

  /** Deliver a message as if posted by another source (for spoofing tests). */
  postFrom(source: unknown, message: unknown, transfer: unknown[] = []): void {
    this.deliver(message, source, transfer);
  }

  private deliver(data: unknown, source: unknown, ports: unknown[]): void {
    queueMicrotask(() => {
      let stopped = false;
      const event = { data, source, ports, stopImmediatePropagation: () => (stopped = true) };
      for (const l of [...this.listeners]) {
        if (stopped) break;
        l(event);
      }
      // A page script registered after the AIRLOCK listeners: it only sees what was not swallowed.
      if (!stopped) this.seenByPage.push(data);
    });
  }
}

/** Let queued microtasks and real MessagePort deliveries run. Immune to fake timers. */
export async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => {
        port1.close();
        port2.close();
        resolve();
      };
      port2.postMessage(0);
    });
  }
}
