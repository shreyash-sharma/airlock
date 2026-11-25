// Guided, narrated tour of AIRLOCK in real Chrome (real Nano, real cloud). Watch the Chrome window.
// Start Chrome with scripts/chrome-nano.ps1 and the dev server with `npm run dev` first.
//   node scripts/tour.mjs            (TOUR_PAUSE=milliseconds per callout, default 7000)
import { connect } from "./cdp.mjs";

const PAUSE = Number(process.env.TOUR_PAUSE ?? 7000);
const page = await connect("http://127.0.0.1:5173/");
await page.send("Page.bringToFront");
await page.send("Page.reload");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => page.evalJs(`document.querySelector('[data-testid="console"]')?.innerText ?? ''`);
const has = (t, s) => t.toLowerCase().includes(s.toLowerCase());
async function waitFor(pred, ms = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await text();
    if (pred(t)) return t;
    await sleep(800);
  }
  return text();
}
const click = (label) =>
  page.evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(label)}))?.click()`);

let shot = 0;
/** Pin a callout at the bottom of the page and outline the element it talks about. */
async function say(kind, title, body, file, targetExpr) {
  await page.evalJs(`(() => {
    document.getElementById('tour-box')?.remove();
    document.querySelectorAll('[data-tour-hl]').forEach(e => { e.style.outline=''; e.style.outlineOffset=''; e.removeAttribute('data-tour-hl'); });
    const target = ${targetExpr || "null"};
    if (target) { target.scrollIntoView({block:'center', behavior:'smooth'}); target.setAttribute('data-tour-hl','1'); target.style.outline='3px solid #E8AE48'; target.style.outlineOffset='4px'; }
    const box = document.createElement('div');
    box.id = 'tour-box';
    box.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99999;width:min(860px,92vw);background:#1C222A;color:#ECE8E1;border:2px solid #E8AE48;border-radius:12px;padding:14px 18px;font:15px/1.5 "IBM Plex Sans",system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6)';
    box.innerHTML = '<div style="font-weight:700;letter-spacing:.08em;font-size:12px;color:#E8AE48;text-transform:uppercase">' + ${JSON.stringify(kind)} + '</div>'
      + '<div style="font-weight:600;font-size:17px;margin:2px 0 4px">' + ${JSON.stringify(title)} + '</div>'
      + '<div>' + ${JSON.stringify(body)} + '</div>'
      + '<div style="margin-top:6px;font:12px \\'IBM Plex Mono\\',monospace;color:#8C939C">' + ${JSON.stringify(file)} + '</div>';
    document.body.appendChild(box);
  })()`);
  await sleep(500);
  await page.screenshot(`scripts/out/tour-${String(++shot).padStart(2, "0")}.png`);
  console.log(`[${shot}] ${kind}: ${title}`);
  await sleep(PAUSE);
}
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const tid = (id) => q(`[data-testid="${id}"]`);
const clickId = (id) => page.evalJs(`document.querySelector('[data-testid="${id}"]')?.click()`);
const drawerText = () => page.evalJs(`document.querySelector('[data-testid="drawer"]')?.innerText ?? ''`);
async function waitDrawer(pred, ms = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const t = await drawerText();
    if (pred(t)) return t;
    await sleep(800);
  }
  return drawerText();
}

await waitFor((t) => t.includes("airlock"), 30000);
// A click is a user gesture: use it to initialize and warm the on-device model while we talk.
await page.evalJs("document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))");

await say("Where: the app", "A normal Firebase AI Logic app", "The left side is an ordinary document assistant. It loads a contract and calls Gemini through the Firebase SDK. It contains no privacy code at all.", "src/host/App.tsx", q('section[aria-label="Document"]'));
await say("Where: the app", "Its only AIRLOCK line", "The app is protected by one call made at startup, before any SDK request: installAirlock({ ... }). It wraps the browser's fetch and XMLHttpRequest with a guard.", "src/main.tsx  ·  src/airlock/index.ts", q('section[aria-label="Task"]'));
await say("What it is", "The AIRLOCK console", "The right side is the AIRLOCK console. The chip says whether Gemini Nano is ready on this device. Nothing has left the device yet.", "src/airlock/ui/console/Console.tsx", tid("console"));
await waitFor((t) => has(t, "On-device AI ready"), 90000);

await page.evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Ask Gemini'))?.click()`);
await say("How it works: step 1", "The real request is caught and held", "The app called the SDK. The SDK made a network request. AIRLOCK's wrapped fetch caught it before it left the browser and is analysing it on this device.", "src/airlock/net/guard.ts", tid("console"));
const gate = await waitDrawer((t) => has(t, "Awaiting your approval") || has(t, "could not run") || has(t, "Blocked"));
if (!has(gate, "Awaiting your approval")) {
  console.log("Gate did not reach approval:\n" + gate.slice(0, 800));
  await say("Stopped", "On-device analysis did not finish", "Nothing was sent. This is the fail-closed path: no local AI means no cloud call.", "src/airlock/ai/local.ts", tid("drawer"));
  page.close();
  process.exit(1);
}
await say("How it works: step 2", "Gemini Nano chooses the clauses (on-device)", "Nano read the task and a clause outline and kept only the clauses the task needs. The rest are marked withheld. This is a proposal: code checks it next.", "src/airlock/ai/local.ts  ·  Firebase AI Logic ONLY_ON_DEVICE + JSON schema", tid("clauses"));
await say("How it works: step 3", "Code masks the private values", "Original on one side, the exact outbound text on the other, with placeholders like [IBAN_1]. Detection and masking are plain code, no AI.", "src/airlock/core/detect.ts  ·  vault.ts  ·  prepare.ts", tid("outbound"));
await say("How it works: step 4", "A deterministic policy checks the payload", "No sensitive value left, no protected original present, only chosen clauses, within the size budget. If any rule fails, the request is blocked and the rule is named.", "src/airlock/core/policy.ts", tid("policy-checks"));
await say("Where the control is", "Nothing leaves until you approve", "Only the exact text on the outbound side will be sent. Deny sends nothing.", "src/airlock/net/store.ts", tid("action-bar"));

