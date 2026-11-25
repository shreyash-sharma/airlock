import { splitClauses } from "../core/clauses.js";
import { checkPolicy, DEFAULT_MAX_CHARS } from "../core/policy.js";
import { GUARD_NOTE, keywordSelect, prepare, type Prepared } from "../core/prepare.js";
import { isStreamingUrl, parseGeminiBody, restoreResponse } from "../core/request.js";
import { LocalAIError, type Clause, type Selection } from "../core/types.js";
import { Vault } from "../core/vault.js";
import type { Profile } from "../profiles/types.js";
import { newId, sha256Hex, type EngineContext, type NormalizedRequest, type Outcome } from "./engine.js";
import type { ClauseView, Decision, RequestView } from "./store.js";

/** Demo only: an unauthorized value the "inject a secret" button adds to a held payload. */
export const INJECTED_LEAK = "Internal note: build key sk_live_DEMO_INJECTED_0123456789abcdef";

/**
 * The v1 Gemini pipeline: clause minimization, on-device choice, masking, deterministic policy, explicit
 * approval of the exact body, re-scan, wire hash, and restoration of the answer. The messages, statuses
 * and audit events are the v1 ones; the only additive change is profileId on the request-held event.
 * Denials and cancellations still throw the v1 TypeErrors.
 */
