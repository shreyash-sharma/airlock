// Captures real footage for the role-based film (run after scripts/demo/setup-crm.mjs, which leaves EspoCRM logged in with the extension on):
//   node scripts/demo/capture-roles.mjs
// 1. creates one synthetic contact through the page (so AIRLOCK masks it on the way out),
// 2. creates the same contact directly through EspoCRM's API (what it stores with no AIRLOCK),
// 3. reads both back from EspoCRM's own REST API (the "outsider" view),
// 4. screenshots EspoCRM's own contact page once per viewer role.
// Everything lands in scripts/out/film/ (gitignored). Nothing here is staged data: every file is a capture or a REST read.
import fs from "node:fs";
import { connect } from "../cdp.mjs";

const CRM = "http://localhost:8080";
const AUTH = "Basic " + Buffer.from("admin:airlock-demo-admin").toString("base64");
const OUT = "scripts/out/film";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, p, body) => {
  const res = await fetch(`${CRM}/api/v1/${p}`, { method, headers: { Authorization: AUTH, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return t.startsWith("{") ? JSON.parse(t) : null;
};
const ROHAN = { firstName: "Rohan", lastName: "Mehta", emailAddress: "rohan.mehta@example.com", addressCity: "Pune", description: "Renewal is at risk; wants a discount" };
const pick = (c) => ({ name: c.name, emailAddress: c.emailAddress, addressCity: c.addressCity, description: c.description });

for (const c of (await api("GET", "Contact?maxSize=200"))?.list ?? []) await api("DELETE", `Contact/${c.id}`);

const page = await connect(CRM);
await page.send("Page.enable");
await page.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

// 2. directly, with no AIRLOCK in the path (server-side call, not through the page)
const plain = await api("POST", "Contact", { ...ROHAN, firstName: "Rohan", lastName: "Mehta (no AIRLOCK)" });
const plainStored = pick(await api("GET", `Contact/${plain.id}`));

// 1. through the page, so the extension protects it
const made = await page.evalJs(`fetch('/api/v1/Contact', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'Authorization': ${JSON.stringify(AUTH)} }, body: ${JSON.stringify(JSON.stringify(ROHAN))} }).then(async r => ({ status: r.status, id: (await r.json()).id }))`);
if (made.status !== 200) throw new Error(`protected create failed: ${made.status}`);
const protectedStored = pick(await api("GET", `Contact/${made.id}`));
fs.mkdirSync("scripts/out/demo", { recursive: true });
fs.writeFileSync("scripts/out/demo/crm-contact-id.txt", String(made.id));
fs.writeFileSync(`${OUT}/rest.json`, JSON.stringify({ typed: ROHAN, withoutAirlock: plainStored, withAirlock: protectedStored }, null, 2));

// 4. EspoCRM's own page, once per viewer role
const base = JSON.parse(await page.evalJs(`localStorage.getItem('airlock.rules.v1') ?? 'null'`)) ?? null;
const rules = (viewer) => JSON.stringify({ version: 1, viewer, destinations: base?.destinations ?? [{ id: "saas-default", match: { kind: "saas" }, approval: "auto", inline: true, defaults: { identifier: "surrogate", contact: "token", financial: "token", free_text: "mask", sensitive_other: "drop", non_sensitive: "allow" } }] });
const seen = {};
for (const role of ["owner", "support", "analyst", "auditor"]) {
  await page.evalJs(`localStorage.setItem('airlock.rules.v1', ${JSON.stringify(rules(role))}); true`);
  await page.send("Page.navigate", { url: `${CRM}/#Contact/view/${made.id}` });
  await sleep(500);
  await page.send("Page.reload");
  await sleep(6000);
  seen[role] = await page.evalJs(`(() => { const t = document.body.innerText; const i = t.indexOf('Name'); return t.slice(i, i + 400).replace(/\\n+/g, ' | '); })()`);
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/crm-${role}.png`, Buffer.from(shot.data, "base64"));
  console.log(role.padEnd(8), seen[role].slice(0, 170));
}
await page.evalJs(`localStorage.setItem('airlock.rules.v1', ${JSON.stringify(rules("owner"))}); true`);
fs.writeFileSync(`${OUT}/seen.json`, JSON.stringify(seen, null, 2));
page.close();
console.log("captured to", OUT);
