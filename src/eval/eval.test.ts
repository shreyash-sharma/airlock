import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { splitClauses } from "../airlock/core/clauses.js";
import { checkPolicy, DEFAULT_MAX_CHARS } from "../airlock/core/policy.js";
import { GUARD_NOTE, keywordSelect, prepare } from "../airlock/core/prepare.js";
import { parseGeminiBody } from "../airlock/core/request.js";
import { Vault } from "../airlock/core/vault.js";
import { SAMPLE_CONTRACT } from "../host/sample-contract.js";
import { ATTACK_STRINGS, BENIGN_STRINGS, CASES, TASK_EXPECTATIONS, type EvalCase } from "./cases.js";

function bodyFor(task: string, doc: string): string {
  return JSON.stringify({ contents: [{ role: "user", parts: [{ text: task }, { text: doc }] }] });
}

function runCase(c: EvalCase) {
  const started = performance.now();
  const parsed = parseGeminiBody(bodyFor(c.task, c.doc));
  if (!parsed.ok) throw new Error(`fixture ${c.id} did not parse`);
  const clauses = splitClauses(parsed.request.document);
  const vault = new Vault();
  const all = { ids: clauses.map((x) => x.id), reasons: {}, source: "deterministic" as const, latencyMs: 0, calls: 0 };
  const p = prepare(parsed.request, clauses, all, vault, { protectedTerms: c.protectedTerms });
  const ms = performance.now() - started;
  const out = p.outboundText.split(GUARD_NOTE).join("").toLowerCase();
  const leaked = c.mustMask.filter((v) => out.includes(v.toLowerCase()));
  const dropped = c.mustKeep.filter((v) => !p.outboundText.includes(v));
  return { c, leaked, dropped, ms, policyPass: p.policy.pass, chars: { before: c.doc.length, after: p.outboundText.length } };
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

describe("evaluation suite (writes docs/EVAL.md)", () => {
  const rows = CASES.map(runCase);

  it("masks everything the detectors are expected to catch and keeps what the task needs", () => {
    const mismatches: string[] = [];
    for (const r of rows) {
      const missed = r.leaked.length + r.dropped.length > 0;
      if (r.c.known && !missed) mismatches.push(`${r.c.id}: marked known but nothing was missed (remove the flag)`);
      if (!r.c.known && missed) mismatches.push(`${r.c.id}: unexpected miss, leaked=${JSON.stringify(r.leaked)} dropped=${JSON.stringify(r.dropped)}`);
    }
    expect(mismatches).toEqual([]);
  });

  // Block correctness: append each attack to a clean approved payload and run the real policy.
  const clean = runCase(CASES[0]);
  const parsed = parseGeminiBody(bodyFor(CASES[0].task, CASES[0].doc));
  if (!parsed.ok) throw new Error("fixture");
  const vault = new Vault();
  const clauses = splitClauses(parsed.request.document);
  const base = prepare(parsed.request, clauses, { ids: clauses.map((x) => x.id), reasons: {}, source: "deterministic", latencyMs: 0, calls: 0 }, vault);
  const policyFor = (extra: string) =>
    checkPolicy({
      text: (base.outboundText + "\n" + extra).split(GUARD_NOTE).join(""),
      vaultOriginals: vault.originals(),
      allowedClauseIds: base.selectedClauses.map((c) => c.id),
      maxChars: DEFAULT_MAX_CHARS,
    });
  const attackResults = ATTACK_STRINGS.map((a) => ({ a, blocked: !policyFor(a).pass }));
  const benignResults = BENIGN_STRINGS.map((b) => ({ b, passed: policyFor(b).pass }));

  it("blocks every injected attack string and lets harmless additions through", () => {
    expect(clean.policyPass).toBe(true);
    expect(attackResults.filter((r) => !r.blocked).map((r) => r.a)).toEqual([]);
    expect(benignResults.filter((r) => !r.passed).map((r) => r.b)).toEqual([]);
  });

  // Minimization baseline (keyword matching, no AI) on the sample contract.
  const sampleClauses = splitClauses(SAMPLE_CONTRACT);
  const minim = TASK_EXPECTATIONS.map((t) => {
    const sel = keywordSelect(t.task, sampleClauses);
    const picked = sampleClauses.filter((c) => sel.ids.includes(c.id));
    const hit = t.needed.filter((n) => picked.some((c) => c.heading.toLowerCase().includes(n)));
    const relevantPicked = picked.filter((c) => t.needed.some((n) => c.heading.toLowerCase().includes(n)));
    const sent = picked.reduce((a, c) => a + c.text.length, 0);
    return {
      task: t.task,
      recall: hit.length / t.needed.length,
      precision: picked.length ? relevantPicked.length / picked.length : 0,
      reduction: 1 - sent / SAMPLE_CONTRACT.length,
      picked: picked.length,
    };
  });

  it("writes the report", () => {
    const strict = rows.filter((r) => !r.c.known);
    const totalMask = rows.reduce((a, r) => a + r.c.mustMask.length, 0);
    const leakedTotal = rows.reduce((a, r) => a + r.leaked.length, 0);
    const totalKeep = rows.reduce((a, r) => a + r.c.mustKeep.length, 0);
    const droppedTotal = rows.reduce((a, r) => a + r.dropped.length, 0);
    const ms = rows.map((r) => r.ms);
    const cats = [...new Set(rows.map((r) => r.c.category))];

    const lines: string[] = [];
    lines.push("# AIRLOCK evaluation report", "");
    lines.push("Generated by `npm run eval` (the test file `src/eval/eval.test.ts`). All data is synthetic. This report covers the deterministic layers (detection, masking, policy). Nano's clause choice is measured separately in a real browser: see `docs/EVAL-NANO.md`.", "");
    lines.push("## Summary", "");
    lines.push("| Metric | Result |", "|---|---|");
    lines.push(`| Cases | ${rows.length} (${strict.length} expected to pass cleanly, ${rows.length - strict.length} documented weaknesses) |`);
    lines.push(`| Leakage rate (protected values still in the outbound text) | ${leakedTotal} of ${totalMask} = ${pct(leakedTotal, totalMask)} overall |`);
    lines.push(`| Leakage excluding documented weaknesses | ${rows.filter((r) => !r.c.known).reduce((a, r) => a + r.leaked.length, 0)} of ${strict.reduce((a, r) => a + r.c.mustMask.length, 0)} |`);
    lines.push(`| Over-redaction (needed values that got masked or dropped) | ${droppedTotal} of ${totalKeep} = ${pct(droppedTotal, totalKeep)} |`);
    lines.push(`| Task-relevant values retained | ${totalKeep - droppedTotal} of ${totalKeep} = ${pct(totalKeep - droppedTotal, totalKeep)} |`);
    lines.push(`| Policy blocks injected attacks | ${attackResults.filter((r) => r.blocked).length} of ${attackResults.length} |`);
    lines.push(`| Policy wrongly blocks harmless additions | ${benignResults.filter((r) => !r.passed).length} of ${benignResults.length} |`);
    lines.push(`| Detection plus masking latency (Node) | median ${quantile(ms, 0.5).toFixed(1)} ms, p95 ${quantile(ms, 0.95).toFixed(1)} ms |`, "");
    lines.push("## By category", "", "| Category | Cases | Protected values | Leaked | Needed values dropped |", "|---|---|---|---|---|");
    for (const cat of cats) {
      const rs = rows.filter((r) => r.c.category === cat);
      lines.push(`| ${cat} | ${rs.length} | ${rs.reduce((a, r) => a + r.c.mustMask.length, 0)} | ${rs.reduce((a, r) => a + r.leaked.length, 0)} | ${rs.reduce((a, r) => a + r.dropped.length, 0)} |`);
    }
    lines.push("", "## Honest failures (documented weaknesses)", "");
    for (const r of rows.filter((x) => x.c.known)) {
      lines.push(`- **${r.c.id}** (${r.c.category}): ${r.leaked.length ? `leaked ${r.leaked.length} value(s)` : ""}${r.dropped.length ? ` dropped ${r.dropped.length} needed value(s)` : ""}. ${r.c.note ?? ""}`);
    }
    lines.push("", "These are the cases where AIRLOCK's rules do not protect a value. They are why the product always shows you the exact outbound text before anything is sent, and why AIRLOCK never claims complete protection.", "");
    lines.push("## Attack blocking", "", "Each string below is appended to an otherwise clean approved payload, and the real policy engine is run.", "", "| Injected text | Blocked |", "|---|---|");
    for (const r of attackResults) lines.push(`| \`${r.a}\` | ${r.blocked ? "yes" : "**NO**"} |`);
    lines.push("", "## Minimization baseline (keyword matching, no AI)", "", "On the sample contract. The on-device model is expected to do better on recall and precision; see the Nano report.", "", "| Task | Clauses kept | Recall of needed clauses | Precision | Text withheld |", "|---|---|---|---|---|");
    for (const m of minim) lines.push(`| ${m.task.slice(0, 60)}… | ${m.picked} of ${sampleClauses.length} | ${pct(m.recall, 1)} | ${pct(m.precision, 1)} | ${pct(m.reduction, 1)} |`);
    lines.push("", "## What this does not show", "", "- Real-world documents are messier than this corpus; the detectors rely on patterns, not understanding.", "- Names and street addresses are only protected when listed or matched by a supported pattern.", "- The corpus was written by the same people who wrote the detectors, so it is optimistic.", "");
    fs.mkdirSync("docs", { recursive: true });
    fs.writeFileSync("docs/EVAL.md", lines.join("\n"));
    expect(fs.existsSync("docs/EVAL.md")).toBe(true);
  });
});
