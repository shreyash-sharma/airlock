import { detect } from "../core/detect.js";
import type { Outcome, EngineContext, NormalizedRequest } from "../net/engine.js";
import { newId, sha256Hex } from "../net/engine.js";
import type { Destination } from "../profiles/types.js";
import { restoreText } from "./actions.js";
import { isCacheBuster } from "./protect.js";
import type { FlowState } from "./state.js";

/**
 * Inline mode, for SaaS destinations only (a CRM). The user of a CRM must never wait, so nothing here blocks or
 * asks: every detected value is replaced by a keyed token (or, for an email or phone, a realistic same-shape stand-in) from the local vault and the request is sent at once.
 * What deserves a human look is recorded as review reasons and shown in the console afterwards. A value no
 * detector finds is NOT protected in this mode, and that limit is stated in the README. Tokens are reversible
 * substitution from a local index, not encryption. AI destinations never use this module.
 */

/** A destination is inline only when its rule says so. The default SaaS rule does; an AI destination never can. */
export function isInlineDestination(dest: Destination): boolean {
  return dest.match.kind !== "ai" && dest.inline === true;
}

/** Replace every detected value in one string by its token. Returns the new text and how many values changed. */
export async function maskText(state: FlowState, text: string, terms: readonly string[]): Promise<{ text: string; count: number }> {
  const hits = detect(text, { protectedTerms: terms });
  if (hits.length === 0) return { text, count: 0 };
  let out = "";
  let at = 0;
  let count = 0;
  for (const hit of hits) {
    if (hit.start < at) continue;
    // An email or a phone number becomes a realistic stand-in of the same shape, because a CRM validates those fields and
    // rejects a bare token. Everything else becomes a keyed token. Both are put back in the answer from the local vault.
    const stand = hit.type === "EMAIL" || hit.type === "PHONE" ? state.surrogate.anonymize(hit.value, hit.type) : await state.tokens.token(hit.value);
    out += text.slice(at, hit.start) + stand;
    at = hit.end;
    count++;
  }
  return { text: out + text.slice(at), count };
}

async function maskTree(state: FlowState, node: unknown, terms: readonly string[], tally: { n: number }): Promise<unknown> {
  if (typeof node === "string") {
    const r = await maskText(state, node, terms);
    tally.n += r.count;
    return r.text;
  }
  if (Array.isArray(node)) return Promise.all(node.map((x) => maskTree(state, x, terms, tally)));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = await maskTree(state, v, terms, tally);
    return out;
  }
  return node;
}

/** Mask a request body: JSON leaf by leaf, anything else as one text. */
export async function maskBody(state: FlowState, body: string, terms: readonly string[]): Promise<{ text: string; count: number }> {
  try {
    const tally = { n: 0 };
    const masked = await maskTree(state, JSON.parse(body), terms, tally);
    return tally.n === 0 ? { text: body, count: 0 } : { text: JSON.stringify(masked), count: tally.n };
  } catch {
    return maskText(state, body, terms);
  }
}

/** Mask the path segments and query values of a URL. Cache-buster epochs are left alone. */
export async function maskUrl(state: FlowState, rawUrl: string, terms: readonly string[]): Promise<{ url: string; count: number }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { url: rawUrl, count: 0 };
  }
  let count = 0;
  const part = async (raw: string): Promise<string> => {
    let plain = raw;
    try {
      plain = decodeURIComponent(raw.replace(/\+/g, " "));
    } catch {
      /* keep raw */
    }
    const r = await maskText(state, plain, terms);
    if (r.count === 0) return raw;
    count += r.count;
    return encodeURIComponent(r.text);
  };
  const segments = await Promise.all(url.pathname.split("/").map((s) => (s === "" ? s : part(s))));
  const pairs = url.search.length > 1 ? url.search.slice(1).split("&") : [];
  const query: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      query.push(await part(pair));
      continue;
    }
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    query.push(`${await part(key)}=${isCacheBuster(key, value) ? value : await part(value)}`);
  }
  url.pathname = segments.join("/");
  url.search = query.length > 0 ? `?${query.join("&")}` : "";
  return { url: url.href, count };
}

/** Put the tokens this vault issued back into the answer's string leaves, so the app shows real values. */
export function restoreAnswer(state: FlowState, text: string): { text: string; restored: number } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    const back = restoreText(state, text);
    return { text: back, restored: back === text ? 0 : 1 };
  }
  let restored = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const back = restoreText(state, node);
      if (back !== node) restored++;
      return back;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  const out = walk(root);
  return { text: restored > 0 ? JSON.stringify(out) : text, restored };
}

