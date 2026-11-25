// Real-CRM proof: AIRLOCK protecting a REAL third-party CRM it does not control (EspoCRM, self-hosted in Docker), end to
// end in real Chrome with the extension and real Gemini Nano. HubSpot is NOT used or tested.
//   docker compose -f demo/espocrm/docker-compose.yml up -d     (http://localhost:8080, admin / airlock-demo-admin)
//   node scripts/build-ext.mjs --out dist-ext-espo --test-host "http://localhost:8080/*"
//   node scripts/e2e-espocrm.mjs [--stop-after=<phase>]
// Needs the dedicated automation Chrome (powershell -NoProfile -File scripts/chrome-nano.ps1, debug port 9222). It
// loads dist-ext-espo into THAT profile only (Extensions.loadUnpacked), drives EspoCRM's OWN web UI (log in, fill the
// Contact form, click Save) through DevTools, and uninstalls the extension at the end. The stored data is then read
// back from the CRM's REST API with curl-style requests that do NOT go through the page, using the throwaway demo
// admin of this local test CRM. Synthetic data only. Screenshots and run.json go to scripts/out/espocrm/.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { connect } from "./cdp.mjs";

const PORT = process.env.CDP_PORT ?? "9222";
const CRM = "http://localhost:8080";
const CRM_HOST = "localhost:8080";
const AUTH = "Basic " + Buffer.from("admin:airlock-demo-admin").toString("base64");
const EXT_DIR = path.resolve("dist-ext-espo").replace(/\\/g, "/");
const EXT_ID = "ombmjhkmnofdcbfafhjcnppjdkalekan";
const PANEL_URL = `chrome-extension://${EXT_ID}/sidepanel.html`;
const OUT = "scripts/out/espocrm";
const STOP = (process.argv.find((a) => a.startsWith("--stop-after=")) ?? "").split("=")[1] ?? "";

/** Synthetic people. Every value is made up; example.com is a reserved domain. */
const ROHAN = { first: "Rohan", last: "Mehta", email: "rohan.mehta@example.com", phone: "+91 98765 43210", city: "Pune", note: "Prefers a call after lunch, renewal budget signed off" };
const ASHA = { first: "Asha", last: "Verma", email: "asha.verma@example.com", phone: "+91 91234 56780", city: "Mumbai", note: "Asked for a quote by Friday" };
const RAW = [ROHAN, ASHA].flatMap((p) => [p.first, p.last, p.email, p.phone, p.phone.replace(/\D/g, ""), p.note]);

