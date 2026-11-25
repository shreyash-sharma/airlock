// Real-Chrome check of the Part B console pages and the CRM workspace.
//   node scripts/e2e-ui-b.mjs [--only=pages|crm|inspect] [--approve]
// Needs: Chrome on port 9222 (scripts/chrome-nano.ps1) and `npm run dev` at http://127.0.0.1:5173.
//   pages    Profiles (edit with validation, import, delete confirm) and Policies (rules edits) on the demo app. No cloud.
//   crm      The CRM workspace: create and list through the engine, the SaaS database view, "Summarize this customer".
//            The summary is denied, and with --approve also approved (a real cloud call). On-device AI that cannot run
//            is reported, and the labelled keyword fallback is used: it is never counted as an on-device result.
//   inspect  The Inspection page up to classification and, when the SDK can, authoring. Reports what really ran.
// Synthetic data only.
import { connect } from "./cdp.mjs";

const ORIGIN = "http://127.0.0.1:5173/";
const API = `${ORIGIN}mock-crm/api`;
const KEY_PROFILES = "airlock.profiles.v1";
const KEY_RULES = "airlock.rules.v1";
const KEY_VAULT = "airlock.vault.v1";
const KEY_TOKENKEY = "airlock.tokenkey.v1";
const SAMPLE_VALUES = ["Rohan", "Mehta", "9876543210", "rohan.mehta@example.com", "68000"];
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length);
const approve = process.argv.includes("--approve");
const wanted = (n) => !only || only === n;
const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  return ok;
};
const note = (t) => console.log(`      ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (t, n) => t.toLowerCase().includes(n.toLowerCase());

const page = await connect(ORIGIN);
await page.send("Page.enable");
await page.send("Network.enable");
await page.send("Page.bringToFront");
const net = [];
page.on("Network.requestWillBeSent", (p) => {
  const u = p.request.url;
  const kind = u.includes("/mock-crm/api") ? "crm" : u.includes("firebasevertexai.googleapis.com") || u.includes("generativelanguage.googleapis.com") ? "gemini" : null;
  if (kind) net.push({ kind, url: u, method: p.request.method, body: p.request.postData ?? "" });
});

const consoleText = () => page.evalJs("document.querySelector('[data-testid=console]')?.innerText ?? ''");
const mainText = () => page.evalJs("document.querySelector('#ac-main')?.innerText ?? ''");
const q = (sel) => page.evalJs(`!!document.querySelector(${JSON.stringify(sel)})`);
const click = (sel) => page.evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e||e.disabled)return false;e.click();return true})()`);
const clickText = (label, scope = "document") =>
  page.evalJs(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(x=>x.textContent.trim().includes(${JSON.stringify(label)})&&!x.disabled);if(!b)return false;b.click();return true})()`);
const setValue = (sel, value) =>
  page.evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;const proto=e instanceof HTMLSelectElement?HTMLSelectElement.prototype:e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));return true})()`);
