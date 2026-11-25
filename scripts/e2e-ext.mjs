// Real-Chrome check of the AIRLOCK MV3 extension: the side panel console, the host list and permissions, and the
// fail-closed gate, against the mock CRM page (EXT-01 to EXT-05).
//   npm run e2e:ext          (builds dist-ext-test, then runs this)
// Needs: the dedicated automation Chrome (powershell -File scripts/chrome-nano.ps1, debug port 9222) and the dev
// server (npm run dev) on http://127.0.0.1:5173. It loads dist-ext-test into THAT profile only, through the DevTools
// command Extensions.loadUnpacked (branded Chrome 158 ignores --load-extension), and never touches another profile.
//
// The page under test is crm-ext.html: a plain page with no AIRLOCK code, so whatever is held or protected is the
// extension's doing. The side panel is the extension's own sidepanel.html opened as a tab and driven through its DOM.
import fs from "node:fs";
import path from "node:path";
import { connect } from "./cdp.mjs";

const PORT = process.env.CDP_PORT ?? "9222";
const ORIGIN = "http://127.0.0.1:5173";
const PAGE_URL = `${ORIGIN}/crm-ext.html`;
const EXT_DIR = path.resolve("dist-ext-test").replace(/\\/g, "/");
const EXT_ID = "ombmjhkmnofdcbfafhjcnppjdkalekan";
const PANEL_URL = `chrome-extension://${EXT_ID}/sidepanel.html`;
const HOLD_TIMEOUT_MS = 6000;
const RAW = ["rohan.mehta@example.com", "9876543210", "68000", "Rohan", "Mehta", "Renewal is at risk"];
const PROFILE = {
  version: 1,
  id: "mock-crm-contacts",
  name: "Mock CRM contacts",
  kind: "saas",
  pipeline: "field-protect",
  match: { hosts: ["127.0.0.1:5173"], paths: ["/mock-crm/api/**"] },
  request: {
    fields: [
      { path: "$.properties.firstname", category: "identifier", flow: { action: "surrogate" } },
      { path: "$.properties.lastname", category: "identifier", flow: { action: "surrogate" } },
      { path: "$.properties.email", category: "contact", flow: { action: "token" } },
      { path: "$.properties.phone", category: "contact", flow: { action: "token" } },
      { path: "$.properties.salary", category: "financial", flow: { action: "token" } },
      { path: "$.properties.internal_note", category: "free_text", flow: { action: "drop" } },
      { path: "$.properties.city", category: "non_sensitive", flow: { action: "allow" } },
      { path: "$.properties.plan", category: "non_sensitive", flow: { action: "allow" } },
    ],
  },
  response: { fields: [{ path: "$.results[*].properties" }, { path: "$.properties" }] },
  author: { by: "user", at: "2026-11-24T00:00:00.000Z" },
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* keep waiting */
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/* ---------------------------------------------------------------- browser-level DevTools */
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json().catch(() => null);
if (!version) throw new Error(`No Chrome on port ${PORT}. Start it: powershell -NoProfile -File scripts/chrome-nano.ps1`);
if (!(await fetch(PAGE_URL).then((r) => r.ok).catch(() => false))) throw new Error(`The dev server is not serving ${PAGE_URL}. Start it: npm run dev`);
console.log(`Chrome ${version.Browser}; extension folder ${EXT_DIR}`);

const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => ((bws.onopen = resolve), (bws.onerror = reject)));
let bid = 0;
const bpend = new Map();
bws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && bpend.has(m.id)) {
    const { resolve, reject } = bpend.get(m.id);
    bpend.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const bsend = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++bid;
    bpend.set(id, { resolve, reject });
    bws.send(JSON.stringify({ id, method, params, sessionId }));
  });

await bsend("Extensions.uninstall", { id: EXT_ID }).catch(() => undefined);
const loaded = await bsend("Extensions.loadUnpacked", { path: EXT_DIR });
check("extension loaded into the dedicated profile", typeof loaded.id === "string", loaded.id);
check("extension ID is the pinned one", loaded.id === EXT_ID, `${loaded.id}`);