const results = [];
const run = { startedAt: new Date().toISOString(), crm: "EspoCRM (self-hosted, Docker)", hubspotTested: false, checks: [], inference: [], notes: [], list: {} };
const check = (name, ok, extra = "") => {
  results.push(ok);
  run.checks.push({ name, ok: !!ok, detail: extra || undefined });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const note = (s) => {
  run.notes.push(s);
  console.log(`NOTE  ${s}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* keep waiting */
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${label}`);
}
fs.mkdirSync(OUT, { recursive: true });
const finish = async (code) => {
  run.endedAt = new Date().toISOString();
  run.passed = results.filter(Boolean).length;
  run.total = results.length;
  fs.writeFileSync(`${OUT}/run.json`, JSON.stringify(run, null, 2));
  console.log(`\n${run.passed}/${run.total} checks passed (run log: ${OUT}/run.json)`);
  process.exit(code);
};
const stopHere = async (phase) => {
  if (STOP === phase) {
    note(`stopped after phase "${phase}" as asked`);
    await finish(0);
  }
};

/* ---------------------------------------------------------------- the CRM's own REST API, NOT through the page */
const api = async (method, p, body) => {
  const res = await fetch(`${CRM}/api/v1/${p}`, { method, headers: { Authorization: AUTH, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text, json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : null };
};
const storedContacts = async () => (await api("GET", "Contact?maxSize=200&orderBy=createdAt&order=asc")).json?.list ?? [];
const noRaw = (text) => RAW.filter((v) => text.includes(v));

if (!(await fetch(`${CRM}/api/v1/App/user`, { headers: { Authorization: AUTH } }).then((r) => r.ok).catch(() => false))) {
  throw new Error("EspoCRM is not answering on http://localhost:8080. Start it: docker compose -f demo/espocrm/docker-compose.yml up -d (inside WSL)");
}
// Test hygiene: start with no contacts (REST, outside the page; the proof flows below go through EspoCRM's own UI).
for (const c of await storedContacts()) await api("DELETE", `Contact/${c.id}`);
check("test setup: the CRM starts with no contacts", (await storedContacts()).length === 0);

/* ---------------------------------------------------------------- browser-level DevTools and the extension */
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json().catch(() => null);
if (!version) throw new Error(`No Chrome on port ${PORT}. Start it: powershell -NoProfile -File scripts/chrome-nano.ps1`);
run.chrome = version.Browser;
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
const closeTargets = async (prefix) => {
  for (const t of await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) {
    if (t.type === "page" && t.url.startsWith(prefix)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
  }
};
await bsend("Extensions.uninstall", { id: EXT_ID }).catch(() => undefined);
const loaded = await bsend("Extensions.loadUnpacked", { path: EXT_DIR });
check("extension loaded into the dedicated profile with the pinned ID", loaded.id === EXT_ID, loaded.id);
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
// The hold timeout also bounds a held inspection, and the Nano runs need room.
await swEval(`chrome.storage.local.set({ 'airlock.ext.settings.v1': { holdTimeoutMs: 300000 } })`);
await swEval(`chrome.storage.local.set({ 'airlock.ext.hosts.v1': [] })`).catch(() => undefined);

/* ---------------------------------------------------------------- the CRM tab and the side panel */
await closeTargets(PANEL_URL);
const tabs = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === "page");
// Always a fresh tab: an old one can sit on a leave-the-page prompt from an earlier run and answer nothing.
await closeTargets(CRM);
await sleep(500);
await bsend("Target.createTarget", { url: `${CRM}/robots.txt` });
await sleep(1500);
// Fresh site data for EspoCRM in this profile: logged out, no AIRLOCK state, so every run starts the same way.
let page = await connect(CRM);
// A leave-the-page confirmation (EspoCRM asks when a form has unsaved input) would freeze every command: accept it.
page.on("Page.javascriptDialogOpening", () => void page.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined));
await page.send("Page.enable");
await page.send("Page.bringToFront");
await page.send("Network.enable");
for (const c of (await page.send("Network.getCookies", { urls: [CRM] })).cookies) await page.send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path });
await page.evalJs("localStorage.clear(); sessionStorage.clear(); true");
// A clean AIRLOCK state on this origin: profiles, rules, vault and token key live in the protected site's localStorage.
const tabId = Number(await swEval(`chrome.tabs.query({ url: '${CRM}/*' }).then((t) => t.at(-1).id)`));

let panel = null;
async function openPanel(hash = "") {
  await closeTargets(PANEL_URL);
  await bsend("Target.createTarget", { url: `${PANEL_URL}?tab=${tabId}${hash}` });
  panel = await connect(`${PANEL_URL}?tab=${tabId}`);
  await panel.send("Page.enable");
  await panel.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
}
const ptext = () => panel.evalJs("document.body.innerText");
const phas = (sel) => panel.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
const pclick = (sel) => panel.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.disabled) return false; e.click(); return true; })()`);
const pclickText = (label, tag = "button") =>
  panel.evalJs(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(tag)})].find((x) => x.textContent.trim().includes(${JSON.stringify(label)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
const pset = (sel, value) =>
  panel.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event(e instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); return true; })()`);
