import { VALIDATORS } from "./validators.js";
function compileRule(region, json) {
    let pattern;
    try {
        pattern = new RegExp(json.pattern, json.flags);
    }
    catch (err) {
        throw new Error(`Rule ${json.id}: pattern does not compile with flags "${json.flags}": ${String(err)}`);
    }
    const rule = {
        pattern,
        type: json.entityType,
        detector: json.id,
        confidence: json.confidence,
        region,
        domains: json.domains,
        description: json.description,
    };
    if (json.examples !== undefined)
        rule.examples = json.examples;
    if (json.falsePositiveNotes !== undefined)
        rule.falsePositiveNotes = json.falsePositiveNotes;
    if (json.multiline !== undefined)
        rule.multiline = json.multiline;
    if (json.validate !== undefined) {
        const validate = VALIDATORS[json.validate];
        if (validate === undefined) {
            throw new Error(`Rule ${json.id}: unknown validator "${json.validate}" (not in the validators.ts registry)`);
        }
        rule.validate = validate;
    }
    return rule;
}
/**
 * Compile rule packs into the flat RegexRule list, preserving pack order and
 * in-pack rule order (the concatenation order defines ALL_REGEX_RULES).
 */
export function loadRegexRules(packs) {
    const rules = [];
    for (const pack of packs) {
        for (const json of pack.rules) {
            rules.push(compileRule(pack.region, json));
        }
    }
    return rules;
}
