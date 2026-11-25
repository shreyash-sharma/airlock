import type { LocalModelLike, LocalState } from "../ai/local.js";
import type { Action, Category, DryRun, DryRunResult, Profile, RulesData } from "../profiles/types.js";
import type { SaveResult } from "../profiles/storage.js";
import { Capture, type Leaf } from "./capture.js";
import { classifyFields, type Classification } from "./classify.js";
import { authorProfile, vetProfile, type AuthoringModelLike, type BeforeCall } from "./author.js";
import { pathsWithRecords, suggestResponseLocators, validateLocator, type LocatorSuggestion } from "../learn/locators.js";
import type { Observation } from "../learn/shape.js";

/**
 * One inspection session: a request held for learning, its classification, the authored profile and the
 * user's decision. Nothing is saved before approve(). The captured values live in the Capture and are
 * cleared the moment a decision resolves (CONTEXT: values never outlive the decision).
 */

export type InspectDecision = "pass-through" | "saved" | "discarded";
export type InspectStatus = "held" | "classifying" | "authoring" | "ready" | "rejected" | "saved" | "discarded" | "passed-through";

export interface InspectItem {
  id: string;
  createdAt: number;
  host: string;
  method: string;
  path: string;
  status: InspectStatus;
  /** Shape-only leaves; never values. */
  leaves: readonly Leaf[];
  truncated: boolean;
  classification?: Classification;
  /** The exact authoring prompt, structure only. */
  prompt?: string;
  authored?: { source?: "on_device" | "in_cloud"; latencyMs: number; calls: number };
  /** The current draft, including user edits. Saved only through approve(). */
  profile?: Profile;
  errors: string[];
  dryRun?: DryRunResult;
  /**
   * Response locators and read coverage proposed by code (never by the model) from value-free shapes of answers the
   * engine saw from this host. Accepted ones are already part of `profile`; the user can untick them or add GET.
   */
  suggestions?: { locators: Array<LocatorSuggestion & { accepted: boolean }>; addGet: boolean; getAdded: boolean };
}

export interface AuthoringSpec {
  model: AuthoringModelLike;
  name: string;
  generationConfig?: unknown;
}

export interface InspectionDeps {
  registry: { save(input: unknown): Promise<SaveResult> };
  dryRun: DryRun;
  rules?: RulesData;
  /** Lazy so the Firebase models are only built when used. Absent: detector-only classification. */
  classifierModel?: () => LocalModelLike;
  authoringModel?: () => AuthoringSpec;
  beforeCall?: BeforeCall;
  /** Injectable on-device availability, for tests. */
  status?: () => Promise<LocalState>;
  /** The engine's observed answer shapes. Absent: no response locators are proposed. */
  observations?: { list(): readonly Observation[]; subscribe(listener: () => void): () => void };
}

export interface CaptureRequest {
  host: string;
  method: string;
  path: string;
  contentType?: string;
  request: unknown;
  response?: unknown;
}

interface Entry {
  capture: Capture;
  resolve: (d: InspectDecision) => void;
  settled: boolean;
}

let counter = 0;

export class InspectionStore {
  private items: InspectItem[] = [];
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private pendingListeners = new Set<(id: string) => void>();

  constructor(private readonly deps: InspectionDeps) {
    // New observed answers refresh the proposals of every item that is still undecided.
    deps.observations?.subscribe(() => {
      for (const id of this.pendingIds()) if (this.get(id)?.profile) void this.refreshSuggestions(id);
    });
  }

