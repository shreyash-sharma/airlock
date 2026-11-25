import type { EngineContext, NormalizedRequest, Outcome } from "../net/engine.js";
import { newId } from "../net/engine.js";
import { hostMatches } from "../profiles/match.js";
import type { Destination, FieldSpec, Profile } from "../profiles/types.js";
import { restoreResponse, scanUrl } from "./protect.js";

/**
 * Reads without a body to a host the user allowed them for. A GET or HEAD that no profile covers is normally held or
 * blocked, which stops a real single-page app that loads dozens of its own resources from a configured host. When
 * the user sets "allow reads without a body" on that host, such a read goes through this pipeline instead: the URL
 * path and query are scanned exactly as for a covered request (a sensitive value blocks it), nothing else is sent
 * (there is no body), the answer is restored at the response locators the host's profiles already carry, and the
 * release is recorded in the audit log. This pipeline is never used for a request with a body or for a write.
 */
export type ReadPipeline = (ctx: EngineContext, req: NormalizedRequest, dest: Destination, profiles: readonly Profile[]) => Promise<Outcome>;

export const isReadWithoutBody = (req: NormalizedRequest): boolean =>
  (req.method === "GET" || req.method === "HEAD") && req.bodyKind !== "unsupported" && (req.body === null || req.body.trim() === "");

export const runReadThrough: ReadPipeline = async (ctx, req, dest, profiles) => {
  const { store, audit } = ctx;
  const id = newId();
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
    pipeline: "field-protect",
    profileId: "allow-reads",
    authoredBy: "user",
    method: req.method,
    path: req.path,
    destinationId: dest.id,
    startedAt: Date.now(),
  });
  const block = (message: string): Outcome => {
    store.update(id, { status: "blocked", message, endedAt: Date.now() });
    audit.add({ kind: "blocked", requestId: id, where: "code", detail: { reason: message, rule: "allow-reads" } });
    return { kind: "block", reason: message };
  };
  if (!isReadWithoutBody(req)) return block("The allow-reads rule covers only a GET or HEAD with no body. Nothing was sent.");

  const findings = scanUrl(req, dest, ctx.getProtectedTerms(), []);
  if (findings.length > 0) {
    store.update(id, { url: `${req.host} (URL withheld: it held a sensitive value)`, path: "(withheld)" });
    audit.add({ kind: "policy", requestId: id, where: "code", detail: { pass: false, failures: findings.length, rules: "no-residual-detection", rule: "allow-reads" } });
    return block(`policy rule "${findings[0].failure.rule}" failed at ${findings[0].path}: ${findings[0].failure.explain}`);
  }

  const state = ctx.flow;
  // The response locators this host's profiles already carry, de-duplicated. Restoring only replaces values this engine protected.
  const fields: FieldSpec[] = [];
  for (const p of profiles) {
    if (!p.match.hosts.some((h) => hostMatches(h, req.host))) continue;
    for (const f of p.response.fields) if (!fields.some((x) => x.path === f.path)) fields.push({ path: f.path });
  }
  const carrier: Profile | null = profiles.length > 0 ? { ...profiles[0], response: { fields } } : null;

  store.update(id, { status: "sending", bytesSent: 0, notes: ["A read with no body, released under your allow-reads rule for this host. The URL was scanned."] });
  audit.add({
    kind: "read-released",
    requestId: id,
    where: "in_cloud",
    detail: { host: req.host, method: req.method, path: req.path, bytes: 0, destination: dest.id },
  });
  return {
    kind: "protect",
    body: null,
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
      if (!state || !carrier || fields.length === 0) {
        store.update(id, { status: "done", cloudLatencyMs: latency, endedAt: Date.now(), restoredCount: 0 });
        return raw;
      }
      const restored = restoreResponse(state, carrier, raw);
      store.update(id, { status: "done", cloudLatencyMs: latency, endedAt: Date.now(), restoredCount: restored.restoredLeaves });
      if (restored.restoredLeaves > 0) {
        audit.add({ kind: "response", requestId: id, where: "in_cloud", latencyMs: latency, detail: { restored: restored.restoredLeaves, fields: restored.resolved, rule: "allow-reads" } });
      }
      return restored.text;
    },
  };
};
