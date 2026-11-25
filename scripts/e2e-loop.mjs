// End-to-end check of the whole loop in real Chrome: real Nano, real cloud, real network capture.
//   node scripts/e2e-loop.mjs [--deny]
import crypto from "node:crypto";
import { connect } from "./cdp.mjs";

const ORIGIN = "http://127.0.0.1:5173/";
const deny = process.argv.includes("--deny");
const attack = process.argv.includes("--attack");
const SECRETS = ["GB82 WEST", "sk_live_DEMO", "Orc4-Delta", "536-90-4399", "maria.alvarez83", "7700 900482", "Maria Sofia"];
const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const page = await connect(ORIGIN);
const wire = [];
await page.send("Network.enable");
page.on("Network.requestWillBeSent", (p) => {
  if (p.request.url.includes("firebasevertexai.googleapis.com") && p.request.method === "POST") {
    wire.push({ url: p.request.url, body: p.request.postData ?? "" });
  }
});

const has = (t, needle) => t.toLowerCase().includes(needle.toLowerCase());
// The request panel (data-testid=drawer) holds the gate; the whole console only matters for page load.
const text = () => page.evalJs(`document.querySelector('[data-testid="drawer"]')?.innerText ?? ''`);
const consoleText = () => page.evalJs(`document.querySelector('[data-testid="console"]')?.innerText ?? ''`);
async function waitFor(pred, label, ms = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await text();
    if (pred(t)) return t;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timed out waiting for: ${label}\n--- inspector text ---\n${(await text()).slice(0, 1200)}`);
}

await page.send("Page.reload");
for (let i = 0; i < 60 && !(await consoleText()).includes("airlock"); i++) await new Promise((r) => setTimeout(r, 500));
console.log("page loaded; asking…");
const clicked = await page.evalJs(
  `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Ask Gemini'));if(!b)return false;b.click();return true})()`,
);
check("Ask Gemini clicked", clicked === true);

let gate = await waitFor(
  (t) => has(t, "Awaiting your approval") || has(t, "Blocked") || has(t, "could not run"),
  "gate decision point",
);
// --fallback: when this browser's on-device model cannot run, continue through the labelled keyword path
// (no AI). The on-device check below is then skipped, never faked.
const fallback = process.argv.includes("--fallback") && has(gate, "could not run");
if (fallback) {
  console.log("NOTE: on-device model unavailable; using the labelled keyword fallback (no AI)");
  await page.evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Use keyword matching'))?.click()`);
  gate = await waitFor((t) => has(t, "Awaiting your approval"), "gate after keyword fallback");
}
await page.screenshot("scripts/out/e2e-1-awaiting.png");
check("gate reached awaiting approval", has(gate, "Awaiting your approval"), has(gate, "could not run") ? "(local AI failed)" : "");
if (!has(gate, "Awaiting your approval")) {
  console.log(gate.slice(0, 1500));
  process.exit(1);
}
check("nothing sent before approval", wire.length === 0, `wire requests so far: ${wire.length}`);
if (fallback) check("chosen passages are labelled keywords, no AI", /Keywords, no AI\s*\n?\s*Chosen passages/i.test(gate));
else check("chosen passages came from the on-device model", /ON-DEVICE\s*\n?\s*Chosen passages/i.test(gate));

const outbound = await page.evalJs(`document.querySelector('[aria-label="Exact outbound payload"]')?.innerText ?? ''`);
check("outbound pane has no original secrets", SECRETS.every((s) => !outbound.includes(s)), SECRETS.filter((s) => outbound.includes(s)).join(", "));
check("outbound pane shows placeholders", /\[[A-Z_]+_\d+\]/.test(outbound));
console.log("\n--- chosen passages ---");
console.log(await page.evalJs(`document.querySelector('[data-testid="clauses"]')?.innerText ?? ''`));

if (attack) {
  await page.evalJs("[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Demo: inject a secret'))?.click()");
  const blocked = await waitFor((t) => has(t, "demo leak stopped"), "block after injection", 30000);
  await page.screenshot("scripts/out/e2e-attack.png");
  check("attack: gate blocked the injected secret", has(blocked, "demo leak stopped"));
  check("attack: names the failed rule", has(blocked, "no-residual-detection"));
  check("attack: nothing reached the network", wire.length === 0, "wire requests: " + wire.length);
  const pane = await page.evalJs(`document.querySelector('[data-testid="leak"]')?.innerText ?? ''`);
  check("attack: the injected text is shown in the outbound pane", pane.includes("sk_live_DEMO_INJECTED"));
  const hostErr = await page.evalJs("document.querySelector('.h-error')?.innerText ?? ''");
  check("attack: the host app got an error, not an answer", has(hostErr, "AIRLOCK blocked"), hostErr.slice(0, 80));
  page.close();
  const failedAttack = results.filter((r) => !r).length;
  console.log(String(results.length - failedAttack) + "/" + results.length + " checks passed");
  process.exit(failedAttack ? 1 : 0);
}

const decisionLabel = deny ? "Deny, send nothing" : "Approve and send to cloud";
await page.evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(decisionLabel)}))?.click()`);

if (deny) {
  await new Promise((r) => setTimeout(r, 2500));
  check("deny: nothing was sent", wire.length === 0);
  check("deny: audit says denied", has(await text(), "Nothing sent"));
} else {
  const done = await waitFor((t) => has(t, "Restored for you") || has(t, "Failed"), "answer");
  await page.screenshot("scripts/out/e2e-2-answer.png");
  check("cloud answered", has(done, "Restored for you"));
  check("exactly one cloud request", wire.length === 1, `count=${wire.length}`);
  if (wire.length) {
    const sha = crypto.createHash("sha256").update(wire[0].body).digest("hex");
    const shown = await page.evalJs(`document.querySelector('[data-testid="wire-hash"]')?.innerText ?? ''`);
    check("independently captured wire body hash equals the inspector's hash", sha === shown.trim(), `${sha.slice(0, 12)} vs ${shown.trim().slice(0, 12)}`);
    check("captured wire body has no original secrets", SECRETS.every((s) => !wire[0].body.includes(s)), SECRETS.filter((s) => wire[0].body.includes(s)).join(", "));
    check("captured wire body keeps the figures the task needs", wire[0].body.includes("68,000"));
  }
  const hostAnswer = await page.evalJs(`document.querySelector('.h-answer-text')?.innerText ?? ''`);
  check("host app received an answer", hostAnswer.length > 20, `${hostAnswer.length} chars`);
  check("host app answer has no stray placeholders", !/\[[A-Z_]+_\d+\]/.test(hostAnswer));
  console.log("\n--- answer as the app received it (first 600 chars) ---\n" + hostAnswer.slice(0, 600));
}

await page.evalJs(`document.querySelector('[data-testid="nav-audit"]')?.click()`);
await new Promise((r) => setTimeout(r, 500));
const audit = await page.evalJs(`document.querySelector('[data-testid="audit-list"]')?.innerText ?? ''`);
console.log("\n--- audit ---\n" + audit.slice(0, 1500));
page.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
