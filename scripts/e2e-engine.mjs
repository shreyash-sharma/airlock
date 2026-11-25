// Real-Chrome proof of the profile-driven engine against the labelled mock CRM (a stand-in for Salesforce or HubSpot).
//   node scripts/e2e-engine.mjs [--only=author|protect|block] [--author-cloud]
//   --author-cloud  author section only: overrides the browser's "is the on-device model available?" answer for the
//                   authoring call, so the real PREFER_ON_DEVICE model takes its real cloud fallback. It is printed as
//                   SIMULATED, and the check fails if the answer still came from on_device.
// Needs: Chrome with Gemini Nano on port 9222 (scripts/chrome-nano.ps1) and `npm run dev` at http://127.0.0.1:5173.
// Default run order: block, author, protect, then cleanup. Nothing here fakes or assumes an on-device result: a
// classification or authoring that falls back is reported as FAIL with its reason. Synthetic data only.
import { connect } from "./cdp.mjs";

const ORIGIN = "http://127.0.0.1:5173/";
const PAGE = (mode) => `${ORIGIN}crm-test.html?mode=${mode}`;
const API = `${ORIGIN}mock-crm/api`;
const KEY_PROFILES = "airlock.profiles.v1";
const KEY_VAULT = "airlock.vault.v1";
const KEY_TOKENKEY = "airlock.tokenkey.v1";
const SAMPLE_VALUES = ["Rohan", "Mehta", "9876543210", "rohan.mehta@example.com", "68000", "Renewal is at risk"];
const NANO_WAIT_MS = 240_000;

const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length);
if (only && !["author", "protect", "block"].includes(only)) {
  console.log(`unknown --only=${only} (use author, protect or block)`);
  process.exit(2);
}
const wanted = (name) => !only || only === name;
// --author-cloud: also prove the cloud fallback of authoring (see authorSection). Off by default: the default run never simulates anything.
const cloudAuthoring = process.argv.includes("--author-cloud");

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  return ok;
};
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = await connect(ORIGIN);
await page.send("Page.enable");
await page.send("Network.enable");
await page.send("Page.bringToFront");

// Every request the page makes to the CRM or to a Gemini host, with its body, captured independently of AIRLOCK.
const net = [];
page.on("Network.requestWillBeSent", (p) => {
  const url = p.request.url;
  const kind = url.includes("/mock-crm/api") ? "crm" : url.includes("firebasevertexai.googleapis.com") || url.includes("generativelanguage.googleapis.com") ? "gemini" : null;
  if (kind) net.push({ kind, url, method: p.request.method, body: p.request.postData ?? "" });
});
const crmRequests = () => net.filter((r) => r.kind === "crm");
const geminiRequests = () => net.filter((r) => r.kind === "gemini" && r.method === "POST");

async function waitFor(label, fn, ms = 30_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await sleep(1000);
  }
  const text = await rootText().catch(() => "");
  throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for: ${label}\n--- console text ---\n${text.slice(0, 1500)}`);
}

// innerText follows the panel's CSS (small caps become upper case), so every text comparison is case-insensitive.
const has = (text, needle) => text.toLowerCase().includes(needle.toLowerCase());
const rootText = () => page.evalJs("document.querySelector('[data-testid=console]')?.innerText ?? ''");
const route = (hash) => page.evalJs(`location.hash = ${JSON.stringify(hash)}`);
const preText = (id) => page.evalJs(`document.getElementById(${JSON.stringify(id)})?.innerText ?? ''`);
const clickButton = (label) =>
  page.evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().includes(${JSON.stringify(label)})&&!x.disabled);if(!b)return false;b.click();return true})()`);
const clickTab = (prefix) =>
  page.evalJs(`(()=>{const t=[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(prefix)}));if(!t)return false;t.click();return true})()`);
const readKey = (key) => page.evalJs(`localStorage.getItem(${JSON.stringify(key)})`);
const removeKeys = (...keys) => page.evalJs(`${JSON.stringify(keys)}.forEach((k) => localStorage.removeItem(k))`);
const resetCrm = async () => (await fetch(`${API}/_reset`, { method: "POST" })).status;
const rawCrm = async () => (await (await fetch(`${API}/_raw`)).json()).contacts;

async function open(mode) {
  await page.send("Page.navigate", { url: PAGE(mode) });
  await page.send("Page.bringToFront");
  await waitFor("page load", () => page.evalJs("document.readyState === 'complete' && !!document.getElementById('crm-title') && !!document.querySelector('[data-testid=console]')"), 60_000);
  await waitFor("stored profiles loaded", () => page.evalJs("document.getElementById('crm-mode')?.textContent ?? ''"), 10_000);
  await sleep(500);
}

