import type { ChromeLike, PortLike, SenderLike } from "../chrome-api.js";
import {
  DEFAULT_HOLD_TIMEOUT_MS,
  PAGE_PORT_NAME,
  PANEL_PORT_NAME,
  parseExtensionRequest,
  parsePageMessage,
  parsePanelToBackground,
  type BackgroundToBridge,
  type BackgroundToPanel,
  type ExtensionResponse,
} from "../protocol.js";
import type { HostList } from "./hosts.js";

/** Reads the hold timeout from storage (clamped, default when absent). */
export type TimeoutSource = () => Promise<number>;

interface PageEntry {
  port: PortLike;
  host: string;
}

interface PanelEntry {
  port: PortLike;
  tabId: number | null;
}

/**
 * The service worker's switchboard. Page ports (one per frame, from the ISOLATED bridge) and panel ports (the side
 * panel, an extension page) meet here. The router never inspects values and never keeps state across a restart: when
 * the worker is killed every port disconnects, and every page fails closed.
 *
 * A panel is attached to one tab. That tab's pages are told "panel up" for as long as at least one attached panel
 * port is open, and "panel down" the moment the last one closes, so closing the side panel blocks held requests.
 */
export class Router {
  private pages = new Map<number, Map<number, PageEntry>>();
  private panels = new Set<PanelEntry>();
  private snapshotSeq = 0;

  constructor(
    private readonly chrome: Pick<ChromeLike, "runtime">,
    private readonly hosts: HostList,
    private readonly holdTimeout: TimeoutSource = async () => DEFAULT_HOLD_TIMEOUT_MS,
  ) {}

  /** True when a message came from one of this extension's own pages (not a content script, not a web page). */
  private isExtensionPage(sender: SenderLike | undefined): boolean {
    return sender?.id === this.chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(this.chrome.runtime.getURL(""));
  }

  onConnect(port: PortLike): void {
    if (port.name === PAGE_PORT_NAME) this.connectPage(port);
    else if (port.name === PANEL_PORT_NAME && this.isExtensionPage(port.sender)) this.connectPanel(port);
    else port.disconnect();
  }

  /** Hosts a page may protect right now: configured and granted. Pushed to every open page when the list changes. */
  async pushHosts(): Promise<void> {
    const active = await this.hosts.granted();
    for (const frames of this.pages.values()) for (const e of frames.values()) this.toPage(e.port, { type: "hosts", hosts: active });
  }

  /** Tell every open page the current hold timeout. */
  async pushSettings(): Promise<void> {
    const holdTimeoutMs = await this.holdTimeout();
    for (const frames of this.pages.values()) for (const e of frames.values()) this.toPage(e.port, { type: "settings", holdTimeoutMs });
  }

  /** Handle chrome.runtime.sendMessage from an extension page: read or change the host list. */
  async onRequest(message: unknown, sender: SenderLike): Promise<ExtensionResponse> {
    if (!this.isExtensionPage(sender)) return { ok: false, errors: ["Only AIRLOCK's own pages may use this."] };
    const req = parseExtensionRequest(message);
    if (!req) return { ok: false, errors: ["Unknown request."] };
    if (req.type === "hosts:set") {
      const r = await this.hosts.set(req.hosts);
      if (!r.ok) return r;
    }
    const state = await this.hosts.sync();
    if (req.type === "hosts:set") await this.pushHosts();
    return { ok: true, state };
  }

  /* -------------------------------------------------------------- pages */

  private toPage(port: PortLike, msg: BackgroundToBridge): void {
    try {
      port.postMessage(msg);
    } catch {
      /* a closed port is handled by its disconnect */
    }
  }

  private toPanel(p: PanelEntry, msg: BackgroundToPanel): void {
    try {
      p.port.postMessage(msg);
    } catch {
      /* a closed port is handled by its disconnect */
    }
  }

  private panelsFor(tabId: number): PanelEntry[] {
    return [...this.panels].filter((p) => p.tabId === tabId);
  }

