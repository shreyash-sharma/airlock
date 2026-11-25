/**
 * Deterministic tokens for values that persist at a SaaS. This is stable keyed tokenization with a local
 * index, not format-preserving encryption: the token is "tok_" plus the first 22 characters of the lowercase
 * base32 of HMAC-SHA-256(key, normalized value). The key is per browser and the index (token to first-seen
 * original) is what makes the token reversible. Originals are kept only in local browser storage.
 */

/** The shape of a token anywhere in text: the lookahead keeps a longer base32 run from being cut. */
export const TOKEN_IN_TEXT = /tok_[a-z2-7]{22}(?![a-z2-7])/g;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const TOKEN_CHARS = 22;

/** Raised when two different normalized originals would share one token. The index is never overwritten. */
export class TokenCollisionError extends Error {
  constructor() {
    super("token collision: two different values map to one token");
    this.name = "TokenCollisionError";
  }
}

/** Case, surrounding whitespace and inner whitespace runs never make a different value. */
export function normalizeForToken(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** RFC 4648 base32, lowercase, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export class TokenVault {
  private key: CryptoKey | null = null;
  private keyB64: string | null = null;
  /** token to the first-seen original value (as written, not normalized). */
  private index = new Map<string, string>();

  /** Import a persisted key. A key that is not valid base64 or the wrong size is ignored and a new one is made on first use. */
  async loadKey(b64: string | null | undefined): Promise<boolean> {
    if (!b64) return false;
    try {
      const raw = fromBase64(b64);
      if (raw.length !== 32) return false;
      this.key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
      this.keyB64 = b64;
      return true;
    } catch {
      return false;
    }
  }

  /** Replace the index with persisted entries. Malformed entries are skipped. */
  loadIndex(entries: unknown): void {
    this.index = new Map();
    if (typeof entries !== "object" || entries === null) return;
    for (const [token, original] of Object.entries(entries)) {
      if (/^tok_[a-z2-7]{22}$/.test(token) && typeof original === "string") this.index.set(token, original);
    }
  }

  /** The key as base64 for storage, or null when none was made yet. */
  exportKey(): string | null {
    return this.keyB64;
  }

  exportIndex(): Record<string, string> {
    return Object.fromEntries(this.index);
  }

  get size(): number {
    return this.index.size;
  }

  private async ensureKey(): Promise<CryptoKey> {
    if (this.key) return this.key;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    this.key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
    this.keyB64 = toBase64(raw);
    return this.key;
  }

  /** The token for a value: the same value (up to case and whitespace) always gives the same token. */
  async token(value: string): Promise<string> {
    const normalized = normalizeForToken(value);
    const key = await this.ensureKey();
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(normalized)));
    const token = `tok_${base32(mac).slice(0, TOKEN_CHARS)}`;
    const held = this.index.get(token);
    if (held === undefined) this.index.set(token, value);
    else if (normalizeForToken(held) !== normalized) throw new TokenCollisionError();
    return token;
  }

  /** The original behind a token, or undefined. Synchronous: XHR response getters cannot wait. */
  restore(token: string): string | undefined {
    return this.index.get(token);
  }

  /** Replace every known token in a text with its original. Unknown tokens stay as they are. */
  restoreText(text: string): string {
    if (this.index.size === 0) return text;
    return text.replace(TOKEN_IN_TEXT, (token) => this.index.get(token) ?? token);
  }

  clear(): void {
    this.key = null;
    this.keyB64 = null;
    this.index = new Map();
  }
}