async function setAction(path, action) {
  const was = await page.evalJs(`(()=>{const s=document.querySelector('select[aria-label=${JSON.stringify(`Action for ${path}`)}]');if(!s)return 'missing';const cur=s.value;if(cur===${JSON.stringify(action)})return cur;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(action)});s.dispatchEvent(new Event('change',{bubbles:true}));return cur})()`);
  if (was !== action && was !== "missing") await sleep(700);
  return was;
}

const SAMPLE_PATHS = {
  "$.properties.firstname": "surrogate",
  "$.properties.lastname": "surrogate",
  "$.properties.email": "token",
  "$.properties.phone": "token",
  "$.properties.salary": "token",
  "$.properties.internal_note": "drop",
  "$.properties.city": "allow",
  "$.properties.plan": "allow",
};

async function authorSection() {
  console.log("\n== author: AI-authored profile for the unprofiled mock CRM ==");
  await resetCrm();
  await open("inspect");
  await removeKeys(KEY_PROFILES, KEY_VAULT, KEY_TOKENKEY);
  await open("inspect");
  net.length = 0;

  await page.evalJs("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Create via fetch'));b.click();return true})()");
  const held = await waitFor("the held request in the Inspect tab", async () => {
    const t = await rootText();
    return has(t, "Captured fields") ? t : false;
  });
  check("the create is held for inspection (Inspect tab shows the capture)", has(held, "CAPTURED") && has(held, "status: held"));
  check("capture lists $.properties.email", has(held, "$.properties.email"));
  check("capture shows no sample value (Rohan, 9876543210, the email)", ["Rohan", "9876543210", "rohan.mehta@example.com"].every((v) => !has(held, v)));
  check("the captured request was sent masked at once, not held", crmRequests().length === 1, `requests: ${crmRequests().length}`);

  // Classification: ONLY_ON_DEVICE, real Nano. The first call after a reload can take tens of seconds.
  await clickButton("Classify on-device");
  const classified = await waitFor(
    "classification label",
    async () => {
      const t = await rootText();
      return has(t, "Proposed on-device by Gemini Nano") || has(t, "Detector-only fallback") ? t : false;
    },
    NANO_WAIT_MS,
  );
  const onDevice = has(classified, "Proposed on-device by Gemini Nano");
  const fallback = /Detector-only fallback:?\s*([^\n]*)/i.exec(classified)?.[1] ?? "";
  if (!check('classification label reads "Proposed on-device by Gemini Nano"', onDevice, onDevice ? "" : `FELL BACK: ${fallback || "(no reason shown)"}`)) {
    throw new Error(`on-device classification did not run (${fallback || "no reason"}); not continuing with a detector-only result`);
  }
  const cls = /(\d+) ms, (\d+) call\(s\)/i.exec(classified);
  note(`classification: inferenceSource on_device, ${cls ? `${cls[1]} ms, ${cls[2]} call(s)` : "latency not shown"}`);
  check("classification made no Gemini-host request (real values stayed on this device)", geminiRequests().length === 0, `gemini requests: ${geminiRequests().length}`);

  // Authoring: PREFER_ON_DEVICE with the structure-only prompt.
  if (cloudAuthoring) {
    // Not a fake result: only the browser's answer to "is the on-device model available?" is overridden, so the
    // real PREFER_ON_DEVICE model takes its real cloud fallback and the cloud model really answers.
    note("SIMULATED: LanguageModel.availability is overridden to 'unavailable' for the authoring call, to exercise the real cloud fallback");
    await page.evalJs("(()=>{const L=self.LanguageModel;if(!L)return false;L.availability=async()=>'unavailable';return true})()");
  }
  await clickButton("Author profile");
  const authored = await waitFor(
    "Authored by",
    async () => {
      const t = await rootText();
      return has(t, "Authored by") || has(t, "Not valid") ? t : false;
    },
    NANO_WAIT_MS,
  );
  const by = /Authored by:\s*(\S+)\s+([\d.]+) s, (\d+) call/i.exec(authored);
  if (!check("authoring produced a profile (Authored by shown)", !!by, by ? "" : `errors: ${(await rootText()).split(/not valid/i)[1]?.slice(0, 400) ?? "none shown"}`)) {
    throw new Error("authoring did not produce a profile; see the errors above");
  }
  const source = by[1];
  note(`authoring: inferenceSource ${source}, ${by[2]} s, ${by[3]} call(s)`);
  check("authoring source is on_device or in_cloud, as reported by the SDK", source === "on_device" || source === "in_cloud", source);

  const prompt = await page.evalJs("document.querySelector('[aria-label=\"Authoring prompt\"]')?.innerText ?? ''");
  check("the shown prompt lists the request paths", ["$.properties.firstname", "$.properties.email", "$.properties.salary"].every((p) => has(prompt, p)));
  check("the shown prompt holds no sample value", SAMPLE_VALUES.every((v) => !prompt.toLowerCase().includes(v.toLowerCase())));

  const gemini = geminiRequests();
  if (source === "on_device") {
    check("on-device authoring made no Gemini-host request", gemini.length === 0, `gemini requests: ${gemini.length}`);
  } else {
    check("in-cloud authoring made exactly one Gemini-host request", gemini.length === 1, `gemini requests: ${gemini.length}`);
    check("the cloud authoring request body holds no sample value", gemini.every((r) => SAMPLE_VALUES.every((v) => !r.body.includes(v))));
    // The engine releases the request only when its generationConfig equals the registered one: confirm what the SDK really sent.
    const registered = await page.evalJs("import('/src/firebase.ts').then((m) => JSON.stringify(m.AUTHORING_GENERATION_CONFIG))");
    let sent;
    try {
      sent = JSON.stringify(JSON.parse(gemini[0].body).generationConfig);
    } catch {
      sent = "(unreadable)";
    }
    check("the SDK's cloud request generationConfig equals AUTHORING_GENERATION_CONFIG", sent === registered, sent === registered ? "" : `\n  sent:       ${sent?.slice(0, 300)}\n  registered: ${registered.slice(0, 300)}`);
  }
  if (cloudAuthoring) check("the authoring answer really came from the cloud (not on_device)", source === "in_cloud", source);

  // The user's per-field edits. Nano's classes and flows can be imperfect: apply the intended ones and show what changed.
  let changed = 0;
  for (const [path, want] of Object.entries(SAMPLE_PATHS)) {
    const was = await setAction(path, want);
    if (was === "missing") check(`panel offers an action for ${path}`, false);
    else if (was !== want) {
      changed++;
      note(`edit ${path}: model proposed "${was || "default for its class"}", set to "${want}"`);
    }
  }
  note(changed === 0 ? "the model's proposal needed no edits" : `${changed} of ${Object.keys(SAMPLE_PATHS).length} fields edited by the user step`);
  const ready = await waitFor("status: ready after the edits", async () => (has(await rootText(), "status: ready") ? true : false), 30_000).catch(() => false);
  const afterEdits = await rootText();
  check("after the edits the draft is ready", !!ready, ready ? "" : afterEdits.slice(afterEdits.toLowerCase().indexOf("not valid"), afterEdits.toLowerCase().indexOf("not valid") + 300));
  check("dry run passes", /Dry run:\s*\S*\s*passed/i.test(afterEdits));
  check("nothing is stored before Approve", (await readKey(KEY_PROFILES)) === null);
  check("the request in flight was not held: it already went out masked, once", crmRequests().length === 1 && !/rohan\.mehta@example\.com/i.test(JSON.stringify(await rawCrm())), `requests: ${crmRequests().length}`);

  const approved = await clickButton("Approve and save profile");
  check("Approve and save profile clicked", approved === true);
  await waitFor("Profile saved", async () => (has(await rootText(), "Profile saved") ? true : false), 20_000);
  check("the saved profile applies to future traffic only: the earlier request was not touched or re-sent", crmRequests().length === 1, `requests: ${crmRequests().length}`);

  const stored = JSON.parse((await readKey(KEY_PROFILES)) ?? "[]");
  const profile = stored.find((p) => String(p.id).startsWith("authored-"));
  check('the stored profile has an "authored-" id', !!profile, profile?.id ?? "none");
  check("author.by equals the source shown in the panel", profile?.author?.by === source, `${profile?.author?.by} vs ${source}`);
  check("the stored profile holds no sample value", SAMPLE_VALUES.every((v) => !JSON.stringify(stored).includes(v)));

  // From now on the same create goes through the profile. Start from an empty CRM so the record count is exact.
  await resetCrm();
  net.length = 0;
  await page.evalJs("[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Create via fetch'))?.click()");
  const created = await waitFor("the protected create to finish", async () => {
    const out = await preText("out-fetch");
    const err = await preText("errors");
    return out.includes("HTTP") ? out : err.split("\n").length > 2 ? `ERR ${err}` : false;
  }, 60_000);
  check("the second create succeeds (HTTP 201)", created.includes("HTTP 201"), created.startsWith("ERR") ? created.slice(0, 300) : "");
  const rows = await rawCrm();
  const row = rows[0]?.properties ?? {};
  check("the CRM stored one record", rows.length === 1, `records: ${rows.length}`);
  check("/_raw email is a tok_ token", String(row.email ?? "").startsWith("tok_"), String(row.email ?? "").slice(0, 12));
  check("/_raw phone is a tok_ token", String(row.phone ?? "").startsWith("tok_"));
  check("/_raw salary is a tok_ token", String(row.salary ?? "").startsWith("tok_"));
  check("/_raw first name is a surrogate, not Rohan", !!row.firstname && row.firstname !== "Rohan", String(row.firstname ?? ""));
  check("/_raw last name is a surrogate, not Mehta", !!row.lastname && row.lastname !== "Mehta", String(row.lastname ?? ""));
  check("/_raw has no internal_note", !("internal_note" in row));
  check("/_raw keeps city Pune and plan Enterprise", row.city === "Pune" && row.plan === "Enterprise");
  const wire = crmRequests().filter((r) => r.method === "POST");
  check("exactly one CRM request left the page, and its body holds no sample value", wire.length === 1 && SAMPLE_VALUES.every((v) => !wire[0].body.includes(v)), `requests: ${wire.length}`);
}