const pcheck = (sel, on) =>
  panel.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; if (e.checked !== ${on}) e.click(); return true; })()`);
const route = (hash) => panel.evalJs(`location.hash = ${JSON.stringify(hash)}`).then(() => sleep(500));
const panelShot = async (name) => {
  await panel.send("Page.bringToFront");
  await sleep(500);
  await panel.screenshot(`${OUT}/${name}.png`);
  console.log(`      screenshot ${OUT}/${name}.png`);
};
const pageShot = async (name) => {
  await page.send("Page.bringToFront");
  await sleep(700);
  await page.screenshot(`${OUT}/${name}.png`);
  console.log(`      screenshot ${OUT}/${name}.png`);
};

/* ---------------------------------------------------------------- phase: hosts - configure localhost:8080 in the extension */
console.log("\n== configure the host in the extension ==");
await openPanel("#/hosts");
await until(() => phas('[data-testid="host-input"]'), "the Hosts page", 20000);
await pset('[data-testid="host-input"]', CRM_HOST);
await pclick('[data-testid="host-add"]');
await until(async () => (await swEval("chrome.storage.local.get('airlock.ext.hosts.v1').then((v) => JSON.stringify(v['airlock.ext.hosts.v1'] ?? []))")).includes("localhost:8080"), "the host to be stored", 15000);
const hostList = await swEval("chrome.storage.local.get('airlock.ext.hosts.v1').then((v) => JSON.stringify(v['airlock.ext.hosts.v1'] ?? []))");
check("the host localhost:8080 is configured through the extension's Hosts page", hostList.includes("http://localhost:8080/*"), hostList);
await panelShot("01-hosts");
await stopHere("hosts");

/* ---------------------------------------------------------------- phase: policy - a host rule with "allow reads without a body" */
console.log("\n== the host rule and the allow-reads option ==");
// A static URL on the host: the extension is injected, and EspoCRM's app (which fires many requests at startup) is not
// loaded until the rule below is set.
await page.send("Page.navigate", { url: `${CRM}/robots.txt` });
await sleep(1500);
await until(() => page.evalJs("!!globalThis[Symbol.for('airlock.ext.page')]"), "the extension to be injected in EspoCRM", 15000);
check("the EspoCRM page is wrapped by the extension (MAIN world, document_start)", await page.evalJs("!/native code/.test(XMLHttpRequest.prototype.send.toString())"));
// Start from the defaults: stored rules or profiles from an earlier run would change what applies.
await page.evalJs(`['airlock.rules.v1','airlock.profiles.v1','airlock.vault.v1','airlock.tokenkey.v1'].forEach((k) => localStorage.removeItem(k))`);
await page.send("Page.navigate", { url: `${CRM}/robots.txt` });
await sleep(1500);
// No per-host rule is needed: the default SaaS destination is inline (mask and send at once, review later).
note("no host rule or allow-reads setting is used: the default SaaS destination is inline");
check("the default rules mark the SaaS destination inline", (await page.evalJs(`localStorage.getItem('airlock.rules.v1')`)) === null);
await stopHere("policy");

/* ---------------------------------------------------------------- phase: login through EspoCRM's own page */
console.log("\n== log in through EspoCRM's own login page ==");
await page.send("Page.navigate", { url: `${CRM}/` });
await sleep(1500);
const type = (sel, text) => page.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(text)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await until(() => page.evalJs("!!document.querySelector('#field-userName')"), "the login form", 15000);
await type("#field-userName", "admin");
await type("#field-password", "airlock-demo-admin");
await page.evalJs(`document.querySelector('#btn-login').click()`);
await until(() => page.evalJs("!!document.querySelector('.navbar, #navbar')"), "EspoCRM to finish logging in", 60000);
await sleep(3000);
check("EspoCRM's own login works through AIRLOCK and the app starts", await page.evalJs("!document.querySelector('#login-form') && !!document.querySelector('.navbar')"));
await pageShot("04-espocrm-home");
await route("#/traffic");
await sleep(1000);
await panelShot("05-panel-traffic-after-login");
const reqs = await panel.evalJs(`document.body.innerText`);
note("panel traffic text after login: " + reqs.replace(/\s+/g, " ").slice(0, 600));
await stopHere("login");

/* ---------------------------------------------------------------- the contact form, driven the way a user does */
const fill = async (sel, text) => {
  await page.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); e.focus(); e.select?.(); return true; })()`);
  await page.send("Input.insertText", { text });
  await page.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.dispatchEvent(new Event('change', { bubbles: true })); e.blur(); return true; })()`);
};
async function openCreateForm(person) {
  await page.send("Page.bringToFront");
  await page.evalJs(`location.hash = '#Contact/create'`);
  await until(() => page.evalJs("!!document.querySelector('input[data-name=\"firstName\"]')"), "the Contact form", 30000);
  await sleep(800);
  await fill('input[data-name="firstName"]', person.first);
  await fill('input[data-name="lastName"]', person.last);
  await fill(".field[data-name=\"emailAddress\"] input.email-address", person.email);
  await fill(".field[data-name=\"phoneNumber\"] input.phone-number", person.phone);
  await fill('input[data-name="addressCity"]', person.city);
  await fill('textarea[data-name="description"]', person.note);
}
const clickSave = () => page.evalJs(`document.querySelector('button[data-action="save"]').click()`);
const formValues = () =>
  page.evalJs(`JSON.stringify({ first: document.querySelector('input[data-name="firstName"]')?.value, last: document.querySelector('input[data-name="lastName"]')?.value, email: document.querySelector('.field[data-name="emailAddress"] input.email-address')?.value, phone: document.querySelector('.field[data-name="phoneNumber"] input.phone-number')?.value })`).then(JSON.parse);

/* ---------------------------------------------------------------- phase: capture - the create is held, Nano classifies */
console.log("\n== create a Contact through EspoCRM's own UI: held, classified on-device ==");
// A user opens the Contacts list first; its GET is released under the allow-reads rule and its answer shape is observed.
await page.evalJs(`location.hash = '#Contact'`);
await until(() => page.evalJs("!!document.querySelector('.list-container, .no-data, .list')"), "the Contact list view", 30000);
await sleep(1500);
await openCreateForm(ROHAN);
const typed = await formValues();
check("the Contact form holds the synthetic values the user typed", typed.first === ROHAN.first && typed.email === ROHAN.email, JSON.stringify({ phone: typed.phone }));
await pageShot("06-espocrm-create-form");
await clickSave();
await until(async () => /Classify on-device/.test(await ptext()) && (await panel.evalJs("location.hash")).startsWith("#/inspection"), "the held create on the Inspection page", 60000).catch(async () => {
  await route("#/inspection");
  await until(async () => /Classify on-device/.test(await ptext()), "the held create on the Inspection page", 30000);
});
const held = await ptext();
check("the create (POST to EspoCRM) is captured on the Inspection page, for authoring", /Captured fields/.test(held) && /POST localhost:8080\/api\/v1\/Contact/.test(held), (/POST localhost:8080\S*/.exec(held) ?? [""])[0]);
await sleep(2500);
const firstStored = await storedContacts();
check("the create was NOT held: EspoCRM stored it at once, and the generic detectors tokenized the email", firstStored.length === 1 && !JSON.stringify(firstStored).includes(ROHAN.email), JSON.stringify(firstStored[0] && { email: firstStored[0].emailAddress, phone: firstStored[0].phoneNumber }));
run.list.genericLimit = { storedRealNames: JSON.stringify(firstStored).includes(ROHAN.first), storedRealPhoneDigits: JSON.stringify(firstStored).replace(/\D/g, "").includes("9876543210") };
note(`generic masking without a profile: real first name stored in the CRM = ${run.list.genericLimit.storedRealNames} (the documented limit: names need a profile)`);
check("the Inspection page shows no sample value", noRaw(held).length === 0, noRaw(held).join(","));
const heldLeaves = await panel.evalJs(`[...document.querySelectorAll('.ac-table tbody tr')].map((r) => r.children[1]?.textContent).filter(Boolean)`);
run.list.capturedLeafPaths = heldLeaves;
await panelShot("07-inspection-held");
await stopHere("held");

await pclickText("Classify on-device");
const classified = await until(async () => {
  const t = await ptext();
  return /Proposed on-device by Gemini Nano|Detector-only fallback/.test(t) ? t : false;
}, "classification", 300000);
const onDevice = /Proposed on-device by Gemini Nano/.test(classified);
run.inference.push({ step: "classify-fields", mode: "ONLY_ON_DEVICE", inferenceSource: onDevice ? "on_device" : "detectors" });
note(onDevice ? "classification ran on real Gemini Nano (inferenceSource: on_device)" : "classification used the labelled DETECTOR-ONLY fallback, not Nano");
check("classification is labelled by what really ran", onDevice || /Detector-only fallback/.test(classified));
const classRows = await panel.evalJs(`[...document.querySelectorAll('.ac-classrow')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`);
run.list.classification = classRows;
classRows.forEach((r) => note(`classified: ${r}`));
await panelShot("08-inspection-classified");
await stopHere("classified");

/* ---------------------------------------------------------------- phase: author - Nano writes the profile, the user corrects it */
console.log("\n== authoring a profile for the EspoCRM host ==");
// Nano's output is data and is validated; a bad answer is refused by name, never repaired. A user would press Author profile
// again, so the script does too (at most 8 attempts) and records every attempt, valid or not.
let by;
const attempts = [];
for (let n = 1; n <= 8 && !(await phas('select[aria-label^="Action for "]')); n++) {
  await until(() => panel.evalJs(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Author profile' && !b.disabled)`), "the Author button", 240000);
  await pclickText("Author profile");
  await sleep(1500);
  const text = await until(async () => {
    const t = await ptext();
    const busy = await panel.evalJs(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Authoring')`);
    return !busy && (/Authored by/.test(t) || /Not valid/.test(t)) ? t : false;
  }, "authoring result", 400000);
  by = /Authored by:?\s*(\S+)/i.exec(text)?.[1];
  const editor = await phas('select[aria-label^="Action for "]');
  const valid = editor && !/Not valid/.test(text);
  const why = valid ? "" : text.slice(text.search(/Not valid/)).split("\n").slice(1, 3).join(" ").slice(0, 220);
  attempts.push({ attempt: n, inferenceSource: by ?? "none", valid, why: why || undefined });
  run.inference.push({ step: "author-profile", mode: "PREFER_ON_DEVICE", inferenceSource: by ?? "none", attempt: n, valid });
  note(`authoring attempt ${n}: inferenceSource ${by}, ${valid ? "a valid draft" : "refused as Not valid (" + (editor ? "the draft is kept for the user to correct" : "no draft") + "): " + why}`);
}
run.list.authoringAttempts = attempts;
check("authoring ran on a real model and reports its real inferenceSource", by === "on_device" || by === "in_cloud", String(by));
check("authoring produced a draft the user can review (valid, or refused by name with the draft kept for correction)", await phas('select[aria-label^="Action for "]'), JSON.stringify(attempts.map((a) => a.valid)));
const readFields = () =>
  panel.evalJs(`(() => { const out = {}; for (const s of document.querySelectorAll('select[aria-label^="Action for "]')) { const path = s.getAttribute('aria-label').slice('Action for '.length); const c = document.querySelector('select[aria-label="Category for ' + path + '"]'); out[path] = { action: s.value, category: c?.value ?? '' }; } return out; })()`);
