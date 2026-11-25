// Screenshots of the Part B console pages and the CRM workspace in real Chrome. Needs the dev server and chrome-nano.ps1.
//   CDP_VIEWPORT=1920x1080 node scripts/ui-shots-b.mjs [tag]
// Output: scripts/out/ui/<tag>-b-*.png. Uses only the app's own pages; nothing here calls the cloud or the on-device model.
import { connect } from "./cdp.mjs";

const ORIGIN = "http://127.0.0.1:5173/";
const tag = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : (process.env.CDP_VIEWPORT ?? "default");
const out = (n) => `scripts/out/ui/${tag}-b-${n}.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await connect(ORIGIN);
await page.send("Page.enable");
await page.send("Page.bringToFront");
const open = async (url) => {
  await page.send("Page.navigate", { url });
  await page.send("Page.bringToFront");
  for (let i = 0; i < 40; i++) {
    if (await page.evalJs("document.readyState === 'complete' && !!document.querySelector('[data-testid=console]')").catch(() => false)) break;
    await sleep(500);
  }
  await sleep(700);
};
const go = async (hash) => {
  await page.evalJs(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(600);
};
const expand = () => page.evalJs(`document.querySelector('[aria-label="Expand the console"]')?.click()`);

await open(ORIGIN);
await go("#/profiles");
await page.screenshot(out("1-profiles-docked"));
await expand();
await sleep(500);
await page.screenshot(out("2-profiles"));
await go("#/profiles/gemini-generate-content");
await page.screenshot(out("3-profile-builtin"));
await go("#/profiles/generic-json");
await page.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Duplicate as my profile'))?.click()`);
await sleep(900);
await page.screenshot(out("4-profile-duplicated-editor"));
await page.evalJs(`(() => { const i = document.querySelector('input[aria-label="Hosts"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'not a host!'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(400);
await page.screenshot(out("5-profile-invalid-edit"));
await page.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Delete')?.click()`);
await sleep(500);
await page.screenshot(out("6-profile-delete-dialog"));
await page.evalJs(`document.querySelector('[data-testid=confirm-dialog-ok]')?.click()`);
await sleep(700);
await go("#/policies");
await page.screenshot(out("7-policies"));
await page.evalJs(`document.querySelector('#ac-main')?.scrollTo(0, 500)`);
await sleep(300);
await page.screenshot(out("8-policies-scrolled"));
await go("#/inspection");
await page.screenshot(out("9-inspection-empty"));
await go("#/audit");
await page.screenshot(out("10-audit"));
await page.evalJs(`document.querySelector('[data-testid=audit-export]')?.click()`);
await sleep(900);
await page.screenshot(out("11-audit-export"));
await page.evalJs(`document.querySelector('dialog[open]')?.close()`);

// The CRM workspace: create two sample customers through the console, then screenshot.
await open(`${ORIGIN}crm-test.html`);
await fetch(`${ORIGIN}mock-crm/api/_reset`, { method: 'POST' });
await open(`${ORIGIN}crm-test.html`);
await page.screenshot(out("12-crm-empty"));
for (let i = 0; i < 2; i++) {
  await page.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Fill a sample customer'))?.click()`);
  await sleep(200);
  await page.evalJs(`document.querySelector('[data-testid=crm-create]')?.click()`);
  await sleep(1500);
}
await page.screenshot(out("13-crm-contacts"));
await go("#/traffic");
await page.screenshot(out("14-crm-traffic"));
await go("#/audit");
await page.screenshot(out("15-audit-events"));
await page.evalJs(`document.querySelector('[data-testid=audit-export]')?.click()`);
await sleep(900);
await page.screenshot(out("16-audit-export-events"));
await page.evalJs(`document.querySelector('dialog[open]')?.close()`);
await expand();
await sleep(400);
await page.screenshot(out("17-crm-expanded-audit"));

// Inspection: hold a request, classify (labelled detector-only when no on-device AI) and author (real cloud fallback).
await open(`${ORIGIN}crm-test.html?mode=inspect`);
await page.evalJs(`['airlock.profiles.v1','airlock.vault.v1','airlock.tokenkey.v1'].forEach(k => localStorage.removeItem(k))`);
await open(`${ORIGIN}crm-test.html?mode=inspect`);
await page.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Create via fetch'))?.click()`);
await sleep(1500);
await page.screenshot(out("18-inspection-held"));
await page.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Classify on-device'))?.click()`);
for (let i = 0; i < 60 && !/Proposed on-device|Detector-only/i.test(await page.evalJs("document.querySelector('#ac-main')?.innerText ?? ''")); i++) await sleep(1000);
await page.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Author profile'))?.click()`);
for (let i = 0; i < 90 && !/Authored by|Not valid/i.test(await page.evalJs("document.querySelector('#ac-main')?.innerText ?? ''")); i++) await sleep(1000);
await sleep(800);
await page.screenshot(out("19-inspection-authored"));
await page.evalJs(`document.querySelector('#ac-main')?.scrollTo(0, 1400)`);
await sleep(300);
await page.screenshot(out("20-inspection-review"));
await page.evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Discard capture'))?.click()`);
await sleep(600);
await fetch(`${ORIGIN}mock-crm/api/_reset`, { method: 'POST' });
await go("#/overview");
page.close();
console.log("done", tag);