const clickPage = (label) => page.evalJs(`[...document.querySelectorAll('button.h-btn')].find(x=>x.textContent.trim()===${JSON.stringify(label)})?.click()`);

async function protectSection() {
  console.log("\n== protect: the authored profile enforced on fetch and XHR, lists restored, across a reload ==");
  await open("inspect");
  const stored = JSON.parse((await readKey(KEY_PROFILES)) ?? "[]");
  const profile = stored.find((p) => String(p.id).startsWith("authored-"));
  if (!check("an authored profile is stored (run the author section first)", !!profile)) return;

  // A capture holds the create request only, so authoring cannot know how the CRM shapes a list answer or whether
  // GET is covered. This is the user's edit of the stored profile JSON (profiles are plain editable JSON): any method
  // matches, and the answer locators for the create echo and the list are declared. The request side stays as authored.
  delete profile.match.methods;
  profile.response.fields = [{ path: "$.results[*].properties" }, { path: "$.properties" }];
  await page.evalJs(`localStorage.setItem(${JSON.stringify(KEY_PROFILES)}, ${JSON.stringify(JSON.stringify(stored))})`);
  note("user edit of the stored profile JSON: any method matches; response locators $.results[*].properties and $.properties added (the capture held no response to author them from)");
  await resetCrm();
  await open("inspect");
  net.length = 0;

  const done = (id, label) => waitFor(`${label} to finish`, async () => ((await preText(id)).includes(`${label} -> HTTP`) ? await preText(id) : false), 60_000);
  await clickPage("Create via fetch");
  const createdFetch = await done("out-fetch", "Create via fetch");
  await clickPage("Create via XHR");
  const createdXhr = await done("out-xhr", "Create via XHR");
  check("create via fetch and via XHR both succeed (HTTP 201)", createdFetch.includes("HTTP 201") && createdXhr.includes("HTTP 201"));
  check("the page sees real values in the create answers (restored)", ["Rohan", "Mehta"].every((v) => createdFetch.includes(v) && createdXhr.includes(v)));

  let rows = await rawCrm();
  check("/_raw has two records (one per transport)", rows.length === 2, `records: ${rows.length}`);
  const email = rows[0]?.properties?.email;
  check("both records hold the same email token", String(email).startsWith("tok_") && rows.every((r) => r.properties.email === email), String(email).slice(0, 12));
  check("both records hold a tok_ salary and phone", rows.every((r) => String(r.properties.salary).startsWith("tok_") && String(r.properties.phone).startsWith("tok_")));
  check("neither record holds a sample value or an internal_note", rows.every((r) => SAMPLE_VALUES.every((v) => !JSON.stringify(r).includes(v)) && !("internal_note" in r.properties)));
  const posts = crmRequests().filter((r) => r.method === "POST");
  check("the two CRM requests on the wire hold no sample value", posts.length === 2 && posts.every((r) => SAMPLE_VALUES.every((v) => !r.body.includes(v))), `requests: ${posts.length}`);

  const listed = async (label, id) => {
    await clickPage(label);
    return done(id, label);
  };
  const shows = (text) => ["Rohan", "Mehta", "9876543210", "rohan.mehta@example.com"].every((v) => text.includes(v)) && !text.includes("tok_");
  check("List via fetch shows Rohan, Mehta, the phone and the email, and no token", shows(await listed("List via fetch", "out-fetch")));
  check("List via XHR shows Rohan, Mehta, the phone and the email, and no token", shows(await listed("List via XHR", "out-xhr")));

  // A reload: the token key, the token index and the surrogates were persisted, not kept only in memory.
  await open("inspect");
  net.length = 0;
  await clickPage("Create via fetch");
  await done("out-fetch", "Create via fetch");
  rows = await rawCrm();
  check("after a reload a third record is stored", rows.length === 3, `records: ${rows.length}`);
  check("the same contact gets the same email token after the reload", rows.length === 3 && rows[2].properties.email === email, String(rows[2]?.properties?.email).slice(0, 12));
  check("the CRM still holds no sample value", rows.every((r) => SAMPLE_VALUES.every((v) => !JSON.stringify(r).includes(v))));
  check("List via fetch after the reload still shows Rohan Mehta", shows(await listed("List via fetch", "out-fetch")));
  check("List via XHR after the reload still shows Rohan Mehta", shows(await listed("List via XHR", "out-xhr")));
  const names = (await rawCrm()).map((r) => `${r.properties.firstname} ${r.properties.lastname}`);
  note(`stored surrogate names: ${[...new Set(names)].join(" | ")}`);
}