/** Record why a request deserves a later look. Reasons are plain words and never carry a value. */
export function flagForReview(ctx: EngineContext, id: string, reasons: readonly string[]): void {
  if (reasons.length === 0) return;
  const prior = ctx.store.get(id)?.reviewReasons ?? [];
  const all = [...new Set([...prior, ...reasons])];
  ctx.store.update(id, { reviewReasons: all });
  ctx.audit.add({ kind: "review-flag", requestId: id, where: "code", detail: { reasons: all.join(" | ") } });
}

/**
 * The generic pipeline for a request no profile covers (or a profile could not apply) on an inline destination.
 * It masks the body and the URL with the detectors and sends. It never blocks. An existing request id can be
 * passed so the profile pipeline's record is reused instead of duplicated.
 */
export async function runInlineMask(ctx: EngineContext, req: NormalizedRequest, dest: Destination, existingId?: string, why?: string): Promise<Outcome> {
  const { store, audit } = ctx;
  const state = ctx.flow;
  const terms = ctx.getProtectedTerms();
  const id = existingId ?? newId();
  const base = {
    pipeline: "field-protect" as const,
    profileId: why ? "inline-fallback" : "inline-generic",
    authoredBy: "code",
    method: req.method,
    path: req.path,
    destinationId: dest.id,
  };
  if (existingId) store.update(id, base);
  else {
    store.create({
      id,
      createdAt: Date.now(),
      url: req.url,
      host: req.host,
      status: "analyzing",
      shape: "unknown",
      task: "",
      originalDocument: "",
      clauses: [],
      startedAt: Date.now(),
      ...base,
      ...(req.body !== null && req.body.trim() !== "" ? { originalBody: req.body } : {}),
    });
  }
  const reasons: string[] = [];
  if (why) reasons.push(why);
  else reasons.push("No profile covered this request, so the generic detectors masked it.");

  let body = req.body;
  let url = req.url;
  let masked = 0;
  if (!state) {
    reasons.push("No vault was available, so nothing could be masked.");
  } else {
    if (req.bodyKind === "unsupported") {
      reasons.push(`The body is a ${req.bodyType ?? "non-text type"}, which cannot be inspected, so it was sent as it is.`);
    } else if (body !== null && body.trim() !== "") {
      const r = await maskBody(state, body, terms);
      body = r.text;
      masked += r.count;
    }
    const u = await maskUrl(state, req.url, terms);
    url = u.url;
    masked += u.count;
    if (masked > 0) {
      try {
        await state.save();
      } catch {
        reasons.push("The vault could not be saved, so these tokens may not be restorable after a reload.");
      }
    }
  }
  if (masked > 0) reasons.push(`${masked} value(s) were replaced by tokens.`);
  flagForReview(ctx, id, reasons);

  const wire = req.bodyKind === "unsupported" ? "" : (body ?? "");
  const wireHash = await sha256Hex(wire);
  const bytes = new TextEncoder().encode(wire).length;
  store.update(id, { status: "sending", wireHash, bytesSent: bytes, outboundBody: body ?? undefined, approvedBy: "auto", actionCounts: masked > 0 ? { token: masked } : {} });
  audit.add({ kind: "approved", requestId: id, where: "code", detail: { by: "inline mode (no wait)", destination: dest.id } });
  audit.add({ kind: "sent", requestId: id, where: "in_cloud", detail: { host: req.host, bytes, wireHash, withheld: masked, profileId: base.profileId } });

  return {
    kind: "protect",
    body: req.bodyKind === "unsupported" ? req.body : body,
    ...(url !== req.url ? { url } : {}),
    onError(err) {
      const message = err instanceof Error ? err.message : String(err);
      store.update(id, { status: "failed", message: `The request failed after it was sent: ${message}`, endedAt: Date.now() });
      audit.add({ kind: "error", requestId: id, where: "in_cloud", detail: { reason: message } });
    },
    onResponse(status, raw, latency) {
      if (status < 200 || status > 299) {
        store.update(id, { status: "failed", cloudLatencyMs: latency, message: `The server returned HTTP ${status}.`, endedAt: Date.now() });
        audit.add({ kind: "error", requestId: id, where: "in_cloud", latencyMs: latency, detail: { status } });
        return raw;
      }
      if (!state) {
        store.update(id, { status: "done", cloudLatencyMs: latency, endedAt: Date.now(), restoredCount: 0 });
        return raw;
      }
      const back = restoreAnswer(state, raw);
      store.update(id, { status: "done", cloudLatencyMs: latency, endedAt: Date.now(), restoredCount: back.restored });
      if (back.restored > 0) audit.add({ kind: "response", requestId: id, where: "in_cloud", latencyMs: latency, detail: { restored: back.restored, fields: 0, profileId: base.profileId } });
      return back.text;
    },
  };
}
