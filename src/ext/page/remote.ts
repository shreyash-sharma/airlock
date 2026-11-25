import { readLocalStatus, type LocalState } from "../../airlock/ai/local.js";
import type { InstalledAirlock } from "../../airlock/install.js";
import type { PageLink } from "./link.js";
import type { FailClosedGate } from "./failclosed.js";
import type { PageSnapshot, PanelCommand } from "../protocol.js";

export interface RemoteDeps {
  installed: InstalledAirlock;
  link: PageLink;
  gate: FailClosedGate;
  host: string;
  /** Debounce for publishing, in ms. */
  publishDelayMs?: number;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  /** Injectable for tests. */
  localStatus?: () => Promise<LocalState>;
}

/**
 * The "remote console" adapter: the extension's replacement for mounting the React console in the page. It publishes
 * the same state the console reads (requests, audit, profiles, rules, inspection, model status) to the side panel
 * over the bridge, and runs the commands the panel sends back (approve, deny, inspection steps, profile edits).
 * The panel is local to the user's browser and may see originalBody; nothing here talks to a remote host.
 */
export class RemoteHost {
  private seq = 0;
  private timer: unknown = null;
  private model: LocalState = "unavailable";
  private terms: string[] = [];
  private off: Array<() => void> = [];

  constructor(private readonly d: RemoteDeps) {}

  start(): void {
    const { installed } = this.d;
    const schedule = (): void => this.schedule();
    this.off.push(installed.store.subscribe(schedule));
    this.off.push(installed.audit.subscribe(schedule));
    this.off.push(installed.registry.subscribe(schedule));
    if (installed.inspection) this.off.push(installed.inspection.subscribe(schedule));
    void this.refreshModel();
  }

  stop(): void {
    this.off.forEach((f) => f());
    this.off = [];
    if (this.timer !== null) this.d.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /** The handshake completed or the panel attached: tell the page's name and send the full state now. */
  connected(): void {
    this.d.link.send({ type: "hello", host: this.d.host });
    void this.publish();
  }

  private schedule(): void {
    if (this.timer !== null || !this.d.link.panelUp()) return;
    this.timer = this.d.timers.setTimeout(() => {
      this.timer = null;
      void this.publish();
    }, this.d.publishDelayMs ?? 40);
  }

  private async refreshModel(): Promise<void> {
    try {
      this.model = await (this.d.localStatus ?? readLocalStatus)();
    } catch {
      this.model = "unavailable";
    }
    this.schedule();
  }

  async snapshot(): Promise<PageSnapshot> {
    const { installed } = this.d;
    let rules: PageSnapshot["rules"] = null;
    try {
      rules = await installed.rules();
    } catch {
      rules = null;
    }
    return {
      seq: ++this.seq,
      host: this.d.host,
      ready: installed.engine.isReady(),
      requests: [...installed.store.getSnapshot()],
      audit: [...installed.audit.snapshot()],
      profiles: installed.registry.entries(),
      profileErrors: [...installed.profileErrors()],
      rules,
      defaultRules: installed.defaultRules,
      inspection: installed.inspection ? [...installed.inspection.getSnapshot()] : null,
      inspectHosts: [...installed.inspectHosts],
      model: { state: this.model },
      failClosed: { timeoutMs: this.d.gate.timeout, panelUp: this.d.link.panelUp() },
      protectedTerms: [...this.terms],
    };
  }

  async publish(): Promise<void> {
    if (!this.d.link.connected()) return;
    this.d.link.send({ type: "state", snapshot: await this.snapshot() });
  }

  /** Run one validated command and report the outcome. Never throws. */
  async run(cmdId: string, command: PanelCommand): Promise<void> {
    let ok = true;
    let error: string | undefined;
    try {
      error = await this.execute(command);
      if (error !== undefined) ok = false;
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
    }
    this.d.link.send({ type: "result", cmdId, ok, ...(error !== undefined ? { error } : {}) });
  }

  /** Returns an error message, or undefined on success. */
  private async execute(c: PanelCommand): Promise<string | undefined> {
    const { installed } = this.d;
    switch (c.kind) {
      case "snapshot":
        await this.publish();
        return undefined;
      case "decide": {
        if (!installed.store.pendingIds().includes(c.id)) return "That request is not waiting for a decision (it may have timed out or been blocked).";
        if (c.decision === "approve") installed.store.approve(c.id);
        else if (c.decision === "deny") installed.store.deny(c.id);
        else installed.store.useFallback(c.id);
        return undefined;
      }
      case "inspect": {
        const insp = installed.inspection;
        if (!insp) return "Inspection is off.";
        if (!insp.get(c.id)) return "That inspection item does not exist.";
        if (c.op === "classify") await insp.classify(c.id);
        else if (c.op === "author") await insp.author(c.id);
        else if (c.op === "discard") insp.discard(c.id);
        else if (c.op === "passThrough") insp.passThrough(c.id);
        else {
          const r = await insp.approve(c.id);
          if (!r.ok) return r.errors.join("; ") || "The profile could not be approved.";
        }
        return undefined;
      }
      case "inspect-edit": {
        if (!installed.inspection) return "Inspection is off.";
        await installed.inspection.edit(c.id, c.path, c.action, c.category);
        return undefined;
      }
      case "inspect-locator": {
        if (!installed.inspection) return "Inspection is off.";
        await installed.inspection.setLocatorAccepted(c.id, c.locator, c.accepted);
        return undefined;
      }
      case "inspect-add-locator": {
        if (!installed.inspection) return "Inspection is off.";
        const r = await installed.inspection.addLocator(c.id, c.locator);
        return r.ok ? undefined : (r.error ?? "That locator was not accepted.");
      }
      case "inspect-add-get": {
        if (!installed.inspection) return "Inspection is off.";
        await installed.inspection.addGet(c.id);
        return undefined;
      }
      case "profile-save": {
        const r = await installed.registry.save(c.profile);
        return r.ok ? undefined : r.errors.join("; ");
      }
      case "profile-remove": {
        const r = await installed.registry.remove(c.id);
        return r.ok ? undefined : (r.reason ?? "The profile could not be removed.");
      }
      case "rules-save": {
        const r = await installed.registry.saveRules(c.rules);
        return r.ok ? undefined : r.errors.join("; ");
      }
      case "terms":
        this.terms = c.terms;
        installed.setProtectedTerms(c.terms);
        this.schedule();
        return undefined;
      case "clear-local-data":
        await installed.engine.clearLocalData();
        return undefined;
      case "model": {
        if (c.op === "refresh") {
          await this.refreshModel();
          return undefined;
        }
        if (!installed.analyzer) return "No on-device model is configured.";
        try {
          if (c.op === "prepare") await installed.analyzer.prepare();
          else await installed.analyzer.warm();
        } finally {
          await this.refreshModel();
        }
        return undefined;
      }
    }
  }
}