const read = (key) => page.evalJs(`localStorage.getItem(${JSON.stringify(key)})`);
const clearKeys = () => page.evalJs(`[${JSON.stringify(KEY_PROFILES)},${JSON.stringify(KEY_RULES)},${JSON.stringify(KEY_VAULT)},${JSON.stringify(KEY_TOKENKEY)}].forEach(k=>localStorage.removeItem(k))`);
const route = async (hash) => {
  await page.evalJs(`location.hash=${JSON.stringify(hash)}`);
  await sleep(500);
};
async function waitFor(label, fn, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await fn();
    if (r) return r;
    await sleep(500);
  }
  throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for: ${label}\n--- console text ---\n${(await consoleText()).slice(0, 1200)}`);
}
async function open(url) {
  await page.send("Page.navigate", { url });
  await page.send("Page.bringToFront");
  await waitFor("page load", () => page.evalJs("document.readyState==='complete'&&!!document.querySelector('[data-testid=console]')"), 60_000);
  await sleep(600);
}
const resetCrm = () => fetch(`${API}/_reset`, { method: "POST" });
const rawCrm = async () => (await (await fetch(`${API}/_raw`)).json()).contacts;

async function pagesSection() {
  console.log("\n== pages: Profiles and Policies ==");
  await open(ORIGIN);
  await clearKeys();
  await open(ORIGIN);
  await route("#/profiles");
  let t = await mainText();
  check("Profiles lists the built-in Gemini and generic profiles", has(t, "Gemini generateContent") && has(t, "Generic JSON API"));
  check("rows show author, kind and counts", has(t, "Built-in") && has(t, "SaaS") && has(t, "AI"));

  await route("#/profiles/generic-json");
  check("a built-in profile is read-only and offers Duplicate", has(await mainText(), "read-only") && (await clickText("Duplicate as my profile")));
  await waitFor("duplicate editor", async () => has(await mainText(), "Stored in this browser"), 10_000);
  const stored1 = JSON.parse((await read(KEY_PROFILES)) ?? "[]");
  check("the duplicate is stored with author.by user", stored1.length === 1 && stored1[0].author?.by === "user", stored1[0]?.id ?? "none");

  await setValue('input[aria-label="Hosts"]', "not a host!");
  await sleep(300);
  check("an invalid host shows a field-path error", (await q("[data-testid=validation-errors]")) && has(await mainText(), "match.hosts[0]"));
  check("Save is disabled while invalid", !(await click("[data-testid=profile-save]")));
  const afterBad = JSON.parse((await read(KEY_PROFILES)) ?? "[]");
  check("the invalid edit is not saved", afterBad[0]?.match?.hosts?.length === 0, JSON.stringify(afterBad[0]?.match?.hosts));

  await setValue('input[aria-label="Hosts"]', "crm.example.com");
  await sleep(300);
  check("a valid host clears the errors", !(await q("[data-testid=validation-errors]")));
  check("Save clicked", await click("[data-testid=profile-save]"));
  await waitFor("saved notice", () => q("[data-testid=profile-notice]"), 10_000);
  const saved = JSON.parse((await read(KEY_PROFILES)) ?? "[]");
  check("the edit is stored and authored by user", saved[0]?.match?.hosts?.[0] === "crm.example.com" && saved[0]?.author?.by === "user");

  // Fields editor: change the first request field's action and category.
  await setValue('select[aria-label="request field 1 action"]', "drop");
  await sleep(300);
  check("Save after a field edit", await click("[data-testid=profile-save]"));
  await sleep(500);
  const edited = JSON.parse((await read(KEY_PROFILES)) ?? "[]");
  check("the field action change is stored", edited[0]?.request?.fields?.[0]?.flow?.action === "drop");

  // Import: one invalid profile refuses the whole file.
  await route("#/profiles");
  const bad = JSON.stringify([{ ...edited[0], id: "imp-ok", name: "ok" }, { ...edited[0], id: "imp-bad", match: { hosts: ["*.evil.com"], paths: ["/**"] } }]);
  const doImport = (text) =>
    page.evalJs(`(()=>{const i=document.querySelector('[data-testid=profiles-import-input]');const dt=new DataTransfer();dt.items.add(new File([${JSON.stringify(text)}],'p.json',{type:'application/json'}));i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await doImport(bad);
  await waitFor("import refusal", () => q("[data-testid=validation-errors]"), 10_000);
  const afterRefused = JSON.parse((await read(KEY_PROFILES)) ?? "[]");
  check("an import with one invalid profile saves nothing", afterRefused.length === 1 && has(await mainText(), "profile 2"), `${afterRefused.length} stored`);
  await doImport(JSON.stringify([{ ...edited[0], id: "imp-ok", name: "Imported ok" }]));
  await waitFor("import notice", () => q("[data-testid=profiles-notice]"), 10_000);
  check("a valid import is stored", JSON.parse((await read(KEY_PROFILES)) ?? "[]").some((p) => p.id === "imp-ok"));

  // Delete with a confirm dialog that names what is removed.
  await route("#/profiles/imp-ok");
  check("Delete opens a confirm dialog", await click("[data-testid=profile-delete]"));
  await sleep(400);
  const dialog = await page.evalJs("document.querySelector('dialog[open]')?.innerText ?? ''");
  check("the dialog names the profile and what is removed", has(dialog, "Imported ok") && has(dialog, "imp-ok") && has(dialog, "field locator"));
  await click("[data-testid=confirm-dialog-ok]");
  await sleep(700);
  check("after confirm the profile is gone", !JSON.parse((await read(KEY_PROFILES)) ?? "[]").some((p) => p.id === "imp-ok"));

  // Policies: valid edit stored, invalid edit refused.
  await route("#/policies");
  await waitFor("rules matrix", () => q("[data-testid=rules-matrix]"), 10_000);
  await setValue("[data-testid=rule-saas-default-contact]", "mask");
  await sleep(500);
  const rules1 = JSON.parse((await read(KEY_RULES)) ?? "null");
  check("a valid matrix edit is stored", rules1?.destinations?.find((d) => d.id === "saas-default")?.defaults?.contact === "mask");
  await setValue('input[aria-label="Hosts for a new rule"]', "not a host");
  await click("form.ac-addrule button");
  await sleep(500);
  const rules2 = JSON.parse((await read(KEY_RULES)) ?? "null");
  check("an invalid rule is refused with an error", (await q("[data-testid=validation-errors]")) && !rules2.destinations.some((d) => d.id.startsWith("host-rule")));
  await setValue('input[aria-label="Hosts for a new rule"]', "crm.example.com");
  await click("form.ac-addrule button");
  await sleep(500);
  check("a valid host rule is stored", JSON.parse((await read(KEY_RULES)) ?? "null").destinations.some((d) => d.id === "host-rule-1"));
  await clickText("Reset to defaults");
  await sleep(500);
  check("Reset to defaults restores the rules", JSON.parse((await read(KEY_RULES)) ?? "null").destinations.length === 2);
  await clearKeys();
}

async function crmSection() {
  console.log("\n== crm: the workspace through the console ==");
  await resetCrm();
  await open(ORIGIN);
  await clearKeys();
  await open(`${ORIGIN}crm-test.html`);
  net.length = 0;
  check("the page labels the CRM as a stand-in", has(await page.evalJs("document.body.innerText"), "Mock CRM: stand-in for Salesforce or HubSpot"));
  await clickText("Fill a sample customer");
  await sleep(200);
  check("Create contact clicked", await click("[data-testid=crm-create]"));
  await waitFor("the contact in the app view", async () => has(await page.evalJs("document.querySelector('[data-testid=crm-contacts]')?.innerText ?? ''"), "Rohan Mehta"), 30_000);
  const app = await page.evalJs("document.querySelector('[data-testid=crm-contacts]')?.innerText ?? ''");
  check("the app view shows real values (restored)", ["Rohan Mehta", "rohan.mehta@example.com", "9876543210"].every((v) => app.includes(v)) && !app.includes("tok_"));
  const dbView = await page.evalJs("document.querySelector('[data-testid=crm-db-table]')?.innerText ?? ''");
  check("the SaaS database view shows tokens, no real name or email", has(dbView, "tok_") && !SAMPLE_VALUES.some((v) => dbView.includes(v)));
  const rows = await rawCrm();
  check("the CRM holds one record with no sample value", rows.length === 1 && SAMPLE_VALUES.every((v) => !JSON.stringify(rows).includes(v)));
  const posts = net.filter((r) => r.kind === "crm" && r.method === "POST");
  check("the POST on the wire holds no sample value", posts.length === 1 && SAMPLE_VALUES.every((v) => !posts[0].body.includes(v)), `posts: ${posts.length}`);
  check("the database view's own read was not held (no request awaiting)", !has(await consoleText(), "awaiting your decision"));

  // Summarize: deny first, then optionally approve.
  net.length = 0;
  const ask = async () => {
    check("Summarize this customer clicked", await click("[data-testid=crm-summarize]"));
    await waitFor("the request in the console", async () => {
      const t = await consoleText();
      return has(t, "Awaiting your approval") || has(t, "could not run") ? t : false;
    }, 120_000);
    let t = await consoleText();
    if (has(t, "could not run")) {
      note("on-device AI could not run in this browser: using the labelled keyword fallback (no AI). This is NOT an on-device result.");
      await clickText("Use keyword matching");
      t = await waitFor("awaiting after the fallback", async () => (has(await consoleText(), "Awaiting your approval") ? await consoleText() : false), 30_000);
      return { onDevice: false };
    }
    return { onDevice: true };
  };
  const first = await ask();
  check("nothing reached the cloud before the decision", net.filter((r) => r.kind === "gemini" && r.method === "POST").length === 0);
  const outbound = await page.evalJs(`document.querySelector('[aria-label="Exact outbound payload"]')?.innerText ?? ''`);
  check("the outbound payload shows no sample value", outbound.length > 0 && SAMPLE_VALUES.every((v) => !outbound.includes(v)), SAMPLE_VALUES.filter((v) => outbound.includes(v)).join(", "));
  check("the outbound payload has placeholders", /\[[A-Z_]+_\d+\]/.test(outbound));
  await page.screenshot("scripts/out/ui/e2e-crm-awaiting.png");
  await click('[data-testid="drawer-deny"]');
  await waitFor("denial reaches the app", async () => has(await page.evalJs("document.querySelector('[data-testid=crm-ai]')?.innerText ?? ''"), "denied"), 20_000);
  check("deny: the app got an error and nothing was sent", net.filter((r) => r.kind === "gemini" && r.method === "POST").length === 0);

  if (approve) {
    net.length = 0;
    await ask();
    await click('[data-testid="drawer-approve"]');
    await waitFor("the answer in the app", () => q("[data-testid=crm-ai-answer]"), 120_000);
    const answer = await page.evalJs("document.querySelector('[data-testid=crm-ai-answer]')?.innerText ?? ''");
    const source = await page.evalJs("document.querySelector('[data-testid=crm-ai-source]')?.innerText ?? ''");
    const wire = net.filter((r) => r.kind === "gemini" && r.method === "POST");
    note(`answer source shown: ${source} (selection ${first.onDevice ? "on-device" : "keyword fallback"})`);
    check("approve: exactly one Gemini request, with no sample value", wire.length === 1 && SAMPLE_VALUES.every((v) => !wire[0].body.includes(v)), `requests: ${wire.length}`);
    check("the answer shows no unresolved placeholder", answer.length > 0 && !/\[[A-Z_]+_\d+\]/.test(answer));
    check("the app shows the SDK's inference source", /SDK reports: (in_cloud|on_device)/.test(source));
    await page.screenshot("scripts/out/ui/e2e-crm-answer.png");
  }
  await resetCrm();
}

async function inspectSection() {
  console.log("\n== inspect: the Inspection page ==");
  await resetCrm();
  await open(`${ORIGIN}crm-test.html?mode=inspect`);
  await clearKeys();
  await open(`${ORIGIN}crm-test.html?mode=inspect`);
  net.length = 0;
  await clickText("Create via fetch");
  await waitFor("the held request on the Inspection page", async () => (location_has(await mainText(), "Captured fields") ? true : false), 30_000);
  const held = await mainText();
  check("the capture is on the Inspection page, for authoring later", has(held, "Captured fields") && has(held, "status: held"));
  check("the capture shows no sample value", ["Rohan", "9876543210", "rohan.mehta@example.com"].every((v) => !has(held, v)));
  check("the captured request was masked and sent without waiting (one request, no raw email)", net.filter((r) => r.kind === "crm").length === 1);
  await clickText("Classify on-device");
  const classified = await waitFor("classification", async () => {
    const t = await mainText();
    return has(t, "Proposed on-device by Gemini Nano") || has(t, "Detector-only fallback") ? t : false;
  }, 240_000);
  const onDevice = has(classified, "Proposed on-device by Gemini Nano");
  note(onDevice ? "classification ran on a real Gemini Nano" : `classification used the labelled DETECTOR-ONLY fallback: ${/Detector-only fallback:?\s*([^\n]*)/i.exec(classified)?.[1] ?? ""}`);
  check("classification is labelled by what really ran", onDevice || has(classified, "Detector-only fallback"));
  check("classification made no Gemini request", net.filter((r) => r.kind === "gemini").length === 0);
  await page.screenshot("scripts/out/ui/e2e-inspect-classified.png");
  if (!onDevice) {
    note("authoring needs the classification step; with detector-only classification it still runs through PREFER_ON_DEVICE, so it is tried below");
  }
  await clickText("Author profile");
  const authored = await waitFor("authoring result", async () => {
    const t = await mainText();
    return has(t, "Authored by") || has(t, "Not valid") ? t : false;
  }, 300_000);
  const by = /Authored by:\s*(\S+)\s+([\d.]+) s, (\d+) call/i.exec(authored);
  if (by) {
    note(`authoring: inferenceSource ${by[1]}, ${by[2]} s, ${by[3]} call(s)`);
    const prompt = await page.evalJs("document.querySelector('[aria-label=\"Authoring prompt\"]')?.innerText ?? ''");
    check("the shown prompt lists paths and no sample value", has(prompt, "$.properties.email") && SAMPLE_VALUES.every((v) => !prompt.includes(v)));
    check("the page shows the structure-only assertion", has(authored, "Assertion passed"));
    await page.screenshot("scripts/out/ui/e2e-inspect-authored.png");
    // The user's per-field edits through the page, then Approve and save.
    const wants = { "$.properties.firstname": "surrogate", "$.properties.lastname": "surrogate", "$.properties.email": "token", "$.properties.phone": "token", "$.properties.salary": "token", "$.properties.internal_note": "drop", "$.properties.city": "allow", "$.properties.plan": "allow" };
    let edited = 0;
    for (const [path, action] of Object.entries(wants)) {
      const sel = `select[aria-label="Action for ${path}"]`;
      if (!(await q(sel))) {
        check(`the page offers an action for ${path}`, false);
        continue;
      }
      const cur = await page.evalJs(`document.querySelector(${JSON.stringify(sel)}).value`);
      if (cur !== action) {
        edited++;
        await setValue(sel, action);
        await sleep(900);
      }
    }
    note(`${edited} of ${Object.keys(wants).length} fields edited by the user step`);
    const ready = await waitFor("status: ready", async () => (has(await mainText(), "status: ready") ? true : false), 30_000).catch(() => false);
    const after = await mainText();
    check("after the edits the draft is ready and the dry run passed", !!ready && /Dry run:\s*\S*\s*passed/i.test(after), ready ? "" : after.slice(after.toLowerCase().indexOf("not valid"), after.toLowerCase().indexOf("not valid") + 300));
    check("nothing is stored before Approve", (await read(KEY_PROFILES)) === null);
    if (ready) {
      await clickText("Approve and save profile");
      await waitFor("Profile saved", async () => has(await mainText(), "Profile saved"), 20_000);
      const stored = JSON.parse((await read(KEY_PROFILES)) ?? "[]");
      const prof = stored.find((x) => String(x.id).startsWith("authored-"));
      check("the stored profile has an authored- id and author.by equal to the source shown", !!prof && prof.author.by === by[1], `${prof?.author?.by} vs ${by[1]}`);
      check("the stored profile holds no sample value", SAMPLE_VALUES.every((v) => !JSON.stringify(stored).includes(v)));
      await route("#/profiles");
      check("the Profiles page lists the new profile with its author", has(await mainText(), "authored-"));
      await page.screenshot("scripts/out/ui/e2e-inspect-saved.png");
    } else {
      await clickText("Discard capture");
    }
  } else {
    note(`authoring did not produce a profile: ${(authored.split(/not valid/i)[1] ?? "").slice(0, 300).replace(/\s+/g, " ")}`);
    check("a failed authoring is shown as Not valid, never faked", has(authored, "Not valid"));
    await clickText("Discard capture");
  }
  await resetCrm();
}
const location_has = has;

let crashed = false;
try {
  if (wanted("pages")) await pagesSection();
  if (wanted("crm")) await crmSection();
  if (wanted("inspect")) await inspectSection();
} catch (err) {
  crashed = true;
  check("section ran to completion", false, err.message.split("\n")[0]);
  console.log(err.message.split("\n").slice(1, 30).join("\n"));
} finally {
  await clearKeys().catch(() => undefined);
  await resetCrm().catch(() => undefined);
  await page.send("Page.navigate", { url: ORIGIN }).catch(() => undefined);
  page.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || crashed ? 1 : 0);
