/**
 * Validator registry for the shared rules format (T018, arch doc section 6).
 *
 * Every function here was extracted verbatim from a former inline `validate`
 * closure in the TS rule modules; behavior is intentionally identical.
 * The `validate` field in rules/*.json refers to these names, resolved by
 * loader.ts. Python resolves the same names against its own registry
 * (DocCloak.Cli validators.py); where a Python equivalent exists the name
 * matches it: pesel_check -> pesel, nip_check -> nip, nino_check -> nino,
 * luhn_check -> luhn, nir_check -> nir, ipv4_check -> ipOctets.
 */
export type RuleValidator = (match: string) => boolean;
/**
 * Shannon entropy of a string in bits per character. Exported for tests
 * and threshold tuning; the secrets-tier validators below gate the
 * generic candidate rules on it (detect-secrets / Prompt Armour
 * precedent). Named patterns (AKIA..., ghp_...) need no entropy gate.
 */
export declare function shannonEntropy(value: string): number;
/**
 * The registry. Keys are the names allowed in the `validate` field of
 * rules/*.json; loader.ts throws at module init on any unknown name.
 */
export declare const VALIDATORS: Readonly<Record<string, RuleValidator>>;
