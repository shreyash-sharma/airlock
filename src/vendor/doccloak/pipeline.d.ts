/**
 * Pure entity pipeline (T005).
 *
 * Extracted from the web app's detection.worker.ts: text and entities in,
 * entities out. No worker messaging, no providers, no environment access.
 * The worker (and any other host) composes these functions around its own
 * ML provider call.
 *
 * Security pass 2026-09:
 *  - T180: detectWithRegex runs every rule line by line (rules flagged
 *    `multiline` see the whole text), so quadratic patterns cost O(line^2)
 *    instead of O(document^2).
 *  - T181: filterFalsePositives is script-aware (CJK/Thai and PERSON values
 *    of two characters survive) and propagateEntities uses Unicode letter/
 *    digit boundaries, exact offsets on the original text and a common-word
 *    guard for lowercase PERSON matches.
 */
import type { DetectedEntity } from './types.js';
import type { RegexRule } from './regex/types.js';
/** One newline-free slice of the input plus its offset in the original text. */
interface TextSegment {
    text: string;
    offset: number;
}
/**
 * Split on '\n' keeping offsets. '\r' stays inside the line (a CRLF line then
 * ends with '\r', exactly as it did when the whole text was matched at once).
 * Empty lines are skipped: no rule can match the empty string.
 */
export declare function segmentLines(text: string): TextSegment[];
/**
 * The part of a company or street match that is a name, as [offset into the
 * value, value], or null when nothing name-like is left. Other rules pass
 * through unchanged.
 */
export declare function nameRunOf(rule: RegexRule, value: string): [number, string] | null;
/**
 * Run the regex rules of a region over the text.
 *
 * Rules without `multiline` run on each line separately (offsets are added
 * back, so spans are document-absolute); rules with `multiline: true` run on
 * the whole text. Output order is rule-major, then position, as before.
 *
 * Complexity note (T180): several street/company rules are quadratic in the
 * length of their input. Per-line matching bounds that to the longest line,
 * so 100 KB of ordinary prose is fast; a single 100 KB line without newlines
 * is still slow until the patterns themselves are bounded (T198).
 */
export declare function detectWithRegex(text: string, regexRegion?: string): DetectedEntity[];
export declare function resolveOverlaps(entities: DetectedEntity[]): DetectedEntity[];
/**
 * Word-level providers (BardS.ai splits on whitespace) return spans that
 * carry the punctuation glued to the last word: "Anna Nowak," or
 * "jan@example.com.". The redacted text then loses that punctuation and the
 * mapping stores it as part of the value. Trim a fixed set of opening and
 * closing punctuation at both ends of every span (T204); a span that would
 * become empty is dropped. Regex spans are not passed through this: their
 * patterns already stop at the identifier.
 */
export declare function trimSpanPunctuation(entities: DetectedEntity[]): DetectedEntity[];
/**
 * A model span never runs across a line break (T260). Word-level providers
 * merge neighbouring words of one type, and the end of one paragraph or
 * table cell gets glued to the start of the next: "Banque Phocéenne de
 * Crédit\n40" (the house number of the address below), "18 000,00\nB" (the
 * first letter of the next cell). One placeholder then swallowed the line
 * break in pasted text, and in a document it stood in the first paragraph
 * while a piece of the second one vanished.
 *
 * Each line's part becomes its own span, so a two-line address is two
 * values that go back where they were. A part too short to be a value on
 * its own (what filterFalsePositives would drop) is not left in clear when
 * it touches another model span on its line: that span grows over it ("40"
 * joins "La Canebière, 13001 Marseille"). Otherwise it is dropped: it was
 * never a value, only the tail of a wrong merge. Regex spans are matched
 * line by line already (segmentLines).
 */
export declare function splitAtLineBreaks(text: string, entities: DetectedEntity[]): DetectedEntity[];
/**
 * Two-character PERSON values that are titles, suffixes or abbreviations,
 * never names. Compared against the lowercased trimmed value (T181, R2).
 */
export declare const PERSON_SHORT_STOPLIST: ReadonlySet<string>;
/**
 * Drop ML spans that are too short to be real entities (R2):
 *  - values containing CJK or Thai characters: at least 2 code points, any type
 *  - PERSON: at least 2 characters, unless the value is a known 2-letter
 *    title/suffix (PERSON_SHORT_STOPLIST); initials like "J." pass
 *  - every other type: at least 3 characters (unchanged)
 */
export declare function filterFalsePositives(entities: DetectedEntity[]): DetectedEntity[];
/**
 * Words that are also given names or surnames, per language (T181, R15).
 * A PERSON term found in the text with DIFFERENT casing than the detected
 * entity, and NOT starting with an uppercase letter, is skipped when its
 * lowercase form is listed here: "Bill" the person never turns "the bill is
 * due" into "[PERSON_1] is due". Capitalised and ALL-CAPS mentions always
 * propagate, and lowercase mentions of ordinary names ("thanks john") are
 * still caught (golden prop-03-case-insensitive).
 *
 * Only words that appear in lowercase in running prose belong here. German
 * nouns are always capitalised in prose, so the DE list holds adjectives and
 * month names that double as surnames or first names; the PL list holds
 * nouns (animals, months, plants) that are frequent Polish surnames and
 * first names.
 */
export declare const COMMON_WORD_NAMES: Readonly<Record<'en' | 'pl' | 'de', readonly string[]>>;
/**
 * Find every further occurrence of each detected value (and of the words of
 * multi-word values) in the text and emit it as a 'propagated' entity.
 *
 * Terms: whole values of at least 2 characters; words of multi-word values
 * of at least 4 characters (trailing punctuation stripped). Terms of at most
 * 2 characters match with exact case; longer terms match case-insensitively
 * (Unicode case folding via the 'iu' flags) on the ORIGINAL text, so offsets
 * are exact even after characters whose lowercase form has a different
 * length (Turkish dotted İ). A hit needs a non-letter, non-digit neighbour
 * on both sides ([\p{L}\p{N}] complement), except on a side where the term
 * itself ends in an unspaced script (CJK, Thai), and before a capitalised hit
 * glued to an elision whose apostrophe OCR dropped ("dALTAMIR").
 */
export declare function propagateEntities(text: string, entities: DetectedEntity[]): DetectedEntity[];
/**
 * T230: a catch-all regex span yields to the specific detections it
 * overlaps. `long_number` admits whitespace, so a PESEL cell followed by a
 * phone cell ("90050598761 512 987 654") is one 23-character span that
 * resolveOverlaps prefers (same start, longer) over PESEL 0.9 + PHONE 0.8:
 * the row came out as one [SSN] and the phone "was not detected".
 *
 * Every catch-all that overlaps a specific span is replaced by its
 * leftovers: the uncovered slices are re-run through the same rule, so an
 * unknown long number next to a phone is still caught, and the specific
 * spans then win. Catch-alls nothing specific overlaps are untouched, and
 * so is everything else (the leak-averse "earlier start, longer span" order
 * stays for all other overlaps).
 */
export declare function splitCatchAlls(text: string, entities: DetectedEntity[]): DetectedEntity[];
export declare function detectEntities(text: string, mlEntities: DetectedEntity[], regexEntities: DetectedEntity[]): DetectedEntity[];
export {};