await clickId("drawer-approve");
await waitDrawer((t) => has(t, "Restored for you") || has(t, "Failed"));
await say("How it works: step 5", "Only the approved body is sent, and hashed", "The request body was hashed and re-scanned just before sending. The hash is computed locally and matches an independently captured network body in the tests.", "src/airlock/net/ai-minimize.ts (wire hash)", tid("wire-hash"));
await say("How it works: step 6", "The answer comes back restored", "The cloud saw placeholders. AIRLOCK restores your real values locally before the app gets the answer. You can switch between what you see and what the cloud saw.", "src/airlock/core/request.ts  ·  vault.ts", tid("answer"));
await clickId("nav-audit");
await sleep(600);
await say("The proof", "The audit log", "Every step with where it really ran: on-device, cloud or code. It records counts and categories, never the private values themselves. It is kept in memory and ends when the page closes.", "src/airlock/core/audit.ts", tid("audit-list"));
await clickId("nav-traffic");
await sleep(400);

await page.evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Ask Gemini'))?.click()`);
await waitDrawer((t) => has(t, "Awaiting your approval") || has(t, "could not run"));
await say("The attack", "Now simulate a leak", "We are about to add an unauthorized API key to the held payload, as a bug or a poisoned document might. The next click runs the real policy on the modified payload.", "src/airlock/net/ai-minimize.ts", tid("action-bar"));
await page.evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Demo: inject a secret'))?.click()`);
await waitDrawer((t) => has(t, "demo leak stopped"), 30000);
await say("The attack: stopped", "Blocked, with the exact rule named", "The injected key shows in red. The policy failed on rule no-residual-detection and nothing was sent. The app received an error, not an answer.", "src/airlock/core/policy.ts", tid("leak") || tid("policy-checks"));
await say("Summary", "AIRLOCK", "Held at the network layer, chosen on-device, masked and checked by code, approved by you, and shown by a hash and an audit log. Give cloud AI only what it needs; prove what it received.", "README.md", "null");

await page.evalJs("document.getElementById('tour-box')?.remove(); document.querySelectorAll('[data-tour-hl]').forEach(e => { e.style.outline=''; })");
page.close();
console.log("tour finished; screenshots in scripts/out/tour-*.png");
