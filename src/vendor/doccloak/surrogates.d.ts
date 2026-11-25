/**
 * @doccloak/core - realistic, shape-preserving surrogate generator (T043).
 *
 * Generates fake-but-plausible replacements for detected entities instead
 * of bracket placeholders: locale-aware names, dates shifted while keeping
 * their format, IBANs/phones/IDs that keep their shape (checksum-valid
 * where the checksum is cheap to compute).
 *
 * Determinism contract: every surrogate is a pure function of
 * (session salt, entity type, original value, attempt). No Math.random or
 * Date.now is ever consulted at module or generation scope, so the same
 * original always yields the same surrogate within a session and tests are
 * reproducible. The salt itself is created once per session (see
 * generateSessionSalt, called from the AnonymizationSession constructor)
 * and persisted with the map so a deserialized session keeps producing
 * consistent surrogates.
 *
 * Fake-identifier policy: we never deliberately generate a real person's
 * identifier. Generated PESELs encode a 19th-century birth date (a range
 * the registry never issued numbers for), generated SSN shapes use the
 * 900-999 area (never allocated by the SSA) with a group outside every
 * valid ITIN range (T101: a 9xx area alone could still form a real ITIN),
 * generated EIN shapes use campus prefixes the IRS has never assigned,
 * generated ABA routing shapes are checksum-valid but carry the 99 leading
 * pair (the ABA assigns only 00-12, 21-32, 61-72, and 80), generated NHS
 * numbers sit in the mod-11-valid 999 test range (never issued to
 * patients), and generated NINOs use the QQ prefix HMRC reserves for
 * documentation examples. Random collisions with real identifiers of other
 * kinds are statistically possible but not targetable: nothing about the
 * original value survives into the surrogate beyond its shape.
 */
import type { EntityType } from './types.js';
/**
 * One salt per session, created at session construction time (never at
 * module scope). WebCrypto when available; a constructor-time Math.random
 * fallback otherwise (the salt only needs to be unique-ish per session,
 * not cryptographically strong - surrogates are not secrets).
 */
export declare function generateSessionSalt(): string;
/** Reserved/example domains only (RFC 2606 / RFC 6761): never routable. */
export declare const FAKE_EMAIL_DOMAINS: readonly ["example.com", "example.org", "example.net", "mail.example", "post.example", "inbox.test", "mail.test", "poczta.test"];
export interface SurrogateContext {
    /** Per-session salt; the sole source of randomness. */
    salt: string;
    /**
     * Already-issued session mappings, used to derive an email local part
     * from the surrogate of the matching PERSON (jan.kowalski maps to
     * adam.nowak style). Optional; without it emails get an unrelated
     * deterministic fake identity.
     */
    entries?: ReadonlyArray<{
        original: string;
        replacement: string;
        entityType: EntityType;
    }>;
}
/**
 * Per-session day offset in [-30, -1] or [1, 30]: derived from the salt
 * only, so every date in a session shifts by the same amount and relative
 * spacing between dates is preserved. Never 0 (a zero shift would leak the
 * original date unchanged).
 */
export declare function sessionDayOffset(salt: string): number;
/**
 * Test/diagnostic probe (T073): which locale pack a PERSON value would
 * use. Not part of the anonymization data path.
 */
export declare function detectSurrogateLocale(value: string): string;
/**
 * Generate a surrogate for one entity. Pure and deterministic in
 * (ctx.salt, type, original, attempt); bump `attempt` to re-derive after
 * a collision.
 */
export declare function generateSurrogate(original: string, type: EntityType, ctx: SurrogateContext, attempt?: number): string;
/**
 * Collision-safe wrapper: re-derives with a bumped attempt while the
 * candidate equals the original or `isTaken` reports a clash (another
 * original value or an already-issued replacement); after bounded retries
 * it appends digits until unique. Termination is guaranteed because the
 * taken set is finite.
 */
export declare function generateUniqueSurrogate(original: string, type: EntityType, ctx: SurrogateContext, isTaken: (candidate: string) => boolean): string;
