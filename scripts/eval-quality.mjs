// Answer-quality evaluation (EVAL-03): real cloud Gemini (Firebase AI Logic, same model as the app) answers the same
// synthetic tasks under four arms, and a DETERMINISTIC check (expected facts by normalized regex, no LLM judge) scores them.
//   A baseline : the full document goes to the cloud (what happens with no AIRLOCK)
//   B airlock  : the real pipeline: on-device Gemini Nano picks the passages, policy masks, payload sent, answer restored
//   C1 withhold: gateway control that sends the task and nothing from the document
//   C2 overmask: gateway control that sends the full document with every number replaced by [NUM]
// Drives http://127.0.0.1:5173/eval-quality.html in real Chrome (debug port 9222). One script at a time.
//   node scripts/eval-quality.mjs [--repeats 3] [--max-calls 64] [--resume] [--report-only] [--only baseline,airlock]
import fs from "node:fs";
import { connect } from "./cdp.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : (process.argv[i + 1] ?? true);
};
const REPEATS = Number(arg("repeats", 3));
const MAX_CALLS = Number(arg("max-calls", 64));
const RESUME = process.argv.includes("--resume");
const REPORT_ONLY = process.argv.includes("--report-only");
const ARMS = String(arg("only", "baseline,airlock,overmask,withhold")).split(",");
const JSON_PATH = "scripts/out/eval-quality.json";
const MD_PATH = "docs/EVAL-QUALITY.md";

/** Tasks on the synthetic sample contract, each with expected FACTS the answer must contain (regex on normalized text). */
export const TASKS = [
  {
    id: "noncompete",
    task: "What are the duration and geographic scope of the non-compete, and what does the non-solicitation clause cover?",
    facts: [
      ["twelve months", "(twelve|12)[ -]months?"],
      ["United Kingdom", "united kingdom|\\buk\\b"],
      ["customers", "customer"],
    ],
  },
  {
    id: "termination",
    task: "Summarize what happens to me if the Company ends my employment, including notice, equity and any repayment.",
    facts: [
      ["three months notice", "three months|3 months"],
      ["unvested options lapse", "unvested|lapse|forfeit"],
      ["GBP 6,000 allowance", "6,?000"],
      ["24 months repayment window", "24 months|two years|2 years"],
    ],
  },
  {
    id: "pay",
    task: "How much will I be paid and what bonus can I expect?",
    facts: [
      ["salary 68,000", "68,?000"],
      ["bonus up to 10%", "10 ?%|10 percent|ten percent|ten per cent"],
      ["bonus discretionary", "discretionary|not guaranteed"],
    ],
  },
  {
    id: "contact",
    task: "What job title and personal contact details (email and mobile number) does this contract list for the employee?",
    facts: [
      ["job title", "senior robotics engineer"],
      ["email restored", "maria\\.alvarez83@example\\.com"],
      ["mobile restored", "7700 ?900 ?482"],
    ],
  },
  {
    id: "ip",
    task: "Who owns inventions I create, and is there any limit on that?",
    facts: [
      ["Company owns them", "belong(s)? to the company|owned by the company|company owns|company will own|assigned to the company|company (is the )?owner"],
      ["even if unrelated", "whether or not|even if|unrelated|not related|regardless|outside (of )?(your |the )?(work|working|employment)|working time|no limit|not limited"],
    ],
  },
];

/** Sensitive values in the synthetic contract. A value on the wire is a disclosure, whether or not the task needed it. */
export const SENSITIVE = [
  ["email", "maria.alvarez83@example.com"],
  ["mobile", "7700 900482"],
  ["tax id", "536-90-4399"],
  ["IBAN", "GB82 WEST 1234 5698 7654 32"],
  ["API key", "sk_live_DEMO_0123456789_abcdef"],
  ["VPN password", "Orc4-Delta-77-xray"],
  ["emergency phone", "7700 900713"],
  ["employee name", "Maria Sofia Alvarez"],
  ["emergency contact name", "Daniel Alvarez"],
  ["street address", "47 Linden Row"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const normalize = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[  ]/g, " ")
    .replace(/[‐-―]/g, "-")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ");

export function scoreFacts(task, text) {
  const n = normalize(text);
  const hit = task.facts.filter(([, re]) => new RegExp(re, "i").test(n)).map(([name]) => name);
  return { hit, missed: task.facts.map(([name]) => name).filter((x) => !hit.includes(x)), recall: hit.length / task.facts.length, success: hit.length === task.facts.length };
}

function wireText(body) {
  try {
    const j = JSON.parse(body);
    const out = [];
    (function walk(v) {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    })(j.contents ?? j);
    return out.join("\n");
  } catch {
    return body;
  }
}
const leakedFrom = (text) => SENSITIVE.filter(([, v]) => text.includes(v)).map(([k]) => k);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs) => (xs.length > 1 ? Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2))) : 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "n/a");
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "n/a");

