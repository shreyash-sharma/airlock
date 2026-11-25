import { getAll } from "../profiles/jsonpath.js";
import type { DryRun } from "../profiles/types.js";
import { BlockError, restoreText } from "./actions.js";
import { applyFlows, rescanOutbound, restoreResponse } from "./protect.js";
import { DEFAULT_RULES, resolveDestination } from "./rules.js";
import { FlowState } from "./state.js";

/**
 * Vet an authored profile against one captured sample without sending anything. The run uses a throwaway
 * FlowState with no storage behind it, so the persisted vault, token key and token index are never read or
 * written. Approval is skipped (nothing is sent). Every failure is a "path: rule" string; values never
 * appear in a failure.
 *
 * Checks, in order: the request flows apply and the residual scan is clean; no removed original and no
 * value the classifier marked sensitive is still in the outbound body (an explicit allow is no exemption);
 * and the restore round trip works. The round trip runs on sample.response when there is one, and
 * then every response location must be found and every protected value at one must come back. Without a
 * sample response the protected request is echoed back (create endpoints return the record) and only
 * locations that do resolve are held to the restore check.
 */
export const dryRun: DryRun = async (profile, sample, rules = DEFAULT_RULES) => {
  const failures: string[] = [];
  const fail = (path: string, rule: string): void => {
    const entry = `${path}: ${rule}`;
    if (!failures.includes(entry)) failures.push(entry);
  };
  const state = new FlowState();
  const dest = resolveDestination(rules, profile.match.hosts[0] ?? "", profile.kind);

  let original: string;
  try {
    original = JSON.stringify(sample.request);
  } catch {
    return { ok: false, failures: ["$: request-not-json"], restored: false };
  }
  if (original === undefined) return { ok: false, failures: ["$: request-not-json"], restored: false };

  let run;
  try {
    run = await applyFlows({ state, dest, profile, root: structuredClone(sample.request), original, json: true, protectedTerms: [] });
  } catch (err) {
    if (err instanceof BlockError) fail(err.path, "block");
    else fail("$", "profile-not-applicable");
    return { ok: false, failures, restored: false };
  }

  for (const finding of run.findings) fail(finding.path, finding.failure.rule);
  const rescan = rescanOutbound(run.outbound, run.touched);
  if (rescan) fail("$", rescan.rule);
  for (const s of sample.sensitive) {
    // No exemption for an explicit allow: only a flow that removes the value clears this failure.
    if (rescanOutbound(run.outbound, [s.value])) fail(s.path, "sensitive-value-remains");
  }

  // Restore round trip, per protected leaf: the replacement that left must give back exactly the original.
  const sent = JSON.parse(run.outbound) as unknown;
  const replacements: string[] = [];
  let roundTripOk = true;
  for (const leaf of run.report) {
    if (!leaf.restorable) continue;
    const before = getAll(sample.request, leaf.path)[0]?.value;
    const after = getAll(sent, leaf.path)[0]?.value;
    if (typeof after !== "string" || before === undefined) continue;
    replacements.push(after);
    if (restoreText(state, after) !== String(before)) {
      roundTripOk = false;
      fail(leaf.path, "restore-mismatch");
    }
  }

  const echo = sample.response === undefined;
  const answer = echo ? run.outbound : JSON.stringify(sample.response);
  const restored = restoreResponse(state, profile, answer);
  if (!echo && restored.resolved === 0) {
    roundTripOk = false;
    fail("response", "no response field resolves");
  }
  if (restored.resolved > 0) {
    for (const r of replacements) {
      if (r.length >= 3 && restored.text.includes(r)) {
        roundTripOk = false;
        fail("response", "protected value not restored at a response field");
        break;
      }
    }
  }

  return { ok: failures.length === 0, failures, restored: run.restorable > 0 && roundTripOk };
};
