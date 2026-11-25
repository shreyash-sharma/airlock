// Dev-only harness page for the answer-quality evaluation (scripts/eval-quality.mjs drives it over CDP).
// It runs the REAL pieces: the Firebase AI Logic cloud model the app uses, and for the AIRLOCK arm the real
// guard with the real on-device Gemini Nano analyzer. It does not score anything: scoring is deterministic and
// lives in the Node script. The harness stands in for the human approver by approving through the real store
// (the same call the Approve button makes); a local-model failure is denied, never replaced by keyword selection.
import { splitClauses } from "../airlock/core/clauses.js";
import { installAirlock, type InstalledAirlock } from "../airlock/install.js";
import type { KVStore } from "../airlock/profiles/storage.js";
import { CLOUD_MODEL_NAME, cloudModel, getLocalJsonModel } from "../firebase.js";
import { SAMPLE_CONTRACT } from "../host/sample-contract.js";

export type Arm = "baseline" | "airlock" | "withhold" | "overmask";

const memory = new Map<string, string>();
const kv: KVStore = { get: async (k) => memory.get(k) ?? null, set: async (k, v) => void memory.set(k, v) };
const PROTECTED = ["Maria Sofia Alvarez", "Daniel Alvarez", "47 Linden Row"];

let installed: InstalledAirlock | null = null;
let unsubscribe: (() => void) | null = null;

function start(): InstalledAirlock {
  if (installed) return installed;
  const handle = installAirlock({ localModel: getLocalJsonModel, protectedTerms: PROTECTED, kv });
  unsubscribe = handle.store.onPending((id) => {
    const view = handle.store.get(id);
    // Same decisions the console buttons make. "local-failed" is denied: no keyword substitution in this evaluation.
    if (view?.status === "awaiting-approval") handle.store.approve(id);
    else handle.store.deny(id, "evaluation harness: on-device selection unavailable");
  });
  installed = handle;
  return handle;
}

function stop(): void {
  unsubscribe?.();
  unsubscribe = null;
  installed?.uninstall();
  installed = null;
}

/** Deliberately crude "mask every number" gateway: every run of digits becomes [NUM], whether it is needed or not. */
export const maskEveryNumber = (text: string): string => text.replace(/\d[\d,.]*/g, "[NUM]");

async function ask(parts: string[]): Promise<{ text: string; inferenceSource: string | undefined; ms: number; error?: string }> {
  const t0 = performance.now();
  try {
    const result = await cloudModel.generateContent(parts);
    return { text: result.response.text(), inferenceSource: result.response.inferenceSource, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { text: "", inferenceSource: undefined, ms: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e) };
  }
}

const api = {
  cloudModel: CLOUD_MODEL_NAME,
  documentClauses: splitClauses(SAMPLE_CONTRACT).length,
  documentChars: SAMPLE_CONTRACT.length,
  /** Initialize and warm Nano. Call from a user gesture. */
  async warm(): Promise<string> {
    const h = start();
    await h.analyzer?.warm();
    return "warm";
  },
  async run(arm: Arm, task: string) {
    if (arm === "airlock") start();
    else stop();
    const common = { arm, task };
    if (arm === "withhold") return { ...common, clausesSent: 0, ...(await ask([task])) };
    if (arm === "overmask") return { ...common, clausesSent: api.documentClauses, ...(await ask([task, maskEveryNumber(SAMPLE_CONTRACT)])) };
    if (arm === "baseline") return { ...common, clausesSent: api.documentClauses, ...(await ask([task, SAMPLE_CONTRACT])) };
    const handle = start();
    const before = new Set(handle.store.getSnapshot().map((v) => v.id));
    const answer = await ask([task, SAMPLE_CONTRACT]);
    const view = handle.store.getSnapshot().find((v) => !before.has(v.id));
    return {
      ...common,
      ...answer,
      clausesSent: view?.clauses.filter((c) => c.selected).length ?? 0,
      airlock: view && {
        status: view.status,
        message: view.message,
        localError: view.localError,
        selectionSource: view.selection?.source,
        selectionMs: view.selection?.latencyMs,
        selectionCalls: view.selection?.calls,
        selected: view.clauses.filter((c) => c.selected).map((c) => c.id),
        maskedTotal: view.prepared?.maskedTotal,
        maskedCounts: view.prepared?.maskedCounts,
        withheldClauses: view.prepared?.withheldClauses,
        policyPass: view.policy?.pass,
        bytesSent: view.bytesSent,
        cloudLatencyMs: view.cloudLatencyMs,
        unresolved: view.unresolved,
      },
    };
  },
  stop,
};

(window as unknown as { __evalQ: typeof api }).__evalQ = api;
document.getElementById("status")!.textContent = `harness ready: cloud model ${CLOUD_MODEL_NAME}, document ${api.documentClauses} clauses`;