const LABEL = { baseline: "A. Baseline (full document to cloud)", airlock: "B. AIRLOCK (Nano selection, masked, restored)", overmask: "C2. Control: every number masked", withhold: "C1. Control: document withheld" };

function report(data) {
  const runs = data.runs;
  const done = runs.filter((r) => !r.error);
  const arms = ["baseline", "airlock", "overmask", "withhold"].filter((a) => runs.some((r) => r.arm === a));
  const by = (arm) => runs.filter((r) => r.arm === arm);
  const out = [];
  out.push("# Answer-quality evaluation (EVAL-03)", "");
  out.push(`Generated by \`node scripts/eval-quality.mjs\` on ${data.meta.finishedAt?.slice(0, 10) ?? "n/a"}. Raw per-run data: \`scripts/out/eval-quality.json\` (not committed; regenerate with the command).`, "");
  out.push("## What was measured", "");
  out.push(
    `The same ${TASKS.length} tasks on the synthetic sample contract (${data.meta.documentClauses} clauses, ${data.meta.documentChars} characters, all values invented) were answered by real cloud Gemini (\`${data.meta.cloudModel}\` through Firebase AI Logic, free tier, the model the app uses) under four arms, ${data.meta.repeats} repeats per task and arm.`,
  );
  out.push("", "| Arm | What leaves the machine |", "|---|---|");
  out.push("| A. Baseline | The full document and the task, unprotected. This is the no-AIRLOCK control. |");
  out.push("| B. AIRLOCK | The real pipeline: on-device Gemini Nano (`ONLY_ON_DEVICE`) picks the passages the task needs, deterministic policy masks sensitive values, the payload is approved, sent, and the answer is restored. The harness plays the approver through the same store call the Approve button makes. |");
  out.push("| C1. Withhold | A gateway that sends the task and nothing from the document. A metric that rewarded this would be broken. |");
  out.push("| C2. Over-mask | A gateway that sends the full document with every number replaced by `[NUM]`. Safe-looking, but it destroys the facts the tasks need. |", "");
  out.push(
    "Scoring is deterministic: each task lists expected facts as normalized (lowercased, markdown stripped, whitespace collapsed) regular expressions, checked against the answer **after** AIRLOCK restores placeholders. There is no LLM judge. A run succeeds only if **every** expected fact is present; fact recall is the share present. The expected facts are listed in `scripts/eval-quality.mjs`.",
    "",
  );
  if (data.meta.erroredRunsRedone) out.push(`The first attempt hit a Firebase AI Logic cloud outage (HTTP 500 "high demand", which also persisted through retries); ${data.meta.erroredRunsRedone} failed runs were redone after the cloud recovered, and their wasted calls are included in the call count below.`, "");
  for (const n of data.meta.notes ?? []) out.push(n, "");
  out.push(`Environment: ${data.meta.chrome ?? "Chrome"}, on-device model Gemini Nano via the Prompt API, ${data.meta.cloudCalls} cloud generateContent calls counted on the wire (CDP Network log; this includes calls that failed with HTTP 500 and were redone), budget ${data.meta.maxCalls}${data.meta.manualProbeCalls ? `, plus ${data.meta.manualProbeCalls} manual diagnostic calls made outside the harness count` : ""}.`, "");
  if (data.meta.partial) out.push(`> **PARTIAL RUN.** ${data.meta.partial}`, "");

  out.push("## Task success", "", "| Arm | Runs | Task success (all facts) | Mean fact recall (sd) | Per-task success range |", "|---|---|---|---|---|");
  for (const a of arms) {
    const rs = by(a).filter((r) => !r.error);
    const ok = rs.filter((r) => r.score.success).length;
    const perTask = TASKS.map((t) => {
      const x = rs.filter((r) => r.taskId === t.id);
      return x.length ? x.filter((r) => r.score.success).length / x.length : NaN;
    }).filter(Number.isFinite);
    const failed = by(a).length - rs.length;
    out.push(
      `| ${LABEL[a]} | ${rs.length}${failed ? ` (+${failed} errored)` : ""} | ${ok} of ${rs.length} (${pct(ok / rs.length)}) | ${pct(mean(rs.map((r) => r.score.recall)))} (${pct(sd(rs.map((r) => r.score.recall)))}) | ${perTask.length ? `${pct(Math.min(...perTask))} to ${pct(Math.max(...perTask))}` : "n/a"} |`,
    );
  }
  out.push("", "### Per task", "", `| Task | ${arms.map((a) => LABEL[a].split(".")[0]).join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`);
  for (const t of TASKS) {
    const cells = arms.map((a) => {
      const x = by(a).filter((r) => r.taskId === t.id && !r.error);
      return x.length ? `${x.filter((r) => r.score.success).length}/${x.length} (recall ${pct(mean(x.map((r) => r.score.recall)))})` : "not run";
    });
    out.push(`| ${t.id}: ${t.task.slice(0, 60)}${t.task.length > 60 ? "..." : ""} | ${cells.join(" | ")} |`);
  }

  out.push("", "## Disclosure", "", "| Arm | Clauses sent (mean of " + data.meta.documentClauses + ") | Wire body bytes (mean) | Bytes vs baseline | Sensitive values on the wire (mean of " + SENSITIVE.length + ") | Runs with at least one leak |", "|---|---|---|---|---|---|");
  const baseBytes = mean(by("baseline").filter((r) => !r.error && r.wire).map((r) => r.wire.bytes));
  for (const a of arms) {
    const rs = by(a).filter((r) => !r.error && r.wire);
    const b = mean(rs.map((r) => r.wire.bytes));
    const leaks = rs.map((r) => r.wire.leaked.length);
    out.push(
      `| ${LABEL[a]} | ${f1(mean(rs.map((r) => r.clausesSent)))} | ${Math.round(b)} | ${Number.isFinite(baseBytes) && a !== "baseline" ? (b <= baseBytes ? `${pct(1 - b / baseBytes)} smaller` : `${pct(b / baseBytes - 1)} larger`) : "reference"} | ${f1(mean(leaks))} | ${leaks.filter((n) => n > 0).length} of ${rs.length} |`,
    );
  }
  const leaky = runs.filter((r) => r.arm === "airlock" && r.wire?.leaked.length);
  out.push("", `Values leaked by arm B, reported as observed: ${leaky.length ? leaky.map((r) => `${r.taskId} rep ${r.rep}: ${r.wire.leaked.join(", ")}`).join("; ") : "none in the runs that completed"}. The sensitive list is: ${SENSITIVE.map(([k]) => k).join(", ")}. Names and the street address are masked only because the demo lists them under Always protect; without that, AIRLOCK has no name recogniser (see \`docs/EVAL.md\`).`);
  const maskedAir = by("airlock").filter((r) => r.airlock?.maskedTotal !== undefined).map((r) => r.airlock.maskedTotal);
  if (maskedAir.length) out.push("", `Arm B masked a mean of ${f1(mean(maskedAir))} values per request (range ${Math.min(...maskedAir)} to ${Math.max(...maskedAir)}).`);

  out.push("", "## Inference source and latency", "", "| Arm | Cloud answers by SDK inferenceSource | Cloud answer latency, ms (median / max) | On-device selection |", "|---|---|---|---|");
  for (const a of arms) {
    const rs = by(a).filter((r) => !r.error);
    const src = {};
    rs.forEach((r) => (src[r.inferenceSource ?? "none"] = (src[r.inferenceSource ?? "none"] ?? 0) + 1));
    const sel = rs.filter((r) => r.airlock?.selectionSource);
    out.push(
      `| ${LABEL[a]} | ${Object.entries(src).map(([k, v]) => `${k} x${v}`).join(", ") || "n/a"} | ${rs.length ? `${median(rs.map((r) => r.ms))} / ${Math.max(...rs.map((r) => r.ms))}` : "n/a"} | ${sel.length ? `${[...new Set(sel.map((r) => r.airlock.selectionSource))].join(", ")} x${sel.length}, median ${median(sel.map((r) => r.airlock.selectionMs))} ms, ${sel.reduce((s, r) => s + (r.airlock.selectionCalls ?? 0), 0)} Nano calls` : "n/a"} |`,
    );
  }
  out.push("", "Latency for arm B is the end-to-end time the app saw (on-device selection, masking, approval, cloud call, restore).");

  out.push("", "### What Nano chose, per task", "", "| Task | Clauses sent per repeat (ids chosen) | Values masked per repeat |", "|---|---|---|");
  for (const t of TASKS) {
    const B = by("airlock").filter((r) => r.taskId === t.id && !r.error);
    out.push(`| ${t.id} | ${B.map((r) => (r.airlock?.selected ?? []).join("+") || "none").join(" ; ") || "not run"} | ${B.map((r) => r.airlock?.maskedTotal ?? "?").join(", ") || "-"} |`);
  }
  out.push("", "## Where AIRLOCK answered worse than the baseline", "");
  const worse = [];
  for (const t of TASKS) {
    const A = by("baseline").filter((r) => r.taskId === t.id && !r.error);
    const B = by("airlock").filter((r) => r.taskId === t.id && !r.error);
    if (!A.length || !B.length) continue;
    const ra = mean(A.map((r) => r.score.recall));
    const rb = mean(B.map((r) => r.score.recall));
    const missed = [...new Set(B.flatMap((r) => r.score.missed))];
    if (rb < ra || B.some((r) => !r.score.success)) {
      const sel = B.map((r) => `${r.clausesSent} clauses`).join(", ");
      worse.push(`- **${t.id}**: baseline recall ${pct(ra)}, AIRLOCK ${pct(rb)}; AIRLOCK success ${B.filter((r) => r.score.success).length}/${B.length} (${sel}). Missed in at least one AIRLOCK run: ${missed.join(", ") || "none"}.${B.some((r) => r.airlock?.selected) ? ` Passages chosen: ${B.map((r) => (r.airlock?.selected ?? []).join("+") || "none").join(" | ")}.` : ""}`);
    }
  }
  out.push(worse.length ? worse.join("\n") : "No task where AIRLOCK scored below the baseline in the runs that completed.");

  const errs = runs.filter((r) => r.error);
  out.push("", "## Not run, errors and limits", "");
  if (errs.length) for (const r of errs) out.push(`- ${r.arm} / ${r.taskId} / rep ${r.rep}: ${String(r.error).slice(0, 200)}`);
  const missing = [];
  for (const a of ["baseline", "airlock", "overmask", "withhold"]) for (const t of TASKS) for (let k = 1; k <= data.meta.repeats; k++) if (!runs.some((r) => r.arm === a && r.taskId === t.id && r.rep === k && !r.error)) missing.push(`${a}/${t.id}/${k}`);
  out.push(missing.length ? `- Planned but not run (${missing.length}): ${missing.join(", ")}.` : "- Every planned (arm, task, repeat) combination ran.");
  out.push(
    `- ${TASKS.length} tasks on one synthetic document is a small sample: the numbers show direction and mechanism, not a benchmark. Fact checks reward the facts listed, not the quality of advice.`,
    "- Cloud answers and Nano are not deterministic; the spread across repeats is shown above.",
    "- The harness approves requests itself (the human approval step is a UI action that is not measured here). A local-model failure would have been denied, never replaced by keyword selection.",
    "- Arm B uses the same demo settings as the app (protected terms: the employee name, the emergency contact name and the street address).",
    "",
  );
  fs.mkdirSync("docs", { recursive: true });
  fs.writeFileSync(MD_PATH, out.join("\n"));
  console.log(`wrote ${MD_PATH}`);
}