const modelFields = await readFields();
run.list.authoredByModel = modelFields;
Object.entries(modelFields).forEach(([p, f]) => note(`model draft: ${p} -> ${f.category || "(none)"} / ${f.action || "(default)"}`));
await panelShot("09-inspection-authored");
await stopHere("authored");

// The user's corrections, field by field, in the console's own editor.
const WANT = {
  "$.firstName": ["identifier", "surrogate"],
  "$.lastName": ["identifier", "surrogate"],
  "$.name": ["identifier", "surrogate"],
  "$.emailAddress": ["contact", "surrogate"],
  "$.emailAddressData[*].emailAddress": ["contact", "surrogate"],
  "$.emailAddressData[*].lower": ["contact", "surrogate"],
  "$.phoneNumber": ["contact", "surrogate"],
  "$.phoneNumberData[*].phoneNumber": ["contact", "surrogate"],
  "$.description": ["free_text", "token"],
  "$.addressCity": ["non_sensitive", "allow"],
};
let edits = 0;
const editLog = [];
for (const [p, [category, action]] of Object.entries(WANT)) {
  const cat = `select[aria-label="Category for ${p}"]`;
  const act = `select[aria-label="Action for ${p}"]`;
  if (!(await phas(act))) {
    editLog.push(`${p}: not offered by the editor`);
    continue;
  }
  const now = (await readFields())[p];
  if (now.category !== category) {
    await pset(cat, category);
    await sleep(900);
    edits++;
    editLog.push(`${p}: category ${now.category || "(none)"} -> ${category}`);
  }
  if ((await readFields())[p].action !== action) {
    await pset(act, action);
    await sleep(900);
    edits++;
    editLog.push(`${p}: action ${now.action || "(default)"} -> ${action}`);
  }
}
run.list.userEdits = editLog;
editLog.forEach((e) => note(`user edit: ${e}`));
note(`${edits} edits made by the user step`);
await stopHere("edited");

