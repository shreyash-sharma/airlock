import { validateProfile, validateRules } from "./validate.js";
import type { Profile, RulesData } from "./types.js";

/** Async key-value storage of strings. localStorage here; the extension supplies a chrome.storage version. */
export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export const KEYS = {
  profiles: "airlock.profiles.v1",
  rules: "airlock.rules.v1",
  vault: "airlock.vault.v1",
  tokenkey: "airlock.tokenkey.v1",
} as const;

export function memoryKV(initial: Record<string, string> = {}): KVStore {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => {
      data.set(key, value);
    },
  };
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** localStorage as a KVStore, or null when it is missing or blocked (private mode, sandboxed frames). */
export function localStorageKV(storage?: StorageLike): KVStore | null {
  let s: StorageLike | undefined = storage;
  if (!s) {
    try {
      s = (globalThis as { localStorage?: StorageLike }).localStorage;
    } catch {
      return null;
    }
  }
  if (!s) return null;
  const backing = s;
  return {
    get: async (key) => backing.getItem(key),
    set: async (key, value) => backing.setItem(key, value),
  };
}

export type ProfileOrigin = "stored" | "app" | "built-in";
export interface ProfileEntry {
  profile: Profile;
  origin: ProfileOrigin;
}

export type SaveResult = { ok: true; profile: Profile } | { ok: false; errors: string[] };
export type SaveRulesResult = { ok: true; rules: RulesData } | { ok: false; errors: string[] };

export interface RegistryOptions {
  builtins?: readonly Profile[];
  /** Profiles supplied by the host app: validated like any other, never persisted. */
  extra?: readonly unknown[];
}

/**
 * Profiles and rules, validated on the way in and on the way out of storage. Valid stored profiles load
 * and invalid ones are rejected whole with field-path errors; corrupt storage applies nothing.
 */
export class ProfileRegistry {
  readonly ready: Promise<void>;
  private stored: Profile[] = [];
  private extra: Profile[] = [];
  private extraProblems: string[] = [];
  private storedProblems: string[] = [];
  private ruleProblems: string[] = [];
  private readonly builtins: readonly Profile[];
  private listeners = new Set<() => void>();
  private rev = 0;

  constructor(
    private readonly kv: KVStore,
    options: RegistryOptions = {},
  ) {
    this.builtins = options.builtins ?? [];
    (options.extra ?? []).forEach((raw, i) => {
      const r = validateProfile(raw);
      if (r.ok) this.extra.push(r.profile);
      else r.errors.forEach((e) => this.extraProblems.push(`${e} (options.profiles[${i}])`));
    });
    this.ready = this.load();
  }

  /** (Re)read stored profiles. Never throws: problems are reported through errors(). */
  async load(): Promise<void> {
    const found: Profile[] = [];
    const problems: string[] = [];
    let raw: string | null = null;
    try {
      raw = await this.kv.get(KEYS.profiles);
    } catch {
      problems.push("profiles: stored profiles could not be read, so none were applied");
    }
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
        problems.push("profiles: stored data is not valid JSON, so no stored profile was applied");
      }
      if (parsed !== undefined) {
        if (!Array.isArray(parsed)) problems.push("profiles: stored data must be an array of profiles, so none were applied");
        else {
          parsed.forEach((p, i) => {
            const r = validateProfile(p);
            if (r.ok) found.push(r.profile);
            else r.errors.forEach((e) => problems.push(`${e} (stored profile ${i})`));
          });
        }
      }
    }
    this.stored = found;
    this.storedProblems = problems;
    this.changed();
  }

  /** Called after any change to the stored profiles or rules (save, remove, import, reload). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes on every update, so a UI can use it as a snapshot. */
  version = (): number => this.rev;

  private changed(): void {
    this.rev++;
    this.listeners.forEach((l) => l());
  }

  /** Every profile with where it comes from: the user's storage, the host app, or the built-ins. Same order as all(). */
  entries(): ProfileEntry[] {
    return [
      ...this.stored.map((profile) => ({ profile, origin: "stored" as const })),
      ...this.extra.map((profile) => ({ profile, origin: "app" as const })),
      ...this.builtins.map((profile) => ({ profile, origin: "built-in" as const })),
    ];
  }

  /** Stored and host-supplied profiles first, built-ins last. First match wins. */
  all(): Profile[] {
    return [...this.stored, ...this.extra, ...this.builtins];
  }

  errors(): readonly string[] {
    return [...this.extraProblems, ...this.storedProblems, ...this.ruleProblems];
  }

  /** Validate, then persist. Invalid input is refused and nothing is written. Same id replaces. */
  async save(input: unknown): Promise<SaveResult> {
    await this.ready;
    const r = validateProfile(input);
    if (!r.ok) return r;
    const next = [...this.stored.filter((p) => p.id !== r.profile.id), r.profile];
    await this.kv.set(KEYS.profiles, JSON.stringify(next));
    this.stored = next;
    this.changed();
    return { ok: true, profile: r.profile };
  }

  /**
   * Validate every profile first and write them together, or write nothing: an invalid one refuses the whole batch
   * with its errors prefixed by its position. Same id replaces.
   */
  async saveMany(inputs: readonly unknown[]): Promise<{ ok: true; profiles: Profile[] } | { ok: false; errors: string[] }> {
    await this.ready;
    const valid: Profile[] = [];
    const errors: string[] = [];
    inputs.forEach((raw, i) => {
      const r = validateProfile(raw);
      if (r.ok) valid.push(r.profile);
      else r.errors.forEach((e) => errors.push(`${e} (profile ${i + 1})`));
    });
    if (errors.length > 0) return { ok: false, errors };
    const ids = new Set(valid.map((p) => p.id));
    const next = [...this.stored.filter((p) => !ids.has(p.id)), ...valid];
    await this.kv.set(KEYS.profiles, JSON.stringify(next));
    this.stored = next;
    this.changed();
    return { ok: true, profiles: valid };
  }

  /** Remove a stored profile. Built-in and host-supplied profiles are not stored, so they cannot be removed here. */
  async remove(id: string): Promise<{ ok: boolean; reason?: string }> {
    await this.ready;
    if (!this.stored.some((p) => p.id === id)) return { ok: false, reason: "Only profiles stored in this browser can be deleted." };
    const next = this.stored.filter((p) => p.id !== id);
    await this.kv.set(KEYS.profiles, JSON.stringify(next));
    this.stored = next;
    this.changed();
    return { ok: true };
  }

  /** Stored rules, or the defaults. Invalid stored rules give errors and the defaults, never a merge. */
  async loadRules(defaults: RulesData): Promise<RulesData> {
    this.ruleProblems = [];
    let raw: string | null = null;
    try {
      raw = await this.kv.get(KEYS.rules);
    } catch {
      this.ruleProblems.push("rules: stored rules could not be read, so the defaults apply");
      return defaults;
    }
    if (raw === null) return defaults;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.ruleProblems.push("rules: stored data is not valid JSON, so the defaults apply");
      return defaults;
    }
    const r = validateRules(parsed);
    if (!r.ok) {
      r.errors.forEach((e) => this.ruleProblems.push(`${e} (stored rules)`));
      return defaults;
    }
    return r.rules;
  }

  async saveRules(input: unknown): Promise<SaveRulesResult> {
    const r = validateRules(input);
    if (!r.ok) return r;
    await this.kv.set(KEYS.rules, JSON.stringify(r.rules));
    this.changed();
    return { ok: true, rules: r.rules };
  }
}