const save = (data) => fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 1));

if (REPORT_ONLY) {
  report(JSON.parse(fs.readFileSync(JSON_PATH, "utf8")));
  process.exit(0);
}

fs.mkdirSync("scripts/out", { recursive: true });
const data = RESUME && fs.existsSync(JSON_PATH) ? JSON.parse(fs.readFileSync(JSON_PATH, "utf8")) : { meta: { repeats: REPEATS, maxCalls: MAX_CALLS, cloudCalls: 0 }, runs: [] };
if (RESUME) {
  // Runs that ended in a cloud error are redone; they are counted, not hidden.
  const dropped = data.runs.filter((r) => r.error);
  data.runs = data.runs.filter((r) => !r.error);
  data.meta.erroredRunsRedone = (data.meta.erroredRunsRedone ?? 0) + dropped.length;
}
data.meta.repeats = REPEATS;
data.meta.maxCalls = MAX_CALLS;

const page = await connect("http://127.0.0.1:5173/eval-quality.html");
await page.send("Page.bringToFront");
await page.send("Network.enable");
let wire = [];
page.on("Network.requestWillBeSent", (p) => {
  if (p.request.method === "POST" && p.request.url.includes("googleapis.com") && p.request.url.includes("generateContent")) {
    wire.push({ requestId: p.requestId, url: p.request.url, body: p.request.postData, has: p.request.hasPostData });
  }
});
await page.send("Page.reload");
for (let i = 0; i < 60; i++) {
  if (await page.evalJs("typeof window.__evalQ === 'object'")) break;
  await sleep(500);
}
const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
data.meta.chrome = ver.Browser;
data.meta.cloudModel = await page.evalJs("window.__evalQ.cloudModel");
data.meta.documentClauses = await page.evalJs("window.__evalQ.documentClauses");
data.meta.documentChars = await page.evalJs("window.__evalQ.documentChars");
data.meta.startedAt ??= new Date().toISOString();

