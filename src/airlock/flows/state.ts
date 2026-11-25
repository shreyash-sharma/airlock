import { AnonymizationSession } from "../../vendor/doccloak/session.js";
import { KEYS, type KVStore } from "../profiles/storage.js";
import type { Role } from "./roles.js";
import { TokenVault } from "./token.js";

/**
 * What the engine must remember to give protected values back: the placeholder vault (mask), the surrogate
 * session and the token index with its key. One instance per engine, shared by every request, so the same
 * value gets the same replacement and any later response can be restored, even after a page reload.
 *
 * Originals are kept only in local browser storage: airlock.vault.v1 holds the sessions and the token index,
 * airlock.tokenkey.v1 the per-browser HMAC key. The Inspector's "Clear local data" wipes both.
 */
export class FlowState {
  labeled = new AnonymizationSession({ mode: "labeled" });
  surrogate = new AnonymizationSession({ mode: "surrogate" });
  tokens = new TokenVault();
  /** Who is looking: decides how much of a restored value this viewer gets back. Set from the rules before each request. */
  role: Role = "owner";
  private kv: KVStore | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** Set when stored data could not be read, so the caller can say why restore may be incomplete. */
  loadProblem: string | null = null;

  /** Read the persisted record. Never throws: unreadable or corrupt data starts a fresh state and sets loadProblem. */
  async load(kv: KVStore): Promise<void> {
    this.kv = kv;
    this.loadProblem = null;
    let raw: string | null = null;
    let key: string | null = null;
    try {
      raw = await kv.get(KEYS.vault);
      key = await kv.get(KEYS.tokenkey);
    } catch {
      this.loadProblem = "the stored vault could not be read, so earlier protected values cannot be restored";
      return;
    }
    if (key) await this.tokens.loadKey(key);
    if (!raw) return;
    try {
      const record = JSON.parse(raw) as { labeled?: unknown; surrogate?: unknown; tokens?: unknown };
      // Build each part first so a corrupt one leaves every other part untouched.
      const labeled = typeof record.labeled === "string" ? AnonymizationSession.deserialize(record.labeled) : this.labeled;
      const surrogate = typeof record.surrogate === "string" ? AnonymizationSession.deserialize(record.surrogate) : this.surrogate;
      this.labeled = labeled;
      this.surrogate = surrogate;
      this.tokens.loadIndex(record.tokens);
    } catch {
      this.loadProblem = "the stored vault is corrupt, so earlier protected values cannot be restored";
    }
  }

  /** Persist the sessions, the token index and the key. Calls are serialized; rejects when storage refuses a write. */
  save(): Promise<void> {
    const run = async (): Promise<void> => {
      if (!this.kv) return;
      const key = this.tokens.exportKey();
      if (key) await this.kv.set(KEYS.tokenkey, key);
      await this.kv.set(
        KEYS.vault,
        JSON.stringify({
          version: 2,
          labeled: this.labeled.serialize(),
          surrogate: this.surrogate.serialize(),
          tokens: this.tokens.exportIndex(),
        }),
      );
    };
    const next = this.saving.then(run, run);
    this.saving = next.catch(() => undefined);
    return next;
  }

  /** Forget every protected value, in memory and in storage. Restore afterwards leaves protected values as they are. */
  async clear(): Promise<void> {
    this.labeled = new AnonymizationSession({ mode: "labeled" });
    this.surrogate = new AnonymizationSession({ mode: "surrogate" });
    this.tokens.clear();
    await this.saving;
    if (this.kv) {
      await this.kv.set(KEYS.vault, "");
      await this.kv.set(KEYS.tokenkey, "");
    }
  }
}
