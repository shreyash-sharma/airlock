import { detect } from "../core/detect.js";
import type { EntityType } from "../core/types.js";
import { CATEGORY_OF_ENTITY, type Action, type Category, type FlowParams } from "../profiles/types.js";
import { renderFor } from "./roles.js";
import type { FlowState } from "./state.js";
import { TokenCollisionError } from "./token.js";

/** A request that must not leave. The message names the path and category, never a value. */
export class BlockError extends Error {
  readonly path: string;
  readonly category?: Category;
  constructor(message: string, path: string, category?: Category) {
    super(message);
    this.name = "BlockError";
    this.path = path;
    this.category = category;
  }
}

/** A whole value that already is a vault placeholder such as [EMAIL_1]. */
export const PLACEHOLDER_SHAPE = /^\[[A-Z_]+_\d+(?:_[A-Z0-9_]+)?\]$/;
/** A whole value that already is a deterministic token. */
export const TOKEN_SHAPE = /^tok_[a-z2-7]{22}$/;

/** True for a value an earlier pass already protected, which must pass through unchanged. */
export const alreadyProtected = (text: string): boolean => PLACEHOLDER_SHAPE.test(text) || TOKEN_SHAPE.test(text);

export interface ActionContext {
  /** Concrete path of the leaf, for messages only. */
  path: string;
  category?: Category;
  params?: FlowParams;
  protectedTerms: readonly string[];
}

export type ActionOutcome =
  | { kind: "keep" }
  | { kind: "drop"; touched: string[] }
  | {
      kind: "replace";
      value: string;
      /** Original values this action removed from the leaf: none of them may appear in the outbound body. */
      touched: string[];
      /** True when the replacement is the original text with only some parts swapped (free text), so it is still scanned. */
      partial: boolean;
      restorable: boolean;
    };

const keep: ActionOutcome = { kind: "keep" };

/** Apply one action to one leaf value. Pure with respect to the request: only the vault state changes. */
export async function applyAction(
  state: FlowState,
  action: Action,
  value: string | number | boolean,
  ctx: ActionContext,
): Promise<ActionOutcome> {
  const text = typeof value === "string" ? value : String(value);
  switch (action) {
    case "allow":
      return keep;
    case "block":
      throw new BlockError(`the field ${ctx.path}${ctx.category ? ` (${ctx.category})` : ""} is set to block, so the request was not sent`, ctx.path, ctx.category);
    case "drop":
      return { kind: "drop", touched: [text] };
    case "mask":
      return maskValue(state, text, ctx);
    case "surrogate":
      return surrogateValue(state, text, ctx);
    case "token":
      return tokenValue(state, text, ctx);
    default:
      throw new BlockError(`the action "${action}" is not available for ${ctx.path}`, ctx.path, ctx.category);
  }
}

/** A realistic fake from the surrogate session: params.entity, else what a detector saw, else a person name. */
function surrogateValue(state: FlowState, text: string, ctx: ActionContext): ActionOutcome {
  if (text.trim() === "") return keep;
  const asked = typeof ctx.params?.entity === "string" ? ctx.params.entity : undefined;
  const type: EntityType = asked !== undefined && asked in CATEGORY_OF_ENTITY ? (asked as EntityType) : (detect(text, { protectedTerms: ctx.protectedTerms })[0]?.type ?? "PERSON");
  return { kind: "replace", value: state.surrogate.anonymize(text, type), touched: [text], partial: false, restorable: true };
}

/** A deterministic keyed token. A collision never maps two originals to one token: the request is blocked. */
async function tokenValue(state: FlowState, text: string, ctx: ActionContext): Promise<ActionOutcome> {
  if (text.trim() === "") return keep;
  try {
    return { kind: "replace", value: await state.tokens.token(text), touched: [text], partial: false, restorable: true };
  } catch (err) {
    if (err instanceof TokenCollisionError) {
      throw new BlockError(`token collision at ${ctx.path}${ctx.category ? ` (${ctx.category})` : ""}, so the request was not sent`, ctx.path, ctx.category);
    }
    throw err;
  }
}

function maskValue(state: FlowState, text: string, ctx: ActionContext): ActionOutcome {
  if (text.trim() === "") return keep;
  const hits = detect(text, { protectedTerms: ctx.protectedTerms });
  if (ctx.category === "free_text" || ctx.category === undefined) {
    // Free text keeps its words: only what a detector found is replaced.
    if (hits.length === 0) return keep;
    return { kind: "replace", value: state.labeled.anonymizeText(text, hits), touched: hits.map((h) => h.value), partial: true, restorable: true };
  }
  // Anything else is replaced whole, typed by what a detector saw, else OTHER.
  const type = hits[0]?.type ?? "OTHER";
  return { kind: "replace", value: state.labeled.anonymize(text, type), touched: [text], partial: false, restorable: true };
}

/** Put protected values back into text that came back from the SaaS: placeholders, surrogates, tokens. Synchronous: XHR getters need it. */
export function restoreText(state: FlowState, text: string): string {
  if (state.role === "owner") return state.tokens.restoreText(state.surrogate.deanonymize(state.labeled.deanonymize(text)));
  return restoreForRole(state, text);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Restore for a non-owner viewer: each stand-in found in the text comes back as that role is allowed to see it. One pass, longest stand-in first. */
function restoreForRole(state: FlowState, text: string): string {
  const known = new Map<string, { original: string; type?: string }>();
  for (const session of [state.labeled, state.surrogate]) {
    for (const e of session.getEntries()) if (e.replacement && !known.has(e.replacement)) known.set(e.replacement, { original: e.original, type: e.entityType });
  }
  for (const [token, original] of Object.entries(state.tokens.exportIndex())) known.set(token, { original });
  if (known.size === 0) return text;
  const keys = [...known.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(keys.map(escapeRe).join("|"), "g");
  return text.replace(re, (hit) => {
    const k = known.get(hit);
    return k ? renderFor(state.role, k.original, hit, k.type) : hit;
  });
}