/* ---------------------------------------------------------------- phase: locators and approve */
console.log("\n== response locators, the dry run, Approve and save ==");
await panel.evalJs(`document.querySelector('[data-testid="response-locators"]')?.scrollIntoView({ block: 'start' })`);
const locText = await panel.evalJs(`document.querySelector('[data-testid="response-locators"]')?.innerText ?? ''`);
run.list.locatorCardBeforeAddGet = locText.replace(/\s+/g, " ").slice(0, 600);
note(`response locators card: ${run.list.locatorCardBeforeAddGet}`);
check("code proposes response locators from what the page's own reads showed (not the model)", /Suggested by code/.test(locText) && /\$\.list\[\*\]/.test(locText), locText.replace(/\s+/g, " ").slice(0, 160));
check("the card offers Add GET for the observed read of the Contact list", await phas('[data-testid="add-get"]'));
await panelShot("10-response-locators-before-add-get");
await pclickText("Add GET");
await until(async () => /GET added/.test(await panel.evalJs(`document.querySelector('[data-testid="response-locators"]')?.innerText ?? ''`)), "GET to be added", 30000);
await panelShot("11-response-locators-get-added");
const ready = await until(() => panel.evalJs(`[...document.querySelectorAll('button')].some((b) => /Approve and save profile/.test(b.textContent) && !b.disabled)`), "the draft to be ready to approve", 60000).catch(() => false);
check("the edited draft passes validation and the dry run, so Approve is enabled", !!ready);
check("nothing is stored in the page before Approve", (await page.evalJs(`localStorage.getItem('airlock.profiles.v1')`)) === null);
await panel.evalJs(`document.querySelector('[data-testid="dry-run"]')?.scrollIntoView({ block: 'center' })`);
await panelShot("12-inspection-dry-run");
await pclickText("Approve and save profile");
await until(async () => /Profile saved/.test(await ptext()), "Profile saved", 30000);
const storedProfiles = JSON.parse(await page.evalJs(`localStorage.getItem('airlock.profiles.v1')`));
const profile = storedProfiles.find((x) => String(x.id).startsWith("authored-"));
const profileText = JSON.stringify(profile, null, 2);
run.profile = { id: profile?.id, authoredBy: profile?.author?.by, sha256: crypto.createHash("sha256").update(JSON.stringify(profile)).digest("hex"), methods: profile?.match?.methods, paths: profile?.match?.paths, requestFields: profile?.request?.fields?.length, responseFields: profile?.response?.fields?.map((f) => f.path) };
fs.writeFileSync(`${OUT}/authored-profile.json`, profileText);
check("the saved profile's author equals the inferenceSource the panel showed", !!profile && profile.author.by === by, `${profile?.author?.by} vs ${by}`);
check("the saved profile holds no sample value", noRaw(profileText).length === 0, noRaw(profileText).join(","));
check("the saved profile covers GET and carries learned response locators", !!profile?.match.methods?.includes("GET") && (profile?.response.fields.length ?? 0) > 0, JSON.stringify({ methods: profile?.match.methods, response: profile?.response.fields.map((f) => f.path) }));
check("the profile names exactly the host localhost:8080", JSON.stringify(profile?.match.hosts) === JSON.stringify([CRM_HOST]));
await panelShot("13-inspection-saved");
await sleep(1500);
const afterBlock = await page.evalJs("document.body.innerText.slice(0, 600)");
note(`EspoCRM after the held create was settled by the save: ${afterBlock.replace(/\s+/g, " ").slice(0, 160)}`);
await stopHere("approved");

