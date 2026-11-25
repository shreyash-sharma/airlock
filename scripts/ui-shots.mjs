// Screenshots of the console in real Chrome, with a real held request. Needs the dev server and chrome-nano.ps1.
//   CDP_VIEWPORT=1920x1080 node scripts/ui-shots.mjs [tag] [--approve]
// Output: scripts/out/ui/<tag>-*.png. Without --approve the request stays awaiting and is denied at the end.
import { connect } from "./cdp.mjs";

const ORIGIN = "http://127.0.0.1:5173/";
const tag = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : (process.env.CDP_VIEWPORT ?? "default");
const approve = process.argv.includes("--approve");
const out = (n) => `scripts/out/ui/${tag}-${n}.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await connect(ORIGIN);
await page.send("Page.bringToFront");
await page.send("Page.reload");
await sleep(2500);
const text = () => page.evalJs("document.querySelector('[data-testid=\"drawer\"]')?.innerText ?? ''");
async function waitFor(pred, label, ms = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred(await text())) return;
    await sleep(1000);
  }
  throw new Error("timed out: " + label);
}
const go = async (hash) => {
  await page.evalJs(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(500);
};

const avail = () => page.evalJs(`LanguageModel.availability({expectedInputs:[{type:'text',languages:['en']}],expectedOutputs:[{type:'text',languages:['en']}]})`);
console.log("model availability before:", await avail());
await go("#/overview");
await page.screenshot(out("1-overview-empty-docked"));
await page.evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Ask Gemini'))?.click()`);
await waitFor((t) => /Awaiting your approval|Blocked|could not run/.test(t), "awaiting");
console.log("model availability at the gate:", await avail());
if ((await text()).includes("could not run")) {
  // The honest fallback: keyword matching, labelled "no AI". Never presented as on-device.
  console.log("NOTE: on-device model did not run; continuing with the labelled keyword fallback (no AI)");
  await page.screenshot(out("2a-local-failed"));
  await page.evalJs(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Use keyword matching'))?.click()`);
  await waitFor((t) => /Awaiting your approval/.test(t), "awaiting after fallback");
}
await sleep(500);
await page.screenshot(out("2-awaiting-docked"));
await page.evalJs(`document.querySelector('[aria-label="Expand the console"]')?.click()`);
await sleep(600);
const id = await page.evalJs(`(location.hash.match(/traffic\\/([^?]+)/) ?? [])[1] ?? ''`);
await go("#/overview");
await page.screenshot(out("3-overview-awaiting"));
await go("#/traffic");
await page.screenshot(out("4-traffic"));
await go(`#/traffic/${id}`);
await page.screenshot(out("5-traffic-inspector"));
await go(`#/traffic/${id}?view=full`);
await page.screenshot(out("6-request-full"));
await page.evalJs(`document.querySelector('#ac-main')?.scrollTo(0, 900)`);
await sleep(300);
await page.screenshot(out("7-request-full-scrolled"));
await go(`#/traffic/${id}`);
if (approve) {
  await page.evalJs(`document.querySelector('[data-testid="drawer-approve"]')?.click()`);
  await waitFor((t) => /Restored for you|Failed/.test(t), "answer");
  await sleep(500);
  await page.screenshot(out("8-answered"));
  await go("#/overview");
  await page.screenshot(out("9-overview-answered"));
  await go("#/traffic");
  await page.screenshot(out("10-traffic-answered"));
} else {
  await page.evalJs(`document.querySelector('[data-testid="drawer-deny"]')?.click()`);
  await sleep(1500);
}
page.close();
console.log("done", tag);