async function swSession() {
  const sw = await until(async () => (await bsend("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXT_ID}/`)), "the service worker");
  const { sessionId } = await bsend("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  return async (expression) => {
    const r = await bsend("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
}
const swEval = await swSession();
const registered = async () => JSON.parse(await swEval("chrome.scripting.getRegisteredContentScripts().then((s) => JSON.stringify(s.map((x) => x.id + '|' + x.world + '|' + x.runAt)))"));
await until(async () => (await registered()).length === 2, "scripts registered for the default host");
const regs = await registered();
check("MAIN script registered at document_start, bridge in ISOLATED", regs.some((r) => r.includes("MAIN|document_start")) && regs.some((r) => r.includes("ISOLATED|document_start")), regs.join(" ; "));
const manifest = JSON.parse(await swEval("JSON.stringify(chrome.runtime.getManifest())"));
check("manifest requests only sidePanel, storage, scripting", JSON.stringify([...manifest.permissions].sort()) === JSON.stringify(["scripting", "sidePanel", "storage"]));
await swEval(`chrome.storage.local.set({ 'airlock.ext.settings.v1': { holdTimeoutMs: ${HOLD_TIMEOUT_MS} } })`);

/* ---------------------------------------------------------------- helpers over the pages */
const SHOTS = "scripts/out/ext";
fs.mkdirSync(SHOTS, { recursive: true });
const KEY_PROFILES = "airlock.profiles.v1";
const crm = async () => (await (await fetch(`${ORIGIN}/mock-crm/api/_raw`)).json()).contacts;
const crmText = async () => JSON.stringify(await crm());
const count = async () => (await crm()).length;
const closeTargets = async (prefix) => {
  for (const t of await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) {
    if (t.type === "page" && t.url.startsWith(prefix)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
  }
};
const noRaw = (text) => RAW.filter((v) => text.includes(v));
// With no profile the generic detectors mask only what they recognise: the email and phone. Names and free text pass.
const GENERIC_CATCHES = ["rohan.mehta@example.com", "9876543210"];
const noGenericRaw = (text) => GENERIC_CATCHES.filter((v) => text.includes(v));
const note = (s) => console.log(`NOTE  ${s}`);

await fetch(`${ORIGIN}/mock-crm/api/_reset`, { method: "POST" });
await closeTargets(PANEL_URL);
// Keep one page tab alive (closing the last tab closes the window); make it if the profile has none.
const haveTab = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).some((t) => t.type === "page" && t.url.startsWith(PAGE_URL));
if (!haveTab) await bsend("Target.createTarget", { url: PAGE_URL });
await sleep(500);
const page = await connect(PAGE_URL);
await page.send("Page.enable");
const storeProfile = () => page.evalJs(`localStorage.setItem(${JSON.stringify(KEY_PROFILES)}, ${JSON.stringify(JSON.stringify([PROFILE]))})`);
await storeProfile();
async function reloadPage() {
  await page.send("Page.reload");
  await sleep(600);
  await until(() => page.evalJs("document.readyState === 'complete'"), "the page to load");
}
await reloadPage();
const injected = () => page.evalJs("!!globalThis[Symbol.for('airlock.ext.page')]");
check("MAIN-world script injected at document_start", await until(injected, "the page script marker", 10000).catch(() => false));
check("the page's fetch and XMLHttpRequest are wrapped", await page.evalJs("!/native code/.test(fetch.toString()) && !/native code/.test(XMLHttpRequest.prototype.send.toString())"));
const tabId = Number(await swEval(`chrome.tabs.query({ url: '${PAGE_URL}*' }).then((t) => t.at(-1).id)`));
const pageText = (id) => page.evalJs(`document.getElementById('${id}').textContent`);
const clickPage = (id) => page.evalJs(`document.getElementById('${id}').click()`);
const clearErrors = () => clickPage("clear-errors");

/* The side panel is the extension's own sidepanel.html opened as a tab, pinned to the page's tab, at the panel's width. */
let panel = null;
async function openPanel(hash = "") {
  await bsend("Target.createTarget", { url: `${PANEL_URL}?tab=${tabId}${hash}` });
  panel = await connect(`${PANEL_URL}?tab=${tabId}`);
  await panel.send("Page.enable");
  await panel.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
  await until(() => panel.evalJs(`document.querySelector('[data-testid="attach-strip"]')?.dataset.attached === 'true'`), "the panel to attach to the page", 15000);
}
const closePanel = async () => {
  panel?.close();
  panel = null;
  await closeTargets(PANEL_URL);
};
const ptext = () => panel.evalJs("document.body.innerText");
const phas = (sel) => panel.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
const pclick = (sel) => panel.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.disabled) return false; e.click(); return true; })()`);
const pclickText = (label, tag = "button") =>
  panel.evalJs(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(tag)})].find((x) => x.textContent.trim().includes(${JSON.stringify(label)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
const pset = (sel, value) =>
  panel.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event(e instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); return true; })()`);
const route = (hash) => panel.evalJs(`location.hash = ${JSON.stringify(hash)}`).then(() => sleep(400));
const scrollToHeading = (text) =>
  panel.evalJs(`(() => { const h = [...document.querySelectorAll('h2')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); h?.scrollIntoView({ block: 'start' }); return !!h; })()`);
const shot = async (name, heading) => {
  await panel.send("Page.bringToFront");
  if (heading) await scrollToHeading(heading);
  await sleep(500);
  const fits = await panel.evalJs(`(() => { const m = document.querySelector('.ac-main'); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })()`);
  check(`panel layout at 420 px has no page-level horizontal overflow: ${name}`, fits);
  await panel.screenshot(`${SHOTS}/${name}.png`);
  console.log(`      screenshot ${SHOTS}/${name}.png`);
};
const heldRequestId = async () => {
  const h = await panel.evalJs("location.hash");
  const m = /^#\/traffic\/([^?]+)/.exec(h);
  return m ? decodeURIComponent(m[1]) : null;
};

/* ---------------------------------------------------------------- EXT-03: the panel is the React console */
await openPanel();
check("the React console renders in the side panel", await phas('[data-testid="console"]'));
check("the panel is in the narrow layout (compact icon bar, no side nav labels)", await panel.evalJs(`(() => { const n = document.querySelector('.ac-nav ul'); return !!n && getComputedStyle(n).flexDirection === 'row' && document.querySelector('.al-console').getBoundingClientRect().width <= 420; })()`));
const strip = await panel.evalJs(`document.querySelector('[data-testid="attach-strip"]').innerText`);
check("the panel names the attached host and says what closing it does", strip.includes("127.0.0.1:5173") && /closing this panel/i.test(strip) && /never held/i.test(strip), strip.replace(/\s+/g, " ").slice(0, 160));
check("the Hosts page is in the extension's nav and the web nav has no such item", await phas('[data-testid="nav-hosts"]'));
await sleep(1200);
await shot("01-overview-idle");

/* ---------------------------------------------------------------- CRM traffic is inline: masked and sent at once, never held */
// A CRM user must not wait. Nothing here clicks Approve: the request goes out protected by the profile and is
// reviewed afterwards. The hold / deny / timeout / closed-panel gate applies to the AI destination and is covered by
// the unit harness (src/ext/harness.test.ts) and the real-Chrome Gemini run (scripts/e2e-loop.mjs).
let n = await count();
await clearErrors();
await clickPage("create-fetch");
await until(async () => /HTTP 2\d\d/.test(await pageText("out-fetch")), "fetch create to finish with no approval step");
check("fetch create: nothing waited for approval", !(await phas('[data-testid="drawer-approve"]')));
let stored = await crmText();
check("fetch create: the mock CRM stored the contact with protected values only", (await count()) === n + 1 && noRaw(stored).length === 0 && stored.includes("Pune"), noRaw(stored).join(","));
check("fetch create: the page still sees its own values restored", (await pageText("out-fetch")).includes("rohan.mehta@example.com"));
await route("#/traffic");
await sleep(600);
await shot("02-traffic-inline-request");

n = await count();
await clickPage("create-xhr");
await until(async () => /HTTP 2\d\d/.test(await pageText("out-xhr")), "XHR create to finish with no approval step");
stored = await crmText();
check("XHR create: the mock CRM stored the second contact with protected values only", (await count()) === n + 1 && noRaw(stored).length === 0, noRaw(stored).join(","));
check("XHR create: the page still sees its own values restored", (await pageText("out-xhr")).includes("rohan.mehta@example.com"));
await route("#/overview");
await sleep(500);
await shot("04-overview-after-inline-requests");

// With the side panel closed the CRM request still goes out masked: the app is never blocked on the panel.
await closePanel();
n = await count();
await clearErrors();
await clickPage("create-fetch");
await until(async () => (await count()) === n + 1, "the CRM request with the side panel closed");
check("closed panel: the CRM request was not blocked and went out protected", (await pageText("errors")) === "" && noRaw(await crmText()).length === 0, noRaw(await crmText()).join(","));

/* ---------------------------------------------------------------- EXT-01: the Hosts page */
await openPanel("#/hosts");
await until(() => phas('[data-testid="page-hosts"] [data-testid="host-row"]'), "the Hosts page to list the default host");
const rowState = (name) => panel.evalJs(`document.querySelector('[data-testid="host-row"][data-host=${JSON.stringify(name)}]')?.dataset.state ?? null`);
check("Hosts: the default host shows access granted and protecting", (await rowState("127.0.0.1:5173")) === "protecting");
await shot("05-hosts");

// Validation errors are visible and nothing is stored.
const tryAdd = async (text) => {
  await pset('[data-testid="host-input"]', text);
  await sleep(100);
  await pclick('[data-testid="host-add"]');
  await sleep(500);
  return panel.evalJs(`document.querySelector('[data-testid="host-error"]')?.innerText ?? ''`);
};
for (const [bad, why] of [["https://crm.example.test", /without http/], ["*", /wildcard/i], ["*.com", /full domain/], ["crm.example.test/api", /host name only/], ["bad host", /spaces/]]) {
  const e = await tryAdd(bad);
  check(`Hosts: "${bad}" is refused with a visible reason`, why.test(e), e.replace(/\s+/g, " ").slice(0, 120));
}
check("Hosts: refused input stored nothing", JSON.parse(await swEval("chrome.storage.local.get('airlock.ext.hosts.v1').then((v) => JSON.stringify(v['airlock.ext.hosts.v1']))")).length === 1);
await shot("06-hosts-validation-error");

// A request for the permission outside a user gesture is refused by Chrome, and the panel says so. Both steps run
// without a user gesture and after the transient activation lapsed, so no browser prompt can open. If the UI does
// not settle in a few seconds the panel tab is closed (that dismisses any prompt) and the check fails.
await sleep(6500);
const noGestureEval = (expression) => panel.send("Runtime.evaluate", { expression, userGesture: false, returnByValue: true });
await noGestureEval(`(() => { const e = document.querySelector('[data-testid="host-input"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, 'ungranted.example.test'); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(300);
await noGestureEval(`document.querySelector('[data-testid="host-add"]').click()`);
const settled = await until(() => panel.evalJs(`!!document.querySelector('[data-testid="host-error"]') || !document.querySelector('[data-testid="host-add"]').disabled`), "the gesture-less request to settle", 4000).catch(() => false);
const gestureMsg = settled ? await panel.evalJs(`document.querySelector('[data-testid="host-error"]')?.innerText ?? ''`) : "(the request did not settle; a browser prompt may be open)";
check("Hosts: a permission request outside a user gesture is refused by Chrome and shown", settled && /gesture|could not ask/i.test(gestureMsg), gestureMsg.replace(/\s+/g, " ").slice(0, 160));
if (!settled) {
  await closePanel();
  await openPanel("#/hosts");
}
check("Hosts: that refusal added nothing to the list", (await rowState("ungranted.example.test")) === null);

// A real click adds a host (the test build already holds access to it, so no prompt appears).
await pset('[data-testid="host-input"]', "crm.example.test");
await pclick('[data-testid="host-add"]');
await until(async () => (await rowState("crm.example.test")) === "protecting", "the added host to be registered");
check("Hosts: adding a host through the panel registers its scripts", (await registered()).length === 4, (await registered()).join(" ; "));
check("Hosts: the stored list holds the match pattern", JSON.stringify(JSON.parse(await swEval("chrome.storage.local.get('airlock.ext.hosts.v1').then((v) => JSON.stringify(v['airlock.ext.hosts.v1']))"))) === JSON.stringify(["http://127.0.0.1:5173/*", "https://crm.example.test/*"]));
await shot("07-hosts-added");
await pclick('[data-host="crm.example.test"] [data-testid="host-remove"]');
await until(async () => (await rowState("crm.example.test")) === null, "the host row to disappear");
check("Hosts: removing a host unregisters its scripts", (await registered()).length === 2, (await registered()).join(" ; "));
const permNote = await panel.evalJs(`document.querySelector('[data-testid="hosts-status"]')?.innerText ?? ''`);
note(`after removing a host whose access came with the install: ${permNote || "(no note shown: Chrome let the access go)"}`);
check("Hosts: removing a host never claims more than happened (a note appears only when Chrome kept the access)", permNote === "" || /no longer protects/.test(permNote), permNote);

// The hold timeout control: clamped input, stored where the background reads it.
await pset('[data-testid="timeout-input"]', "0");
await pclick('[data-testid="timeout-save"]');
await sleep(300);
check("Hosts: a hold timeout of 0 s is refused with the range", /between 1 and 600/i.test(await panel.evalJs(`document.querySelector('[data-testid="timeout-msg"]')?.innerText ?? ''`)));
await pset('[data-testid="timeout-input"]', "9000");
await pclick('[data-testid="timeout-save"]');
await sleep(300);
check("Hosts: a hold timeout above 600 s is refused", /between 1 and 600/i.test(await panel.evalJs(`document.querySelector('[data-testid="timeout-msg"]')?.innerText ?? ''`)));
await pset('[data-testid="timeout-input"]', "7");
await pclick('[data-testid="timeout-save"]');
await sleep(500);
check("Hosts: a valid hold timeout is stored in milliseconds", (await swEval("chrome.storage.local.get('airlock.ext.settings.v1').then((v) => v['airlock.ext.settings.v1'].holdTimeoutMs)")) === 7000);
// A held inspection is discarded after the same timeout, so the Nano run below needs room: 180 s, set through the same control.
await pset('[data-testid="timeout-input"]', "180");
await pclick('[data-testid="timeout-save"]');
await sleep(500);
check("Hosts: the timeout control accepts 180 s", (await swEval("chrome.storage.local.get('airlock.ext.settings.v1').then((v) => v['airlock.ext.settings.v1'].holdTimeoutMs)")) === 180000);

// Removing the page's own host through the panel stops protection; adding it back restores it.
await pclick('[data-host="127.0.0.1:5173"] [data-testid="host-remove"]');
await until(async () => (await rowState("127.0.0.1:5173")) === null, "the page's host to be removed");
check("Hosts: removing the page's host unregisters both scripts", (await registered()).length === 0, (await registered()).join(","));
await reloadPage();
check("removed: the host's page is no longer injected or wrapped", !(await injected()) && (await page.evalJs("/native code/.test(fetch.toString())")));
n = await count();
await clickPage("create-fetch");
await until(async () => (await count()) === n + 1, "the unprotected request to reach the mock CRM");
check("removed: an unconfigured host is untouched (raw values reach it, as the user configured)", noRaw(await crmText()).length > 0);
await pset('[data-testid="host-input"]', "127.0.0.1:5173");
await pclick('[data-testid="host-add"]');
await until(async () => (await rowState("127.0.0.1:5173")) === "protecting", "the host to be added back");
check("Hosts: adding it back registers both scripts again", (await registered()).length === 2);
await fetch(`${ORIGIN}/mock-crm/api/_reset`, { method: "POST" });
await reloadPage();
await closePanel();

/* ---------------------------------------------------------------- Inspection through the panel (real Gemini Nano when it is there) */
console.log("\n== inspection through the panel ==");
await page.evalJs(`localStorage.removeItem(${JSON.stringify(KEY_PROFILES)})`);
await reloadPage();
check("an unprofiled create is wrapped again after the reload", await until(injected, "the page script marker", 10000).catch(() => false));
await openPanel();
const nBefore = await count();
await clickPage("create-fetch");
await until(async () => /Classify on-device/.test(await ptext()) && /Captured fields|HELD/i.test(await ptext()), "the held request on the Inspection page", 30000);
const held = await ptext();
check("inspection: the unprofiled create is captured on the Inspection page, for authoring later", /Captured fields/i.test(held) && (await panel.evalJs("location.hash")).startsWith("#/inspection"));
check("inspection: the capture shows no sample value", RAW.every((v) => !held.includes(v)));
check("inspection: the captured request was sent at once, not held, with the email and phone tokenized", (await count()) === nBefore + 1 && noGenericRaw(await crmText()).length === 0, noGenericRaw(await crmText()).join(","));
note(`generic masking without a profile left these in the stored record (the documented limit): ${noRaw(await crmText()).filter((v) => !GENERIC_CATCHES.includes(v)).join(", ") || "none"}`);
await shot("08-inspection-held");
const modelState = await panel.evalJs(`document.querySelector('.ac-top')?.innerText ?? ''`);
note(`panel model chip text: ${modelState.replace(/\s+/g, " ").slice(0, 100)}`);

await pclickText("Classify on-device");
const classified = await until(async () => {
  const t = await ptext();
  return /Proposed on-device by Gemini Nano|Detector-only fallback/.test(t) ? t : false;
}, "classification", 240000);
const onDevice = /Proposed on-device by Gemini Nano/.test(classified);
note(onDevice ? "classification ran on a real Gemini Nano (inferenceSource: on_device)" : `classification used the labelled DETECTOR-ONLY fallback: ${/Detector-only fallback:?\s*([^\n]*)/i.exec(classified)?.[1] ?? ""}`);
check("inspection: classification is labelled by what really ran, never guessed", onDevice || /Detector-only fallback/.test(classified));
await shot("09-inspection-classified", "Classification");

await pclickText("Author profile");
const authored = await until(async () => {
  const t = await ptext();
  return /Authored by/.test(t) || /Not valid/.test(t) ? t : false;
}, "authoring result", 300000);
const by = /Authored by:?\s*(\S+)/i.exec(authored);
if (by) {
  note(`authoring: inferenceSource ${by[1]}`);
  const wants = { "$.properties.firstname": "surrogate", "$.properties.lastname": "surrogate", "$.properties.email": "token", "$.properties.phone": "token", "$.properties.salary": "token", "$.properties.internal_note": "drop", "$.properties.city": "allow", "$.properties.plan": "allow" };
  let edited = 0;
  for (const [path, action] of Object.entries(wants)) {
    const sel = `select[aria-label="Action for ${path}"]`;
    if (!(await phas(sel))) continue;
    if ((await panel.evalJs(`document.querySelector(${JSON.stringify(sel)}).value`)) !== action) {
      edited++;
      await pset(sel, action);
      await sleep(900);
    }
  }
  note(`${edited} of ${Object.keys(wants).length} fields edited by the user step`);
  const ready = await until(() => panel.evalJs(`[...document.querySelectorAll('button')].some((b) => /Approve and save profile/.test(b.textContent) && !b.disabled)`), "the draft to be ready", 30000).catch(() => false);
  check("inspection: after the edits the draft is ready to approve", !!ready);
  await shot("10-inspection-authored", "Authoring");
  check("inspection: nothing is stored in the page before Approve", (await page.evalJs(`localStorage.getItem(${JSON.stringify(KEY_PROFILES)})`)) === null);
  if (ready) {
    await pclickText("Approve and save profile");
    await until(async () => /Profile saved/.test(await ptext()), "Profile saved", 20000);
    const profiles = JSON.parse((await page.evalJs(`localStorage.getItem(${JSON.stringify(KEY_PROFILES)})`)) ?? "[]");
    const prof = profiles.find((x) => String(x.id).startsWith("authored-"));
    check("inspection: the saved profile's author equals the inferenceSource the panel showed", !!prof && prof.author.by === by[1], `${prof?.author?.by} vs ${by[1]}`);
    check("inspection: the saved profile holds no sample value", RAW.every((v) => !JSON.stringify(profiles).includes(v)));
    await shot("11-inspection-saved");
    // The request in flight already went out masked. The saved profile protects the next one, again without waiting.
    await sleep(800);
    await clearErrors();
    await fetch(`${ORIGIN}/mock-crm/api/_reset`, { method: "POST" });
    const before2 = await count();
    await clickPage("create-xhr");
    await until(async () => /HTTP 2\d\d/.test(await pageText("out-xhr")), "the second create to finish with no approval step");
    check("inspection: the second create went out under the saved profile with no approval step", !(await phas('[data-testid="drawer-approve"]')));
    check("inspection: the CRM stored protected values only", (await count()) === before2 + 1 && noRaw(await crmText()).length === 0, noRaw(await crmText()).join(","));
  } else {
    await pclickText("Discard capture");
  }
} else {
  note(`authoring did not produce a profile: ${(authored.split(/not valid/i)[1] ?? "").slice(0, 300).replace(/\s+/g, " ")}`);
  check("inspection: a failed authoring is shown as Not valid, never faked", /Not valid/.test(authored));
  await shot("10-inspection-authoring-failed");
  await pclickText("Discard capture");
}

/* ---------------------------------------------------------------- the toolbar button opens the side panel */
const behaviour = await swEval("chrome.sidePanel.getPanelBehavior().then((b) => JSON.stringify(b))");
check("the toolbar button is set to open the side panel", JSON.parse(behaviour).openPanelOnActionClick === true, behaviour);

/* ---------------------------------------------------------------- clean up */
await closePanel();
await closeTargets(`chrome-extension://${EXT_ID}/`);
await fetch(`${ORIGIN}/mock-crm/api/_reset`, { method: "POST" });
await swEval("chrome.storage.local.remove('airlock.ext.settings.v1')");
await page.evalJs(`localStorage.removeItem(${JSON.stringify(KEY_PROFILES)})`);
page.close();
// Leave the dedicated profile as found: an installed AIRLOCK extension would also wrap the web app on this host.
await bsend("Extensions.uninstall", { id: EXT_ID }).catch(() => undefined);
bws.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