async function blockSection() {
  console.log("\n== block: an unprofiled CRM host is masked and sent (never blocked), and a malformed stored profile names its field ==");
  await resetCrm();
  await open("unprofiled");
  await removeKeys(KEY_PROFILES, KEY_VAULT, KEY_TOKENKEY);
  await open("unprofiled");
  net.length = 0;
  await clickPage("Create via fetch");
  await waitFor("the unprofiled create to reach the CRM", async () => ((await rawCrm()).length >= 1 ? true : false), 30_000);
  const stored = JSON.stringify(await rawCrm());
  check("an unprofiled CRM request is NOT blocked: it reached the CRM, masked", crmRequests().length >= 1 && !has(await preText("errors"), "No profile matches"), `requests: ${crmRequests().length}`);
  check("the stored record holds no raw email (replaced inline by a stand-in)", !/rohan\.mehta@example\.com/i.test(stored), stored.slice(0, 120));
  await route("#/traffic");
  await sleep(500);
  await page.evalJs("document.querySelector('[data-testid=traffic-row], .ac-table tbody tr')?.click()");
  await sleep(700);
  const gate = await rootText();
  check("the Traffic page counts it in the Needs review queue", has(gate, "Needs review (1)") || has(gate, "Needs review"), gate.slice(0, 160).replace(/\s+/g, " "));

  const bad = [{ version: 1, id: "bad-hosts", name: "bad", kind: "saas", pipeline: "field-protect", match: { hosts: [42], paths: ["/x"] }, request: { fields: [] }, response: { fields: [] }, author: { by: "user", at: "2026-01-01T00:00:00.000Z" } }];
  await page.evalJs(`localStorage.setItem(${JSON.stringify(KEY_PROFILES)}, ${JSON.stringify(JSON.stringify(bad))})`);
  await open("unprofiled");
  const shown = await waitFor("the profile error on the page", async () => {
    const e = await preText("errors");
    return has(e, "match.hosts") ? e : false;
  }, 30_000);
  check("a malformed stored profile shows an error naming match.hosts", has(shown, "match.hosts"), shown.split("\n")[0].slice(0, 140));
  await removeKeys(KEY_PROFILES);
}

async function cleanup() {
  console.log("\n== cleanup ==");
  try {
    await open("inspect");
    await route("#/policies");
    await sleep(500);
    await clickButton("Clear local data");
    await sleep(500);
  } catch (err) {
    note(`could not click Clear local data: ${err.message.split("\n")[0]}`);
  }
  await removeKeys(KEY_PROFILES, KEY_VAULT, KEY_TOKENKEY).catch(() => undefined);
  await resetCrm().catch(() => undefined);
  const left = await readKey(KEY_PROFILES).catch(() => "unreadable");
  check("no stored profile is left that would put 127.0.0.1:5173 in scope", left === null, String(left).slice(0, 60));
  // Leave the tab as the demo app so scripts that look for it by URL (e2e-loop) find the page they expect.
  await page.send("Page.navigate", { url: ORIGIN });
}

let crashed = false;
try {
  if (wanted("block")) await blockSection();
  if (wanted("author")) await authorSection();
  if (wanted("protect")) await protectSection();
} catch (err) {
  crashed = true;
  check("section ran to completion", false, err.message.split("\n")[0]);
  console.log(err.message.split("\n").slice(1, 40).join("\n"));
} finally {
  await cleanup();
  page.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed || crashed ? 1 : 0);