if (ARMS.includes("airlock")) {
  console.log("warming on-device model...");
  try {
    await page.evalJs("window.__evalQ.warm()");
  } catch (e) {
    console.log(`WARNING: on-device warm-up failed: ${e.message}. AIRLOCK runs will report the real failure; nothing is substituted.`);
  }
}

const isRate = (m) => /429|quota|rate.?limit|RESOURCE_EXHAUSTED|too many/i.test(m ?? "");
const isTransient = (m) => isRate(m) || /\[(500|502|503|504)|high demand|overloaded|temporarily/i.test(m ?? "");
let consecutiveErrors = 0;
let stop = null;
const sentCalls = () => data.meta.cloudCalls;
outer: for (let rep = 1; rep <= REPEATS; rep++) {
  for (const t of TASKS) {
    for (const arm of ["baseline", "airlock", "overmask", "withhold"]) {
      if (!ARMS.includes(arm)) continue;
      if (data.runs.some((r) => r.arm === arm && r.taskId === t.id && r.rep === rep && !r.error)) continue;
      if (sentCalls() >= MAX_CALLS) {
        stop = `Stopped at the cloud-call budget (${MAX_CALLS}).`;
        break outer;
      }
      let attempt = 0;
      let res;
      for (;;) {
        wire = [];
        const t0 = Date.now();
        res = await page.evalJs(`window.__evalQ.run(${JSON.stringify(arm)}, ${JSON.stringify(t.task)})`);
        await sleep(300);
        const calls = wire.length;
        data.meta.cloudCalls += calls;
        const w = wire[wire.length - 1];
        let body = w?.body;
        if (w && body === undefined && w.has) body = (await page.send("Network.getRequestPostData", { requestId: w.requestId })).postData;
        res.wire = body !== undefined ? { bytes: new TextEncoder().encode(body).length, leaked: leakedFrom(wireText(body)), calls } : calls === 0 ? { bytes: 0, leaked: [], calls: 0 } : undefined;
        res.wallMs = Date.now() - t0;
        if (res.error && isTransient(res.error) && attempt < 1 && sentCalls() < MAX_CALLS + 6) {
          attempt++;
          console.log(`transient cloud error (${res.error.slice(60, 150)}); waiting 30 s and retrying (${attempt}/1)`);
          await sleep(30000);
          continue;
        }
        break;
      }
      res.taskId = t.id;
      res.rep = rep;
      res.score = res.error ? undefined : scoreFacts(t, res.text);
      if (res.score) res.unresolvedPlaceholders = (res.text.match(/\[[A-Z_]+_\d+\]/g) ?? []).length;
      data.runs.push(res);
      save(data);
      console.log(
        `${res.error ? "ERR " : res.score.success ? "ok  " : "miss"} rep ${rep} ${arm.padEnd(8)} ${t.id.padEnd(11)} ${res.error ? res.error.slice(0, 90) : `recall ${pct(res.score.recall)} src ${res.inferenceSource} ${res.ms} ms clauses ${res.clausesSent} wire ${res.wire?.bytes}B leaked [${res.wire?.leaked.join(",")}]${res.score.missed.length ? " missed: " + res.score.missed.join("; ") : ""}`}`,
      );
      consecutiveErrors = res.error ? consecutiveErrors + 1 : 0;
      if (res.error && isRate(res.error)) {
        stop = `Rate limited by the free tier at ${arm}/${t.id}/rep ${rep} (after one retry). Remaining combinations were not run.`;
        break outer;
      }
      if (consecutiveErrors >= 3) {
        stop = `Three consecutive cloud errors (last at ${arm}/${t.id}/rep ${rep}: ${String(res.error).slice(0, 120)}). Remaining combinations were not run.`;
        break outer;
      }
      await sleep(3500);
    }
  }
}
await page.evalJs("window.__evalQ.stop()");
page.close();
data.meta.finishedAt = new Date().toISOString();
if (stop) data.meta.partial = stop;
else delete data.meta.partial;
save(data);
report(data);
console.log(stop ?? "complete", `cloud calls: ${data.meta.cloudCalls}`);
