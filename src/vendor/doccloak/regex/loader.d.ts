/**
 * Loader for the shared rules format (T018, arch doc section 6).
 *
 * Turns the canonical rules/*.json data (embedded at authoring time as
 * rules.data.ts) into runtime RegexRule objects: compiles each pattern with
 * its declared flags and resolves `validate` names against the validator
 * registry. An unknown validator name throws, which surfaces at module init
 * time because index.ts calls loadRegexRules() at module scope.
 */
import type { EntityType } from '../types.js';
import type { PiiDomain, RegexRule, RegionCode } from './types.js';
/** JSON shape of a single rule inside a rules/<region>.json pack. */
export interface RegexRuleJson {
    /** Stable detector identifier, e.g. 'regex:pl:pesel' */
    id: string;
    /** Entity type the rule detects */
    entityType: EntityType;
    /** Regex source (ECMAScript/Python common subset) */
    pattern: string;
    /** Regex flags; must include 'g' */
    flags: string;
    /** Default confidence score (0-1) */
    confidence: number;
    /** Domain tags for categorization/filtering */
    domains: PiiDomain[];
    /** Human-readable description for developers maintaining rules */
    description: string;
    /** Example strings that SHOULD match (used in auto-generated tests) */
    examples?: string[];
    /** Known false-positive patterns or notes */
    falsePositiveNotes?: string;
    /** Name of a post-match validation function in the validator registry */
    validate?: string;
    /** Run against the whole document instead of line by line (default false) */
    multiline?: boolean;
}
/** JSON shape of a whole rules/<region>.json file. */
export interface RegionRulesJson {
    region: RegionCode;
    rules: readonly RegexRuleJson[];
}
/**
 * Compile rule packs into the flat RegexRule list, preserving pack order and
 * in-pack rule order (the concatenation order defines ALL_REGEX_RULES).
 */
export declare function loadRegexRules(packs: readonly RegionRulesJson[]): RegexRule[];