  private framesOf(tabId: number): Array<[number, PageEntry]> {
    return [...(this.pages.get(tabId)?.entries() ?? [])];
  }

  private announcePanel(tabId: number): void {
    const up = this.panelsFor(tabId).length > 0;
    for (const [, e] of this.framesOf(tabId)) this.toPage(e.port, { type: "panel", up });
  }

  private connectPage(port: PortLike): void {
    const tabId = port.sender?.tab?.id;
    if (typeof tabId !== "number" || this.isExtensionPage(port.sender)) {
      port.disconnect();
      return;
    }
    const frameId = port.sender?.frameId ?? 0;
    const frames = this.pages.get(tabId) ?? new Map<number, PageEntry>();
    this.pages.set(tabId, frames);
    const entry: PageEntry = { port, host: "" };
    frames.set(frameId, entry);

    this.toPage(port, { type: "panel", up: this.panelsFor(tabId).length > 0 });
    void this.hosts.granted().then((active) => this.toPage(port, { type: "hosts", hosts: active }));
    void this.holdTimeout().then((holdTimeoutMs) => this.toPage(port, { type: "settings", holdTimeoutMs }));

    port.onMessage.addListener((raw) => {
      const msg = parsePageMessage(raw);
      if (!msg) return;
      if (msg.type === "hello") {
        entry.host = msg.host;
        for (const p of this.panelsFor(tabId)) {
          this.toPanel(p, { type: "page", tabId, frameId, host: msg.host, up: true });
          this.toPage(port, { type: "command", cmdId: `bg-${++this.snapshotSeq}`, command: { kind: "snapshot" } });
        }
      } else if (msg.type === "state") {
        for (const p of this.panelsFor(tabId)) this.toPanel(p, { type: "state", tabId, frameId, snapshot: msg.snapshot });
      } else if (msg.type === "result") {
        for (const p of this.panelsFor(tabId)) this.toPanel(p, { type: "result", tabId, frameId, cmdId: msg.cmdId, ok: msg.ok, error: msg.error });
      }
    });
    port.onDisconnect.addListener(() => {
      if (frames.get(frameId) === entry) frames.delete(frameId);
      if (frames.size === 0 && this.pages.get(tabId) === frames) this.pages.delete(tabId);
      for (const p of this.panelsFor(tabId)) this.toPanel(p, { type: "page", tabId, frameId, host: entry.host, up: false });
    });
  }

  /* -------------------------------------------------------------- panels */

  private connectPanel(port: PortLike): void {
    const entry: PanelEntry = { port, tabId: null };
    this.panels.add(entry);

    port.onMessage.addListener((raw) => {
      const msg = parsePanelToBackground(raw);
      if (!msg) return;
      if (msg.type === "attach") {
        const previous = entry.tabId;
        entry.tabId = msg.tabId;
        if (previous !== null && previous !== msg.tabId) this.announcePanel(previous);
        this.toPanel(entry, { type: "attached", tabId: msg.tabId, frames: this.framesOf(msg.tabId).map(([frameId, e]) => ({ frameId, host: e.host })) });
        this.announcePanel(msg.tabId);
        for (const [, e] of this.framesOf(msg.tabId)) this.toPage(e.port, { type: "command", cmdId: `bg-${++this.snapshotSeq}`, command: { kind: "snapshot" } });
      } else if (entry.tabId === msg.tabId) {
        const page = this.pages.get(msg.tabId)?.get(msg.frameId);
        if (page) this.toPage(page.port, { type: "command", cmdId: msg.cmdId, command: msg.command });
        else this.toPanel(entry, { type: "result", tabId: msg.tabId, frameId: msg.frameId, cmdId: msg.cmdId, ok: false, error: "That page is no longer connected." });
      }
    });
    port.onDisconnect.addListener(() => {
      this.panels.delete(entry);
      if (entry.tabId !== null) this.announcePanel(entry.tabId);
    });
  }
}