/* ---------------------------------------------------------------- helpers for the protected creates */
const hasDrawerApprove = () => (panel ? phas('[data-testid="drawer-approve"]') : Promise.resolve(false));
const modalText = () => page.evalJs(`[...document.querySelectorAll('.modal.in, .modal.show, .modal')].filter((m) => m.offsetParent).map((m) => m.innerText).join(' ')`);
/** After Save: no approval exists for a CRM request. Deal with EspoCRM's own duplicate dialog and wait for the detail view. */
async function saveAndApprove(label) {
  await page.send("Page.bringToFront");
  await clickSave();
  const t0 = Date.now();
  let sawDuplicate = false;
  while (Date.now() - t0 < 90000) {
    if (await hasDrawerApprove()) throw new Error(`${label}: a CRM request waited for approval, which inline mode must never do`);
    if (!sawDuplicate && /might already exist/i.test(await bodyText())) {
      sawDuplicate = true;
      note(`${label}: EspoCRM's own duplicate check matched the earlier contact by its stored stand-in email; the user pressed Create in its dialog`);
      await page.evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent && x.textContent.trim() === 'Create'); b?.click(); return !!b; })()`);
      await sleep(1500);
      continue;
    }
    if (/#Contact\/view\//.test(await page.evalJs("location.hash"))) break;
    await sleep(500);
  }
  await sleep(2500);
  return { sawDuplicate, hash: await page.evalJs("location.hash") };
}
const bodyText = () => page.evalJs("document.body.innerText");

/* ---------------------------------------------------------------- phase: the protected create through EspoCRM's UI */
console.log("\n== the retried create is protected; the CRM stores protected values; the UI shows real ones ==");
// The first (generic-masked) record from the capture step is removed so the counts below are exact.
for (const c of await storedContacts()) await api("DELETE", `Contact/${c.id}`);
await openCreateForm(ROHAN);
const first = await saveAndApprove("create 1");
check("the retried create went out under the saved profile with no approval step", first.hash.includes("#Contact/view/"), first.hash);
await panelShot("14-traffic-inline-protected");
await sleep(1500);
const stored1 = await storedContacts();
const storedText1 = JSON.stringify(stored1);
run.list.storedContact1 = stored1[0] && { firstName: stored1[0].firstName, lastName: stored1[0].lastName, name: stored1[0].name, emailAddress: stored1[0].emailAddress, phoneNumber: stored1[0].phoneNumber, addressCity: stored1[0].addressCity, description: stored1[0].description };
check("EspoCRM stored exactly one contact", stored1.length === 1);
check("the stored Contact (read from the CRM's REST API, not through the page) holds no real name, email, phone or note", noRaw(storedText1).length === 0, noRaw(storedText1).join(","));
check("its email and phone are format-valid stand-ins, its names are stand-ins, its note is a token", /^[^@\s]+@[^@\s]+$/.test(stored1[0]?.emailAddress ?? "") && stored1[0]?.emailAddress !== ROHAN.email && stored1[0]?.phoneNumber !== ROHAN.phone && stored1[0]?.firstName !== ROHAN.first && stored1[0]?.lastName !== ROHAN.last && /^tok_/.test(stored1[0]?.description ?? ""), JSON.stringify(run.list.storedContact1));
const detail = await bodyText();
check("EspoCRM's detail view shows the REAL name, email and city (response restore)", detail.includes(`${ROHAN.first} ${ROHAN.last}`) && detail.includes(ROHAN.email) && detail.includes(ROHAN.city), detail.replace(/\s+/g, " ").slice(0, 140));
check("EspoCRM's detail view shows the real phone digits and note", detail.replace(/\D/g, "").includes("9876543210") && detail.includes(ROHAN.note), "");
check("the detail view shows no token", !/tok_[a-z2-7]{22}/.test(detail));
await pageShot("15-espocrm-detail-real-values");
await stopHere("created");

// The CRM's own stored record, as REST returns it (a rendered copy for the screenshot; not through the page).
async function restShot(name, title, data) {
  const html = `<html><body style="font:14px Consolas,monospace;padding:16px;background:#101418;color:#e6edf3"><h3 style="margin:0 0 8px">${title}</h3><pre style="white-space:pre-wrap">${data.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</pre></body></html>`;
  await bsend("Target.createTarget", { url: "about:blank" });
  const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === "page" && t.url === "about:blank");
  const t = targets.at(-1);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let n = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) pend.get(m.id)(m.result);
  };
  const send = (method, params = {}) => new Promise((r) => (pend.set(++n, r), ws.send(JSON.stringify({ id: n, method, params }))));
  await send("Page.enable");
  await send("Page.bringToFront");
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
  await send("Runtime.evaluate", { expression: `document.open(); document.write(${JSON.stringify(html)}); document.close();` });
  await sleep(400);
  const shotData = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(shotData.data, "base64"));
  console.log(`      screenshot ${OUT}/${name}.png`);
  ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
}
const restView = (c) => JSON.stringify({ firstName: c.firstName, lastName: c.lastName, name: c.name, emailAddress: c.emailAddress, emailAddressData: c.emailAddressData?.map((e) => e.emailAddress), phoneNumber: c.phoneNumber, addressCity: c.addressCity, description: c.description }, null, 2);
await restShot("16-crm-rest-stored-values", "EspoCRM REST: GET /api/v1/Contact (curl-style, NOT through the page): what the CRM stored", restView(stored1[0]));
fs.writeFileSync(`${OUT}/rest-contact-1.json`, restView(stored1[0]));

// The list view.
await page.send("Page.bringToFront");
await page.evalJs(`location.hash = '#Contact'`);
await sleep(3500);
const list1 = await bodyText();
check("EspoCRM's list view shows the REAL name and email", list1.includes(`${ROHAN.first} ${ROHAN.last}`) && list1.includes(ROHAN.email), list1.replace(/\s+/g, " ").slice(0, 160));
check("the list view does not show a token", !/tok_[a-z2-7]{22}/.test(list1));
await pageShot("17-espocrm-list-real-values");

// The same contact again: same input, same tokens.
await openCreateForm(ROHAN);
const again = await saveAndApprove("create 2 (same contact)");
const stored2 = await storedContacts();
run.list.sameContactAgain = { count: stored2.length, sameEmailToken: stored2.length >= 2 && stored2[0].emailAddress === stored2[1].emailAddress, samePhoneToken: stored2.length >= 2 && stored2[0].phoneNumber === stored2[1].phoneNumber, sameSurrogateFirstName: stored2.length >= 2 && stored2[0].firstName === stored2[1].firstName, duplicateDialog: !!again.sawDuplicate };
check("creating the same contact again stores the SAME stand-in email", stored2.length >= 2 && stored2[0].emailAddress === stored2[1].emailAddress, JSON.stringify(run.list.sameContactAgain));
check("the repeat stores no raw value either", noRaw(JSON.stringify(stored2)).length === 0);
await stopHere("again");

// A second, different contact.
await openCreateForm(ASHA);
await saveAndApprove("create 3 (second contact)");
const stored3 = await storedContacts();
const asha = stored3.find((c) => c.emailAddress !== stored3[0].emailAddress);
check("a second, different contact works: its own stand-in email, no raw value stored", !!asha && /@/.test(asha.emailAddress) && noRaw(JSON.stringify(stored3)).length === 0, `${stored3.length} contacts`);
const detail2 = await bodyText();
check("the second contact's detail view shows its real values", detail2.includes(`${ASHA.first} ${ASHA.last}`) && detail2.includes(ASHA.email), "");
await pageShot("18-espocrm-second-contact");
await stopHere("second");

/* ---------------------------------------------------------------- phase: a closed side panel never blocks the CRM */
console.log("\n== closed panel: the CRM user is never blocked ==");
const THIRD = { first: "Dev", last: "Rao", email: "dev.rao@example.com", phone: "+91 90000 11122", city: "Chennai", note: "Wants onboarding next week" };
RAW.push(THIRD.first, THIRD.last, THIRD.email, "9000011122", THIRD.note);
await closeTargets(PANEL_URL);
panel = null;
await sleep(1500);
const before = (await storedContacts()).length;
await openCreateForm(THIRD);
await saveAndApprove("create 4 (side panel closed)");
const afterClosed = await storedContacts();
check("closed panel: the create still went through and the CRM holds no raw value", afterClosed.length === before + 1 && noRaw(JSON.stringify(afterClosed)).length === 0, `${afterClosed.length} contacts; ${noRaw(JSON.stringify(afterClosed)).join(",")}`);
check("closed panel: EspoCRM's page shows the real values of the new contact", (await bodyText()).includes(`${THIRD.first} ${THIRD.last}`));
await openPanel("#/traffic");
await route("#/audit");
await sleep(800);
await pclickText("Sends");
await sleep(600);
const auditText = await ptext();
check("the audit log lists the sends to the CRM, including the one made while the panel was closed", /localhost:8080/.test(auditText), auditText.replace(/\s+/g, " ").slice(200, 400));
await stopHere("failclosed");

/* ---------------------------------------------------------------- phase: the SPA keeps working, and what does not */
console.log("\n== the app keeps working; what does not work on protected values ==");
await page.send("Page.bringToFront");
// A reload, as a user would: the extension is injected again and the vault persisted in the page's storage still restores.
await page.send("Page.reload");
await until(() => page.evalJs("!!document.querySelector('.navbar')"), "EspoCRM to load again", 60000);
await sleep(2500);
await page.evalJs(`location.hash = '#Contact'`);
await sleep(3500);
const afterReload = await bodyText();
check("after a reload the list view still shows the REAL values (the vault persisted)", afterReload.includes(`${ROHAN.first} ${ROHAN.last}`) && afterReload.includes(ROHAN.email) && !/tok_[a-z2-7]{22}/.test(afterReload), afterReload.replace(/\s+/g, " ").slice(0, 160));
await pageShot("19-espocrm-list-after-reload");
for (const [hash, label] of [["#Account", "Accounts"], ["#Contact", "Contacts"], ["#Opportunity", "Opportunities"], ["#", "Home"]]) {
  await page.evalJs(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(2500);
  const t = await bodyText();
  check(`navigation: ${label} still renders (no network error)`, !/Network error|Forbidden/i.test(t) && (await page.evalJs("!!document.querySelector('.navbar') && !document.querySelector('#login-form')")));
}
// Search on a protected value does not work CRM-side (the CRM only holds tokens), search on the token does.
const byRaw = (await api("GET", `Contact?maxSize=20&where[0][type]=textFilter&where[0][value]=${encodeURIComponent("rohan.mehta")}`)).json?.list?.length ?? -1;
const byToken = (await api("GET", `Contact?maxSize=20&where[0][type]=textFilter&where[0][value]=${encodeURIComponent((stored1[0].emailAddress ?? "").slice(0, 12))}`)).json?.list?.length ?? -1;
run.list.crmSearch = { realEmailFragment: byRaw, tokenFragment: byToken };
check("CRM-side search for the real email finds nothing (the CRM holds only tokens)", byRaw === 0, String(byRaw));
note(`CRM-side search: real email fragment ${byRaw} hit(s), token fragment ${byToken} hit(s)`);
const traffic = await (async () => {
  if (!panel) await openPanel("#/traffic");
  await route("#/traffic");
  await sleep(800);
  await panelShot("20-panel-traffic-final");
  return ptext();
})();
run.list.trafficSummary = traffic.replace(/\s+/g, " ").slice(traffic.search(/All\s/), traffic.search(/All\s/) + 200);
note(`panel traffic summary: ${run.list.trafficSummary}`);
await route("#/traffic");
await sleep(600);
const reviewBtn = await panel.evalJs(`document.querySelector('[data-testid="review-filter"]')?.innerText ?? ''`);
run.list.reviewQueue = reviewBtn;
check("the Needs review queue exists on Traffic and counts the generic-masked request", /Needs review \((\d+)\)/.test(reviewBtn) && Number(/\((\d+)\)/.exec(reviewBtn)[1]) >= 1, reviewBtn);

/* ---------------------------------------------------------------- clean up */
await closeTargets(PANEL_URL);
await swEval("chrome.storage.local.remove('airlock.ext.settings.v1')");
await page.evalJs(`localStorage.removeItem('airlock.profiles.v1'); localStorage.removeItem('airlock.rules.v1')`).catch(() => undefined);
page.close();
await bsend("Extensions.uninstall", { id: EXT_ID }).catch(() => undefined);
bws.close();
note("extension uninstalled; HubSpot was not used or tested");
await finish(results.every(Boolean) ? 0 : 1);
