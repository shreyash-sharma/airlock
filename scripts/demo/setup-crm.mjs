// Prepares the real-machine CRM demo (not recorded): loads the extension into the dedicated Chrome profile, adds the
// host through the extension's own Hosts page, signs in to EspoCRM, seeds the profile that Gemini Nano authored in an
// earlier real run (scripts/out/espocrm/authored-profile.json, still labelled with its real author), empties the CRM and
// opens the new-Contact form. Writes scripts/out/demo/crm-state.json for the recorder.
//   node scripts/build-ext.mjs --out dist-ext-espo --test-host "http://localhost:8080/*"   (first)
//   node scripts/demo/setup-crm.mjs
import fs from "node:fs";
import path from "node:path";
import { connect } from "../cdp.mjs";

const PORT = process.env.CDP_PORT ?? "9222";
const CRM = "http://localhost:8080";
const AUTH = "Basic " + Buffer.from("admin:airlock-demo-admin").toString("base64");
const EXT_DIR = path.resolve("dist-ext-espo").replace(/\\/g, "/");
const EXT_ID = "ombmjhkmnofdcbfafhjcnppjdkalekan";
const PANEL = `chrome-extension://${EXT_ID}/sidepanel.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profileFile = "scripts/out/espocrm/authored-profile.json";
if (!fs.existsSync(profileFile)) throw new Error(`${profileFile} is missing: run scripts/e2e-espocrm.mjs once so Nano authors a profile on this machine`);
const profile = JSON.parse(fs.readFileSync(profileFile, "utf8"));
if (profile.author?.by !== "on_device" && profile.author?.by !== "in_cloud") throw new Error("the saved profile has no real inferenceSource author");

const api = async (method, p, body) => {
  const res = await fetch(`${CRM}/api/v1/${p}`, { method, headers: { Authorization: AUTH, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return text.startsWith("{") ? JSON.parse(text) : null;
};
for (const c of (await api("GET", "Contact?maxSize=200"))?.list ?? []) await api("DELETE", `Contact/${c.id}`);

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (bws.onopen = r));
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
const bsend = (method, params = {}, sessionId) => new Promise((resolve, reject) => ((bpend.set(++bid, { resolve, reject })), bws.send(JSON.stringify({ id: bid, method, params, sessionId }))));
const closeTargets = async (prefix) => {
  for (const t of await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) if (t.type === "page" && t.url.startsWith(prefix)) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
};

await closeTargets(PANEL);
await closeTargets(CRM);
await bsend("Extensions.uninstall", { id: EXT_ID }).catch(() => undefined);
const loaded = await bsend("Extensions.loadUnpacked", { path: EXT_DIR });
if (loaded.id !== EXT_ID) throw new Error(`unexpected extension id ${loaded.id}`);
await sleep(1500);
const sw = (await bsend("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXT_ID}/`));
const { sessionId } = await bsend("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
const swEval = async (expression) => (await bsend("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
await swEval(`chrome.storage.local.set({ 'airlock.ext.settings.v1': { holdTimeoutMs: 300000 } })`);
await swEval(`chrome.storage.local.set({ 'airlock.ext.hosts.v1': [] })`);

await bsend("Target.createTarget", { url: `${CRM}/robots.txt` });
await sleep(1500);
const page = await connect(CRM);
page.on("Page.javascriptDialogOpening", () => void page.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined));
await page.send("Page.enable");
await page.send("Network.enable");
for (const c of (await page.send("Network.getCookies", { urls: [CRM] })).cookies) await page.send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path });
await page.evalJs("localStorage.clear(); sessionStorage.clear(); true");
const tabId = Number(await swEval(`chrome.tabs.query({ url: '${CRM}/*' }).then((t) => t.at(-1).id)`));

// Add the host through the extension's own Hosts page.
await bsend("Target.createTarget", { url: `${PANEL}?tab=${tabId}#/hosts` });
await sleep(1500);
const panel = await connect(`${PANEL}?tab=${tabId}`);
await panel.send("Page.enable");
const until = async (fn, label, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timed out: ${label}`);
};
await until(() => panel.evalJs(`!!document.querySelector('[data-testid="host-input"]')`), "the Hosts page");
await panel.evalJs(`(() => { const e = document.querySelector('[data-testid="host-input"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, 'localhost:8080'); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await sleep(200);
await panel.evalJs(`document.querySelector('[data-testid="host-add"]').click()`);
await until(async () => (await swEval("chrome.storage.local.get('airlock.ext.hosts.v1').then((v) => JSON.stringify(v['airlock.ext.hosts.v1'] ?? []))")).includes("localhost:8080"), "the host to be stored");
panel.close();
await closeTargets(PANEL);

// Sign in on EspoCRM's own page, then seed the profile into this origin before any contact is created.
await page.send("Page.navigate", { url: `${CRM}/robots.txt` });
await sleep(1500);
await page.evalJs(`localStorage.setItem('airlock.profiles.v1', ${JSON.stringify(JSON.stringify([profile]))}); true`);
await page.send("Page.navigate", { url: `${CRM}/` });
await sleep(1500);
const type = (sel, text) => page.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(text)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await until(() => page.evalJs("!!document.querySelector('#field-userName')"), "the login form", 30000);
await type("#field-userName", "admin");
await type("#field-password", "airlock-demo-admin");
await page.evalJs(`document.querySelector('#btn-login').click()`);
await until(() => page.evalJs("!!document.querySelector('.navbar')"), "EspoCRM to log in", 60000);
await sleep(3000);
await page.evalJs(`location.hash = '#Contact/create'`);
await until(() => page.evalJs(`!!document.querySelector('input[data-name="firstName"]')`), "the Contact form", 30000);
fs.mkdirSync("scripts/out/demo", { recursive: true });
fs.writeFileSync("scripts/out/demo/crm-state.json", JSON.stringify({ tabId, extId: EXT_ID, profileAuthor: profile.author.by }));
console.log(`ready: EspoCRM new-Contact form open, tab ${tabId}, profile authored by ${profile.author.by}`);
page.close();
bws.close();
