import type { EntityType, DetectedEntity, ReplacementEntry } from './types.js';
export * from './restore-tokens.js';
export type ReplacementMode = 'labeled' | 'blanked' | 'surrogate';
export interface SessionOptions {
    /** Initial replacement mode; defaults to 'labeled' (typed placeholders). */
    mode?: ReplacementMode;
    /**
     * Per-session surrogate salt; defaults to a fresh random one. Passing an
     * explicit salt makes surrogate generation fully reproducible (tests,
     * deserialization).
     */
    salt?: string;
}
/** Input accepted by registerDocumentValues: plain values or anything carrying a `value`. */
export type DocumentValueInput = string | {
    value: string;
};
/** One restore over the original text (see AnonymizationSession.restoreSpans). */
export interface RestoreSpan {
    start: number;
    end: number;
    /** The original value written back */
    replacement: string;
    /** The map key that matched (the placeholder or surrogate) */
    token: string;
    /** False when the tolerant pass resolved a mangled token */
    exact: boolean;
}
export declare class AnonymizationSession {
    private forwardMap;
    private reverseMap;
    private entityTypeMap;
    private typeCounters;
    /**
     * Variant token -> its group's base token and suffix (T171), so renaming
     * the base re-derives its variants and deserialized maps re-link.
     */
    private variantOf;
    /**
     * Compiled exact-restore alternation (R4), rebuilt lazily; null after
     * every reverse-map mutation (see invalidateRestore).
     */
    private restoreRe;
    /**
     * Every value known to occur in the session's documents (R3), lowercased:
     * whole entity values plus their person tokens (and hyphen parts). Fed by
     * anonymizeText, anonymize, importEntries and registerDocumentValues;
     * cumulative until clear(). A surrogate is never one of these. No
     * capitalised-word heuristic: it would starve the pools in German and
     * Polish prose (plan v2 section 9).
     */
    private documentValues;
    /**
     * Letter-only document tokens of MIN_NAME_TOKEN_LENGTH or more, bucketed
     * by their first MIN_NAME_TOKEN_LENGTH characters, for the containment
     * rule in isDocumentValue: linear in the candidate's length instead of
     * a scan over every document token.
     */
    private documentNameIndex;
    /**
     * PERSON values that matched two or more mapped people equally well and
     * therefore got a fresh identity instead of a guessed one (R5).
     */
    private ambiguousValues;
    /** Whether the most recent anonymize() call refused an ambiguous unification. */
    private lastAmbiguousFlag;
    private mode;
    /** Surrogate-mode salt (T043); constant for the session's lifetime. */
    private salt;
    constructor(options?: SessionOptions);
    setMode(mode: ReplacementMode): void;
    getMode(): ReplacementMode;
    getSalt(): string;
    /**
     * Issue the next typed placeholder for the given entity type using a
     * per-type counter: [PERSON_1], [PERSON_2], [EMAIL_1], ... Numbers
     * already present in the reverse map (a renamed label or an entry
     * restored via deserialize) are skipped so a fresh placeholder never
     * collides with an existing one.
     */
    private nextPlaceholder;
    /**
     * Surrogate-mode replacement (T043): deterministic in (salt, type,
     * original), collision-safe against every original value already in the
     * session and every already-issued replacement. The map API is
     * unchanged: the surrogate simply IS the replacement string, so
     * deanonymize restores it via the same exact-literal lookup.
     */
    private nextSurrogate;
    /**
     * Whether a PERSON surrogate candidate carries a document name (R3):
     * any of its tokens is a document value, or contains one of at least
     * MIN_NAME_TOKEN_LENGTH letters ("Johnson" with "John" in the document,
     * "Nowakowski" with "Nowak"). Other types are covered by the exact
     * whole-value check alone: their tokens ("+48", "ul.", "GmbH") recur in
     * every surrogate of the same shape and would starve the pools.
     */
    private containsDocumentName;
    /** Record one document value: whole (lowercased), its tokens and hyphen parts. */
    private addDocumentValue;
    /**
     * Declare values that occur in the session's documents (R3) so no later
     * surrogate equals or, for people, contains one of them. anonymizeText
     * registers its entities itself; hosts that call anonymize() value by
     * value should register the whole entity list first, otherwise a person
     * mapped early can still receive the name of a person mapped later.
     * Accepts plain strings or objects with a `value` (DetectedEntity,
     * ReplacementEntry-like `{ value }` shapes). Cumulative until clear().
     */
    registerDocumentValues(input: ReadonlyArray<DocumentValueInput>): void;
    /**
     * Whether the most recent anonymize() call met an ambiguous PERSON value
     * (R5): a bare name that fits two or more mapped people equally well.
     * Such a value is NOT unified; it gets its own number or surrogate. For
     * anonymizeText, which maps many values, use getAmbiguousValues().
     */
    lastAmbiguous(): boolean;
    /**
     * Every PERSON value this session refused to unify because it matched
     * two or more people equally well (R5), in mapping order. Cumulative
     * until clear(); hosts can flag them for the user to resolve.
     */
    getAmbiguousValues(): string[];
    /**
     * One reference name per person group (R5): the fullest mapped original
     * of each group (most tokens; the first mapped on ties). Variants never
     * act as match targets on their own, so "Anna" cannot pull "Anna
     * Kowalska" into Anna Nowak's group, while a group whose fuller form
     * arrived later ("John" then "John Smith") still matches "Smith".
     */
    private personReferences;
    /**
     * The mapped person that a new PERSON value is a variant of (T057):
     * only group references are considered (see personReferences); most
     * shared tokens wins. A tie between two or more people is AMBIGUOUS
     * (R5): no guess is made, the value gets a fresh identity and the
     * session records it (lastAmbiguous / getAmbiguousValues).
     * Deterministic; match is null when nothing (or too much) matches.
     */
    private findPersonVariant;
    anonymize(original: string, entityType: EntityType): string;
    /** Drop the cached restore regex; called on every reverse-map change. */
    private invalidateRestore;
    /**
     * The exact-restore regex (R4): ONE alternation of every reverse-map
     * key, longest first so a longer key always wins at a given position
     * ("[PERSON_11]" before "[PERSON_1]", "Adam Nowak" before "Adam"), each
     * key escaped and guarded per restoreKeyPattern. Compiled once per map
     * state and reused across replies. Null when nothing is restorable.
     */
    private restoreRegex;
    /**
     * The group a mapped value belongs to (T171): its base token and the
     * canonical original that token restores to.
     */
    private variantGroup;
    /**
     * Labeled-mode variant token (T171): the group's base token plus a
     * positional suffix, computed against the group's canonical name when
     * the variant is part of it, else against the value it matched. Distinct
     * originals never share a token: a suffix already in use gets a counter
     * ("Smith" -> [PERSON_2_LAST], "smith" -> [PERSON_2_LAST_2]).
     */
    private variantPlaceholder;
    /**
     * Surrogate-mode variant (T171): when the variant is a strict part of the
     * group's canonical name and the surrogate has the same word count, take
     * the surrogate words at the same positions with the variant's casing.
     * Anything else (fuller forms, reshaped surrogates, a collision with an
     * existing value) falls back to the group's surrogate as before.
     */
    private variantSurrogate;
    /**
     * Every restore the session would perform on `text`, as non-overlapping
     * spans over the ORIGINAL text, sorted by start. deanonymize() applies
     * exactly these spans, and document writers (docx) apply them to mapped
     * text nodes so formatting survives. Exact keys first (R4, one pass);
     * then token-shaped candidates the exact pass did not consume get the
     * tolerant resolution (T098). Nothing is ever matched against restored
     * text.
     */
    restoreSpans(text: string): RestoreSpan[];
    deanonymize(text: string): string;
    /**
     * Tokens in `text` that look like this session's placeholders but that
     * restoreSpans leaves in place: a typed token of a family the map knows
     * ("[PERSON_9]" when the map has [PERSON_1]) that identifies no key, or
     * more than one. An assistant invented or renumbered it, or it belongs
     * to another document. Tokens of DocCloak's own types are reported
     * whatever the map holds ("[COMPANY_1]" against a map without companies,
     * or against an empty map). Hosts list them so the user can fix them by
     * hand. Bracket text of other families ("[Table 1]", "[see par. 3]") is
     * never reported. Distinct tokens as written, in order of appearance.
     */
    unresolvedTokens(text: string): string[];
    /**
     * R9: placeholders written LITERALLY in the user's text ("[PERSON_1]" in
     * a template or a previously anonymized document) raise the per-type
     * counter above them, so a freshly issued placeholder never restores to
     * a value the text never carried under that token.
     */
    private reserveLiteralPlaceholders;
    anonymizeText(text: string, entities: DetectedEntity[]): string;
    getEntries(): ReplacementEntry[];
    getForward(original: string): string | undefined;
    /**
     * Rename the label of a mapped value. Renaming a group's base token
     * (T171) re-derives every variant token from the new label
     * ([PERSON_1] -> [CLIENT] takes [PERSON_1_LAST] to [CLIENT_LAST]);
     * renaming a variant token renames only that token and detaches it from
     * the group, so a later base rename does not overwrite the user's choice.
     * Returns every [oldLabel, newLabel] pair applied, so hosts can update
     * already-rendered text without re-anonymizing.
     */
    renameLabel(original: string, newLabel: string): Array<[string, string]>;
    /**
     * Serialize the session map to JSON.
     *
     * Schema (field-for-field parity with the Python CLI's
     * DocCloak.Cli/doccloak/core/session.py save_map/load_map):
     *
     *   [
     *     {
     *       "original": string,      // the original sensitive value
     *       "replacement": string,   // its placeholder, e.g. "[PERSON_1]" or a renamed label
     *       "entity_type": string    // EntityType value, e.g. "PERSON" (snake_case key, matching Python)
     *     },
     *     ...
     *   ]
     *
     * - Top level is a JSON array; one object per mapping, in insertion order.
     * - Counters are NOT stored as fields. Like Python's load_map, deserialize
     *   derives them from the entries themselves.
     * - The mode is NOT stored as a field. Like Python's load_map (which returns
     *   `cls()` with the default mode), deserialize yields a 'labeled' session.
     * - Blanked entries are intentionally OMITTED from the output: blanked
     *   placeholders ('________') are irreversible by design (this class already
     *   keeps them out of the reverse map), so persisting their originals would
     *   defeat that. Only reversible entries are serialized.
     * - Output formatting matches Python's json.dumps(entries, indent=2,
     *   ensure_ascii=False): 2-space indent, non-ASCII characters kept raw.
     *
     * Surrogate mode (T043) is the one exception to the top-level-array
     * schema: it wraps the same entry objects in
     * `{ "mode": "surrogate", "salt": "...", "entries": [...] }` so
     * deserialize can restore the mode and the salt (new values anonymized
     * after a restore then derive the same surrogates, and the per-session
     * date offset stays stable). Placeholder ('labeled') and blanked
     * sessions keep emitting the plain array byte-identically, so the
     * Python-parity schema is untouched and absent fields mean placeholder
     * mode.
     */
    serialize(): string;
    /**
     * Seed the live session with previously issued mappings (T106: the
     * matter-persistence interface). Each entry lands in the forward map
     * (value -> replacement, so anonymizing the same value again reuses
     * the stored replacement instead of issuing a new one), the reverse
     * map (replacement -> value, so deanonymize restores text produced in
     * an earlier session; when several entries share a replacement, e.g.
     * T057 person variants, the LONGEST original stays canonical
     * regardless of entry order) and the type map. Per-type counters are
     * raised to the highest N found among '[TYPE_N]' replacements so new
     * entities anonymized afterwards continue numbering without colliding
     * (nextPlaceholder additionally skips any taken number, which also
     * covers renamed labels shaped like '[TYPE_N]'). Legacy
     * '<<REDACTED_N>>' replacements are kept verbatim in both maps; they
     * never collide with newly issued bracket placeholders and therefore
     * need no counter. Blanked entries ('________') are kept in the
     * forward map but excluded from the reverse map, preserving their
     * irreversibility. Entries merge into whatever the session already
     * holds; call clear() first for a fresh seeded session.
     *
     * R11: the input is validated BEFORE anything is applied (an array of
     * at most 10 000 well-formed entries, see validateImportEntry); a
     * violation throws and leaves the session untouched.
     */
    importEntries(entries: ReplacementEntry[]): void;
    /**
     * Rebuild a session from JSON produced by serialize() or by the Python
     * CLI's save_map. Mirrors Python's load_map: the per-entry map and
     * counter population is importEntries (see its doc for the exact
     * semantics, including legacy and blanked entries).
     */
    static deserialize(json: string): AnonymizationSession;
    clear(): void;
}