  getSnapshot = (): readonly InspectItem[] => this.items;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  private patch(id: string, p: Partial<InspectItem>): void {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...p } : i));
    this.emit();
  }

  get(id: string): InspectItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** Hold a request for inspection. The decision promise resolves when the user saves, discards or passes it through once. */
  capture(req: CaptureRequest): { id: string; decision: Promise<InspectDecision> } {
    const id = `ins-${Date.now().toString(36)}-${++counter}`;
    const capture = new Capture(req);
    let resolve!: (d: InspectDecision) => void;
    const decision = new Promise<InspectDecision>((r) => (resolve = r));
    this.entries.set(id, { capture, resolve, settled: false });
    this.items = [
      ...this.items,
      {
        id,
        createdAt: Date.now(),
        host: capture.host,
        method: capture.method,
        path: capture.path,
        status: "held",
        leaves: capture.leaves(),
        truncated: capture.truncated,
        errors: [],
      },
    ];
    this.emit();
    this.pendingListeners.forEach((l) => l(id));
    return { id, decision };
  }

  /** Ids of held requests that still wait for the user (not saved, discarded or passed through). */
  pendingIds = (): string[] => [...this.entries].filter(([, e]) => !e.settled).map(([id]) => id);

  /** Called each time a request is captured and starts waiting. Returns an unsubscribe function. */
  onPending = (listener: (id: string) => void): (() => void) => {
    this.pendingListeners.add(listener);
    return () => this.pendingListeners.delete(listener);
  };

  /** Add the observed response so response locators can be authored and the restore round trip checked. */
  attachResponse(id: string, body: unknown): void {
    const e = this.live(id);
    if (!e) return;
    e.capture.attachResponse(body);
    this.patch(id, { leaves: e.capture.leaves(), truncated: e.capture.truncated });
  }

  private live(id: string): Entry | undefined {
    const e = this.entries.get(id);
    return e && !e.settled ? e : undefined;
  }

  /** ONLY_ON_DEVICE classification of the real values, or the labelled detector fallback. */
  async classify(id: string): Promise<Classification | undefined> {
    const e = this.live(id);
    if (!e) return undefined;
    this.patch(id, { status: "classifying" });
    let model: LocalModelLike | null = null;
    try {
      model = this.deps.classifierModel?.() ?? null;
    } catch {
      model = null;
    }
    const classification = await classifyFields(e.capture, model, { status: this.deps.status });
    if (!this.live(id)) return classification;
    this.patch(id, { classification, status: "held" });
    return classification;
  }

  /** Author a profile from structure only, then vet it. */
  async author(id: string): Promise<void> {
    const e = this.live(id);
    if (!e) return;
    const classification = this.get(id)?.classification ?? (await this.classify(id));
    if (!classification || !this.live(id)) return;
    const spec = this.deps.authoringModel?.();
    if (!spec) {
      this.patch(id, { status: "rejected", errors: ["No authoring model is configured."] });
      return;
    }
    this.patch(id, { status: "authoring", errors: [], profile: undefined, dryRun: undefined });
    const r = await authorProfile({
      capture: e.capture,
      classification,
      model: spec.model,
      modelName: spec.name,
      generationConfig: spec.generationConfig,
      dryRun: this.deps.dryRun,
      rules: this.deps.rules,
      beforeCall: this.deps.beforeCall,
    });
    if (!this.live(id)) return;
    this.patch(id, {
      status: r.status,
      prompt: r.prompt,
      authored: { source: r.source, latencyMs: r.latencyMs, calls: r.calls },
      profile: r.profile ?? r.draft,
      errors: r.errors,
      dryRun: r.dryRun,
    });
    await this.refreshSuggestions(id);
  }

  private vetCtx(id: string): Parameters<typeof vetProfile>[1] | null {
    const e = this.live(id);
    const item = this.get(id);
    if (!e || !item?.classification) return null;
    return { capture: e.capture, classification: item.classification, host: item.host, method: item.method, path: item.path, dryRun: this.deps.dryRun, rules: this.deps.rules };
  }

  /** Re-vet a changed draft and store it, the same way a field edit does. */
  private async revet(id: string, draft: Profile, extra: Partial<InspectItem> = {}): Promise<void> {
    const ctx = this.vetCtx(id);
    if (!ctx) return;
    const vetted = await vetProfile(draft, ctx);
    if (!this.live(id)) return;
    this.patch(id, {
      ...extra,
      profile: vetted.profile ?? draft,
      errors: vetted.errors,
      dryRun: vetted.dryRun,
      status: vetted.profile && vetted.errors.length === 0 ? "ready" : "rejected",
    });
  }

  /** Add the proposals that are new, accepted, to the draft. Ones the user already unticked stay unticked. */
  private async refreshSuggestions(id: string): Promise<void> {
    const item = this.get(id);
    if (!this.live(id) || !item?.profile || !this.deps.observations) return;
    const found = suggestResponseLocators(item.profile, this.deps.observations.list());
    const prior = item.suggestions?.locators ?? [];
    const merged = [
      ...prior.map((p) => {
        const again = found.locators.find((l) => l.locator === p.locator);
        return again ? { ...again, accepted: p.accepted } : p;
      }),
      ...found.locators.filter((l) => !prior.some((p) => p.locator === l.locator)).map((l) => ({ ...l, accepted: true })),
    ];
    const getAdded = item.suggestions?.getAdded ?? false;
    const addGet = found.addGet || (item.suggestions?.addGet ?? false);
    const next = { locators: merged, addGet, getAdded };
    if (JSON.stringify(next) === JSON.stringify(item.suggestions)) return;
    await this.applySuggestions(id, next);
  }

  /** Draft = the profile without any learned additions, plus the accepted locators, plus GET when added. */
  private async applySuggestions(id: string, s: NonNullable<InspectItem["suggestions"]>): Promise<void> {
    const item = this.get(id);
    if (!item?.profile) return;
    const known = new Set(s.locators.map((l) => l.locator));
    const own = item.profile.response.fields.filter((f) => !known.has(f.path));
    const accepted = s.locators.filter((l) => l.accepted).map((l) => ({ path: l.locator }));
    const methods = item.profile.match.methods ?? [];
    const withGet = s.getAdded && methods.length > 0 && !methods.includes("GET") ? [...methods, "GET"] : methods;
    const paths = s.getAdded ? pathsWithRecords(item.profile.match.paths) : item.profile.match.paths;
    const draft: Profile = {
      ...item.profile,
      match: { ...item.profile.match, paths, ...(withGet.length > 0 ? { methods: withGet } : {}) },
      response: { fields: [...own, ...accepted] },
    };
    await this.revet(id, draft, { suggestions: s });
  }

  /** Tick or untick one proposed response locator. */
  async setLocatorAccepted(id: string, locator: string, accepted: boolean): Promise<void> {
    const s = this.get(id)?.suggestions;
    if (!this.live(id) || !s || !s.locators.some((l) => l.locator === locator)) return;
    await this.applySuggestions(id, { ...s, locators: s.locators.map((l) => (l.locator === locator ? { ...l, accepted } : l)) });
  }

  /** Add a response locator the user typed. It must parse; it is kept as an accepted, not observed, entry. */
  async addLocator(id: string, locator: string): Promise<{ ok: boolean; error?: string }> {
    const item = this.get(id);
    if (!this.live(id) || !item?.profile) return { ok: false, error: "There is no draft to add it to." };
    const v = validateLocator(locator);
    if (!v.ok) return { ok: false, error: v.error };
    const s = item.suggestions ?? { locators: [], addGet: false, getAdded: false };
    if (s.locators.some((l) => l.locator === locator)) return { ok: true };
    await this.applySuggestions(id, { ...s, locators: [...s.locators, { locator, from: "typed by you", resolves: 0, observed: false, accepted: true }] });
    return { ok: true };
  }

  /** Make the draft cover GET (and one record below each path). Explicit: nothing adds it on its own. */
  async addGet(id: string): Promise<void> {
    const item = this.get(id);
    if (!this.live(id) || !item?.profile) return;
    const s = item.suggestions ?? { locators: [], addGet: true, getAdded: false };
    if (s.getAdded) return;
    await this.applySuggestions(id, { ...s, getAdded: true });
  }

  /**
   * Change the action and/or category of one request field of the draft, then re-validate and re-run the dry run.
   * No model call. An undefined action keeps the field's current flow (or adds the field without one).
   */
  async edit(id: string, path: string, action: Action | undefined, category?: Category): Promise<void> {
    const e = this.live(id);
    const item = this.get(id);
    if (!e || !item?.profile || !item.classification) return;
    const fields = item.profile.request.fields.map((f) => ({ ...f }));
    const at = fields.findIndex((f) => f.path === path);
    if (at >= 0) {
      fields[at] = { ...fields[at], ...(action ? { flow: { action } } : {}), ...(category ? { category } : {}) };
    } else {
      const cls = item.classification.fields.find((f) => f.side === "request" && f.path.replace(/\[\d+\]/g, "[*]") === path);
      const cat = category ?? cls?.class;
      fields.push({ path, ...(cat ? { category: cat } : {}), ...(action ? { flow: { action } } : {}) });
    }
    const draft: Profile = { ...item.profile, request: { fields } };
    const vetted = await vetProfile(draft, {
      capture: e.capture,
      classification: item.classification,
      host: item.host,
      method: item.method,
      path: item.path,
      dryRun: this.deps.dryRun,
      rules: this.deps.rules,
    });
    if (!this.live(id)) return;
    this.patch(id, {
      profile: vetted.profile ?? draft,
      errors: vetted.errors,
      dryRun: vetted.dryRun,
      status: vetted.profile && vetted.errors.length === 0 ? "ready" : "rejected",
    });
  }

  private settle(id: string, decision: InspectDecision, status: InspectStatus): void {
    const e = this.entries.get(id);
    if (!e || e.settled) return;
    e.settled = true;
    e.capture.clear();
    this.patch(id, { status });
    e.resolve(decision);
  }

  /** Save the draft. Refused unless it validates and its dry run passes; the dry run is repeated here. */
  async approve(id: string): Promise<{ ok: boolean; errors: string[] }> {
    const e = this.live(id);
    const item = this.get(id);
    if (!e || !item?.profile || !item.classification) return { ok: false, errors: ["There is no authored profile to approve."] };
    const vetted = await vetProfile(item.profile, {
      capture: e.capture,
      classification: item.classification,
      host: item.host,
      method: item.method,
      path: item.path,
      dryRun: this.deps.dryRun,
      rules: this.deps.rules,
    });
    if (!vetted.profile || vetted.errors.length > 0) {
      this.patch(id, { errors: vetted.errors, dryRun: vetted.dryRun, status: "rejected" });
      return { ok: false, errors: vetted.errors };
    }
    const saved = await this.deps.registry.save(vetted.profile);
    if (!saved.ok) {
      this.patch(id, { errors: saved.errors, status: "rejected" });
      return { ok: false, errors: saved.errors };
    }
    this.patch(id, { profile: saved.profile });
    this.settle(id, "saved", "saved");
    return { ok: true, errors: [] };
  }

  discard(id: string): void {
    this.settle(id, "discarded", "discarded");
  }

  /** One-time unprotected send for learning. The engine records it in the audit as an explicit unprotected send. */
  passThrough(id: string): void {
    this.settle(id, "pass-through", "passed-through");
  }
}