export async function runAiMinimize(ctx: EngineContext, req: NormalizedRequest, profile: Profile): Promise<Outcome> {
  const { store, audit, analyzer } = ctx;
  const protectedTerms = ctx.getProtectedTerms();
  const maxChars = ctx.maxChars ?? DEFAULT_MAX_CHARS;
  const id = newId();
  const host = req.host;
  const view: RequestView = {
    id,
    createdAt: Date.now(),
    url: req.url,
    host,
    status: "analyzing",
    pipeline: "ai-minimize",
    profileId: profile.id,
    authoredBy: profile.author.by,
    method: req.method,
    path: req.path,
    startedAt: Date.now(),
    shape: "unknown",
    task: "",
    originalDocument: "",
    clauses: [],
  };
  store.create(view);

  const block = (message: string): Outcome => {
    store.update(id, { status: "blocked", message, endedAt: Date.now() });
    audit.add({ kind: "blocked", requestId: id, where: "code", detail: { reason: message } });
    return { kind: "block", reason: message };
  };

  if (isStreamingUrl(req.url)) return block("Streaming requests are not supported yet, so AIRLOCK cannot restore the answer safely.");
  if (req.method !== "POST" || req.body === null) return block("Only POST requests with a text body can be inspected.");

  const parsed = parseGeminiBody(req.body);
  if (!parsed.ok) return block(parsed.reason);
  const parsedReq = parsed.request;
  audit.add({ kind: "request-held", requestId: id, where: "code", detail: { host, shape: parsedReq.shape, profileId: profile.id } });

  const clauses: Clause[] = parsedReq.shape === "task+document" ? splitClauses(parsedReq.document) : [];
  store.update(id, {
    shape: parsedReq.shape,
    task: parsedReq.task,
    originalDocument: parsedReq.document || parsedReq.textParts.map((t) => t.text).join("\n\n"),
    clauses: clauses.map((c) => ({ id: c.id, heading: c.heading, tokens: c.tokens, text: c.text, selected: false })),
  });

  // 1. Choose clauses locally (a proposal only).
  let selection: Selection | null = null;
  if (parsedReq.shape === "task+document") {
    if (analyzer) {
      try {
        selection = await analyzer.select(parsedReq.task, clauses);
        audit.add({
          kind: "local-analysis",
          requestId: id,
          where: "on_device",
          latencyMs: selection.latencyMs,
          detail: { selected: selection.ids.length, total: clauses.length, calls: selection.calls },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const local = err instanceof LocalAIError ? err : new LocalAIError("failed", message);
        audit.add({ kind: "local-failed", requestId: id, where: "code", detail: { kind: local.kind } });
        store.update(id, {
          status: "local-failed",
          localError: local.message,
          message: "On-device analysis could not run, so nothing was sent.",
        });
        const decision = await store.waitForDecision(id);
        if (decision.kind !== "fallback") {
          const reason = decision.kind === "deny" ? decision.reason : undefined;
          audit.add({ kind: "denied", requestId: id, where: "code", detail: { stage: "local-failed", ...(reason ? { reason } : {}) } });
          store.update(id, { status: "denied", message: reason ?? "You cancelled. Nothing was sent." });
          throw new TypeError("AIRLOCK: cancelled by the user. Nothing was sent.");
        }
        selection = keywordSelect(parsedReq.task, clauses);
      }
    } else {
      selection = keywordSelect(parsedReq.task, clauses);
    }
  }

  // 2. Minimize, mask, and run the deterministic policy.
  const vault = new Vault();
  const prepared: Prepared = prepare(parsedReq, clauses, selection, vault, { protectedTerms, maxChars });
  const picked = new Set(prepared.selectedClauses.map((c) => c.id));
  const clauseViews: ClauseView[] = clauses.map((c) => ({
    id: c.id,
    heading: c.heading,
    tokens: c.tokens,
    text: c.text,
    selected: picked.has(c.id),
    reason: selection?.reasons[c.id],
    flag: prepared.flagged.find((f) => f.id === c.id)?.why,
  }));
  store.update(id, {
    clauses: clauseViews,
    flagged: prepared.flagged,
    selection: selection ? { source: selection.source, latencyMs: selection.latencyMs, calls: selection.calls } : undefined,
    prepared: {
      maskedTask: prepared.maskedTask,
      outboundText: prepared.outboundText,
      outboundBody: prepared.outboundBody,
      maskedCounts: prepared.maskedCounts,
      maskedTotal: prepared.maskedTotal,
      withheldClauses: prepared.withheldClauses,
      mode: prepared.mode,
    },
    policy: prepared.policy,
  });
  audit.add({
    kind: "policy",
    requestId: id,
    where: "code",
    detail: {
      pass: prepared.policy.pass,
      failures: prepared.policy.pass ? 0 : prepared.policy.failures.length,
      rules: prepared.policy.pass ? "" : [...new Set(prepared.policy.failures.map((f) => f.rule))].join(","),
      masked: prepared.maskedTotal,
      withheldClauses: prepared.withheldClauses,
      instructionLike: prepared.flagged.length,
    },
  });

  if (!prepared.policy.pass) {
    const first = prepared.policy.failures[0];
    return block(`policy rule "${first.rule}" failed: ${first.explain}`);
  }
  if (parsedReq.shape === "task+document" && prepared.selectedClauses.length === 0) {
    return block("No clause was selected for this task, so there is nothing safe to send.");
  }

  // 3. Wait for an explicit approval of this exact body.
  store.update(id, { status: "awaiting-approval" });
  const decision: Decision = ctx.autoApprove ? { kind: "approve" } : await store.waitForDecision(id);
  if (decision.kind === "inject") {
    // Real policy run on a really modified payload: simulates a bug or an injected document adding a secret.
    const tampered = `${prepared.outboundText}
${INJECTED_LEAK}`;
    const hit = checkPolicy({
      text: tampered.split(GUARD_NOTE).join(""),
      vaultOriginals: vault.originals(),
      allowedClauseIds: prepared.selectedClauses.map((c) => c.id),
      maxChars,
      protectedTerms,
    });
    const current = store.get(id)?.prepared;
    store.update(id, { injected: true, policy: hit, prepared: current ? { ...current, outboundText: tampered } : current });
    audit.add({
      kind: "policy",
      requestId: id,
      where: "code",
      detail: { pass: hit.pass, injected: true, rules: hit.pass ? "" : [...new Set(hit.failures.map((f) => f.rule))].join(",") },
    });
    if (!hit.pass) return block(`demo leak stopped by policy rule "${hit.failures[0].rule}": ${hit.failures[0].explain}`);
  }
  if (decision.kind !== "approve") {
    const reason = decision.kind === "deny" ? decision.reason : undefined;
    audit.add({ kind: "denied", requestId: id, where: "code", ...(reason ? { detail: { reason } } : {}) });
    store.update(id, { status: "denied", message: reason ?? "You denied this request. Nothing was sent.", endedAt: Date.now() });
    throw new TypeError(`AIRLOCK: ${reason ?? "denied by the user"}. Nothing was sent.`);
  }
  audit.add({ kind: "approved", requestId: id, where: "code" });

  // 4. Re-scan the exact body just before it leaves, then hand it to the adapter to send.
  const rescan = checkPolicy({
    text: prepared.outboundText.split(GUARD_NOTE).join(""),
    vaultOriginals: vault.originals(),
    allowedClauseIds: prepared.selectedClauses.map((c) => c.id),
    maxChars,
    protectedTerms,
  });
  if (!rescan.pass) return block(`pre-send re-scan failed: ${rescan.failures[0].explain}`);

  const wireHash = await sha256Hex(prepared.outboundBody);
  const bytes = new TextEncoder().encode(prepared.outboundBody).length;
  store.update(id, { status: "sending", wireHash, bytesSent: bytes });
  audit.add({
    kind: "sent",
    requestId: id,
    where: "in_cloud",
    detail: {
      host,
      bytes,
      wireHash,
      withheld: prepared.maskedTotal + prepared.withheldClauses,
      clauses: prepared.selectedClauses.length,
    },
  });

  return {
    kind: "protect",
    body: prepared.outboundBody,
    onError(err) {
      const message = err instanceof Error ? err.message : String(err);
      store.update(id, { status: "failed", message: `The cloud request failed after approval: ${message}`, endedAt: Date.now() });
      audit.add({ kind: "error", requestId: id, where: "in_cloud", detail: { reason: message } });
    },
    // 5. Restore placeholders in the (non-streaming) answer before the page sees it.
    onResponse(status, raw, latency) {
      if (status < 200 || status > 299) {
        store.update(id, { status: "failed", cloudLatencyMs: latency, message: `Cloud returned HTTP ${status}.`, endedAt: Date.now() });
        audit.add({ kind: "error", requestId: id, where: "in_cloud", latencyMs: latency, detail: { status } });
        return raw;
      }
      const restored = restoreResponse(raw, (t) => vault.restore(t));
      if (!restored) {
        store.update(id, { status: "done", cloudLatencyMs: latency, message: "The answer was not JSON, so it was returned unchanged.", endedAt: Date.now() });
        return raw;
      }
      const unresolved = vault.unresolved(restored.cloudView);
      const allowedIds = new Set(prepared.selectedClauses.map((c) => c.id));
      const cited = [...new Set([...restored.cloudView.matchAll(/\[(C\d+)\]/g)].map((m) => m[1]))];
      const outside = cited.filter((c) => !allowedIds.has(c));
      store.update(id, {
        citations: { cited, outside },
        status: "done",
        cloudView: restored.cloudView,
        restoredView: restored.restoredView,
        unresolved,
        cloudLatencyMs: latency,
        endedAt: Date.now(),
      });
      audit.add({
        kind: "response",
        requestId: id,
        where: "in_cloud",
        latencyMs: latency,
        detail: { unresolved: unresolved.length, cited: cited.length, citedOutside: outside.length },
      });
      return restored.restoredBody;
    },
  };
}
