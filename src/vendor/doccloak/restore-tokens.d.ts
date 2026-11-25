/**
 * Tolerant restore-token matching (T098), extracted to a side-effect-free
 * leaf module so the extension content bundle can import these VALUES
 * without pulling in the session/surrogate machinery (see the T036 alias
 * note in DocCloak.Extension/vite.content.config.ts).
 */
/**
 * Bare typed token as an LLM writes it after dropping the brackets:
 * STRICTLY uppercase segments ending in an underscore-digit run, on
 * non-wordish boundaries (underscore excluded on both sides so an
 * embedded "SOME_PERSON_1" identifier never yields a partial match).
 * Case is deliberately NOT tolerated here: without brackets, only the
 * exact uppercase shape is distinctive enough to touch ("person 1" in
 * lowercase prose must stay prose). An immediately preceding '[' or '<'
 * is also excluded: a dangling "[PERSON_1" (a token split mid-stream,
 * possibly a truncated "[PERSON_11]") must never be partially restored -
 * the complete bracketed form is the bracket scan's job.
 * Global: callers reset lastIndex.
 */
export declare const BARE_TYPED_TOKEN_RE: RegExp;
/**
 * Canonical comparison form of a placeholder candidate or map key:
 * markdown emphasis stripped, edge junk (brackets, punctuation, space)
 * stripped, lowercased, separator runs collapsed to single underscores.
 * "[PERSON_1]", "[person 1]", "**[PERSON-1]**" and "PERSON_1" all yield
 * "person_1". Returns null when nothing substantive remains.
 */
export declare function canonicalPlaceholderForm(candidate: string): string | null;
/**
 * The type-family prefix of a canonical typed token ("person_1" ->
 * "person", "credit_card_2" -> "credit_card"), or null for canonical
 * forms that are not typed-token shaped (renamed labels like "ceo").
 */
export declare function canonicalTypePrefix(canonical: string): string | null;
export interface TolerantTokenIndex {
    /**
     * Canonical form -> the ONE exact map key it identifies. Forms claimed
     * by two different keys are ambiguous and absent by construction, so a
     * lookup hit is always safe to restore.
     */
    byCanonical: ReadonlyMap<string, string>;
    /**
     * Canonical type prefixes of the typed keys in the map ("person",
     * "redacted"). A candidate of a KNOWN family that resolves to no key is
     * a DocCloak token the model mangled beyond recovery - callers may
     * surface it as could-not-restore. Unknown families (site prose like
     * "[citation_1]") are never DocCloak's to flag.
     */
    typePrefixes: ReadonlySet<string>;
}
/**
 * Build the tolerant lookup for a map's keys. Only token-shaped keys
 * participate: literal surrogate keys are natural-language text whose
 * case/spacing variants collide with genuine prose, so they keep the
 * exact-literal path only. Canonical collisions between two different
 * keys are dropped entirely (never guess between [PERSON_1] and a
 * renamed "[Person 1]"); exact matching still restores both.
 */
export declare function buildTolerantTokenIndex(keys: Iterable<string>): TolerantTokenIndex;
/**
 * Resolve one mangled candidate to its exact map key, or null when the
 * candidate identifies no key or more than one (ambiguity never
 * restores). Candidates come from bracketed/legacy token scans or from
 * BARE_TYPED_TOKEN_RE; arbitrary prose canonicalizes to forms no key
 * owns and falls through to null.
 */
export declare function resolveMangledToken(candidate: string, index: TolerantTokenIndex): string | null;
