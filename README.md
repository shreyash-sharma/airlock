<p align="center"><img src="docs/img/hero.png" alt="AIRLOCK: give cloud AI only what it needs, prove what it received" width="100%"></p>

<p align="center">
<img src="https://img.shields.io/badge/Firebase-AI%20Logic-DD2C00?logo=firebase&logoColor=white" alt="Firebase AI Logic">
<img src="https://img.shields.io/badge/Gemini-Nano%20%2B%20Cloud-8E75B2?logo=googlegemini&logoColor=white" alt="Gemini">
<img src="https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white" alt="Chrome extension">
<img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React">
<img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
<img src="https://img.shields.io/badge/Licence-Apache--2.0-green" alt="Apache-2.0">
</p>

**The cloud only needed the question. We keep giving it the keys.**

AIRLOCK is a data-protection door in your browser, between you and cloud AI and SaaS apps. It finds what is sensitive on your own device with Gemini Nano, lets deterministic code decide what may leave, shows you exactly what goes, and proves what went. The apps you use stay unchanged. Built for Firebase #BuildHybridAI 2026.

## Try it

**Live demo: [airlock-demo.web.app](https://airlock-demo.web.app)**

Best in desktop Chrome with Gemini Nano: load the sample contract, press **Ask Gemini**, read the exact outbound text and approve. Without Nano the page says so and sends nothing unless you choose keyword mode, which uses no AI. The data is synthetic; do not paste real secrets. You can optionally point it at your own Firebase project. The demo covers the document flow; the CRM flow needs the extension (below).

<p align="center"><img src="docs/img/overview.png" alt="System overview" width="100%"></p>

In words: web apps, documents and AI prompts in Chrome pass through AIRLOCK, which intercepts `fetch` and `XMLHttpRequest`, finds sensitive values (Gemini Nano on the device), decides with deterministic rules, protects each field, asks for approval on AI requests and records a SHA-256 and an audit entry. Cloud Gemini receives only approved, minimised text; CRM and SaaS apps receive stand-ins.

## Why it wins

| | |
|---|---|
| **Your apps do not change** | The same engine runs as one `installAirlock()` call or as a Chrome extension on sites you do not control |
| **Your CRM keeps working** | Saves go out at once with stand-ins; your screen still shows the real values |
| **AI sees less and answers just as well** | 15 of 15 answers correct while sending 72% fewer bytes and none of the 10 sensitive values ([how it was measured](docs/EVAL-QUALITY.md)) |
| **Proof, not promises** | The exact outbound payload, its SHA-256 and an audit log of what ran where |
| **One record, many views** | Owner, support, analyst and auditor each see what their role allows |

## See it work

### A real CRM, untouched

| You type | The CRM stores |
|---|---|
| <img src="docs/img/crm-typed.png" alt="Typing a contact into EspoCRM"> | <img src="docs/img/crm-stored.png" alt="Stand-ins as stored by EspoCRM"> |

*EspoCRM, self-hosted, with synthetic data. The two pictures come from different runs, so the typed note and the stand-ins differ run to run.*

<p align="center"><img src="docs/img/crm-flow.png" alt="CRM save flow" width="100%"></p>

In words: a record typed into a CRM form is changed by its profile before it leaves (name and email become surrogates, the note becomes a token, the city is allowed), is sent at once, and the stored stand-ins are turned back into real values in the browser from a local vault.

### A contract and a question

| The document holds a bank account, tax number and key | You approve exactly what goes |
|---|---|
| <img src="docs/img/pdf-secrets.png" alt="Contract PDF with sensitive values" width="620"> | <img src="docs/img/approve.png" alt="Approval panel with the passages Nano chose" width="260"> |

The request Chrome actually sent holds `[IBAN_1]`, not the account:

<img src="docs/img/wire-proof.png" alt="Search of the captured request body finds the placeholder" width="100%">

<p align="center"><img src="docs/img/ai-flow.png" alt="Document request flow" width="100%"></p>

In words: split the document into passages, let Nano pick the ones the task needs, mask values, run the code policy, hold for approval, hash the exact bytes, send, restore the answer, audit.

### One record, three people

| Owner | Support | Auditor |
|---|---|---|
| <img src="docs/img/role-owner.png" alt="Owner view"> | <img src="docs/img/role-support.png" alt="Support view"> | <img src="docs/img/role-auditor.png" alt="Auditor view"> |

**Viewer roles.** Under Policies, *Viewer role* (owner, support, analyst, auditor) decides how much of a restored value each viewer gets back, from one stored record: the owner sees everything as entered; support sees names and cities with emails and phones partly hidden and notes hidden; the analyst sees stand-ins; the auditor sees `[restricted]`. The policy is a plain table in `src/airlock/flows/roles.ts`, stored in the rules as `viewer`. If the rules cannot be read the viewer is the auditor. It is a policy view on one machine, not authentication.

## Firebase AI Logic hybrid inference at the core

<p align="center"><img src="docs/img/hybrid.png" alt="Three hybrid inference modes" width="100%"></p>

The mode is chosen by how sensitive the prompt is. Every AI call shows the SDK's real `response.inferenceSource` (`on_device` or `in_cloud`), its latency and the mode that was requested, in the console and the audit.

| Mode | Used for | Why |
|---|---|---|
| `ONLY_ON_DEVICE` | Classifying the real values of a held request; choosing the passages of a document a task needs | The prompt holds real values, so it must never reach the cloud. A missing local model throws instead of falling back to the cloud. If it cannot run, nothing is sent |
| `PREFER_ON_DEVICE` | Authoring a profile from a **structure-only** prompt (paths, value types, classes, shape previews; never a value) | Code asserts that no captured value is in the prompt before every call. Nano answers when it can; the SDK falls back to cloud Gemini when it cannot, and the saved profile records which one wrote it |
| `ONLY_IN_CLOUD` | The Gemini task in the demo app (`gemini-3.5-flash-lite`) | The task that needs the cloud model, after AIRLOCK has minimized and masked what it sees |

Also used: `initializeDeviceModel()` from a user gesture with model status, **App Check** (reCAPTCHA Enterprise on the hosted demo, the debug provider locally), and a JSON `responseSchema` or constraint on structured on-device calls. The model never decides at request time, its output is never executed (a profile is parsed as data, copied through a whitelist, validated and dry-run), and you approve it before it is saved.

## Where it lives in the code

### Firebase AI Logic

| What | Mode or call | File |
|---|---|---|
| Choose the passages a task needs | `InferenceMode.ONLY_ON_DEVICE`, JSON `responseSchema` | [`src/firebase-models.ts`](src/firebase-models.ts) `getLocalJsonModel`, used by [`src/airlock/ai/local.ts`](src/airlock/ai/local.ts) |
| Classify the real values of a captured request | `ONLY_ON_DEVICE`, `responseConstraint`; any other `inferenceSource` is rejected | [`src/firebase-models.ts`](src/firebase-models.ts) `getLocalClassifierModel`, [`src/airlock/inspect/classify.ts`](src/airlock/inspect/classify.ts) |
| Write a profile from structure only | `PREFER_ON_DEVICE` with cloud fallback | [`src/firebase-models.ts`](src/firebase-models.ts) `getAuthoringModel`, [`src/airlock/inspect/author.ts`](src/airlock/inspect/author.ts) |
| Run the task on the minimised text | `ONLY_IN_CLOUD` | [`src/firebase.ts`](src/firebase.ts) `cloudModel` |
| Prepare the on-device model; App Check | `initializeDeviceModel()`, `initializeAppCheck` | [`src/airlock/ai/local.ts`](src/airlock/ai/local.ts), [`src/firebase.ts`](src/firebase.ts) |

### The guarantees

| Guarantee | Enforced in | Exercised by |
|---|---|---|
| Page requests to in-scope hosts pass through one engine | [`net/guard.ts`](src/airlock/net/guard.ts), [`net/xhr.ts`](src/airlock/net/xhr.ts), [`net/engine.ts`](src/airlock/net/engine.ts) | `net/guard.test.ts`, `net/xhr.test.ts` |
| Code, not a model, decides what may leave | [`core/policy.ts`](src/airlock/core/policy.ts) `checkPolicy`, [`flows/protect.ts`](src/airlock/flows/protect.ts) `rescanOutbound` | `core/core.test.ts`, `flows/flows.test.ts` |
| No captured value reaches the authoring prompt | [`inspect/prompt.ts`](src/airlock/inspect/prompt.ts) `assertStructureOnly` | `inspect/author.test.ts` |
| The hash shown is the hash of what was sent | [`net/engine.ts`](src/airlock/net/engine.ts) `sha256Hex` | `scripts/e2e-loop.mjs` |
| Each role sees only what it is allowed | [`flows/roles.ts`](src/airlock/flows/roles.ts) | `net/roles.test.ts` |
| CRM saves are protected inline | [`flows/inline.ts`](src/airlock/flows/inline.ts) | `net/inline.test.ts`, `scripts/e2e-espocrm.mjs` |

`npm test` runs the unit tests without a browser, a Firebase project or a network connection to either.

## Point it at a new app

<p align="center"><img src="docs/img/authoring.png" alt="Profile authoring flow" width="100%"></p>

In words: capture the shape of a real request, classify it on the device, author a profile from structure only, dry-run it, let the user edit and approve, then enforce it with code. Field actions are `allow`, `mask`, `surrogate`, `token`, `drop` and `block`.

## How a request is handled

1. The page calls a normal API (the Firebase AI Logic SDK, or a CRM's REST endpoint). It contains no AIRLOCK logic beyond one `installAirlock()` call, or nothing at all when the extension is used.
2. AIRLOCK intercepts the real outbound request before it leaves.
3. A **profile** matching the host and path says which request fields matter and what to do with each: `allow`, `mask` (a reversible placeholder such as `[EMAIL_1]`), `surrogate` (a realistic stand-in), `token` (a stable keyed token, not format-preserving), `drop`, or `block`. A residual scan then checks every other string in the body.
4. The destination decides what happens next. There are two modes, set per destination:
   - **AI destination (Gemini): hold for approval.** Nano first picks the passages the task needs and the rest is withheld; a deterministic policy (no model) checks the final text; you see the original beside the exact outbound text and press **Approve** or **Deny**. Deny, a timeout, a closed panel or a failed check sends nothing (fail closed). The approved body is hashed locally, re-scanned and sent.
   - **CRM and SaaS destinations: inline, never blocked or held.** A CRM user must not wait, so the request is masked by the profile (or, where no profile covers it, by the generic detectors) and sent at once. What deserves a human look is recorded as a plain-words reason and shown afterwards in the **Needs review** queue on Traffic. A saved profile applies to future requests only, never to one already in flight.
5. The response is restored with your real values (profile response locators, or the local vault for generic inline masking).
6. The audit records categories and counts, never values, and each AI step shows the SDK-reported `inferenceSource`.

## What is in this repository

| Piece | What it is |
|---|---|
| **Engine** (`src/airlock`) | Profiles, six protection flows, deterministic policy, approval, wire hash, audit, restore; adapters for `fetch` and `XMLHttpRequest`; fail-closed everywhere |
| **Console** (`src/airlock/ui/console`) | A six-page React console designed with Google Stitch: Overview, Traffic, Profiles, Policies, Inspection, Audit, plus a request page showing the original beside the exact outbound payload |
| **Demo apps** | A plain Firebase AI Logic document assistant (`index.html`), a **mock CRM stand-in** (`crm-test.html`, served by the dev server; not a real CRM) and a **real self-hosted EspoCRM** in Docker (`demo/espocrm/`) with an "AI Workspace" that has a **Summarize this customer** action |
| **Chrome extension** (`src/ext`, `npm run build:ext`) | The same engine and console as a Manifest V3 extension with a side panel and a user-managed host list, so it can protect a site that does not install AIRLOCK |
| **Evaluations** | Deterministic masking and policy evaluation, a real-Nano selection evaluation and a real-cloud answer-quality evaluation (see [`docs/LIMITS.md`](docs/LIMITS.md#measured-results-in-full)) |

## Run it

Requirements: Node 22, desktop Chrome 139+, a Firebase project with **AI Logic** enabled (Gemini Developer API provider) and a web app registered.

```powershell
npm install
copy .env.example .env.local   # then fill in your Firebase web config
npm run dev                    # http://127.0.0.1:5173
```

1. In Chrome, set `chrome://flags/#prompt-api-for-gemini-nano` to Enabled and `chrome://flags/#optimization-guide-on-device-model` to Enabled BypassPerfRequirement if your hardware check fails, then relaunch. Click **Prepare on-device AI** in the app to download the model. `scripts/chrome-nano.ps1` starts a dedicated Chrome with remote debugging for the checks below.
2. App Check is enforced. On first load the SDK prints a debug token in the console. Register it in the Firebase console under App Check, Apps, Manage debug tokens. Use the same origin (`127.0.0.1:5173`) each time, because the token is tied to it.
3. Open the app, click **Ask Gemini**, review the held request in the console, and approve.

```powershell
npm test               # 329 unit tests (core, guard, XHR, flows, authoring, hold, mock CRM, evaluation corpus, extension, console models)
npm run eval           # regenerate docs/EVAL.md
npm run eval:nano      # real Nano through the console: needs Chrome from scripts/chrome-nano.ps1 and the dev server
node scripts/eval-quality.mjs                  # answer quality against real cloud Gemini (about 60 calls on the free tier)
node scripts/e2e-loop.mjs [--deny|--attack]    # full loop in real Chrome
node scripts/e2e-pdf.mjs                       # PDF input in real Chrome
node scripts/e2e-engine.mjs [--only=block|author|protect] [--author-cloud]   # profile authoring and enforcement against the mock CRM
npm run e2e:ext                                # the Chrome extension and its side panel in real Chrome
node scripts/e2e-espocrm.mjs                   # the real-CRM proof against self-hosted EspoCRM (see Run the real-CRM demo)
node scripts/tour.mjs                          # a narrated walk through the console, for screen recording
```

To try the profile-driven engine by hand, open `http://127.0.0.1:5173/crm-test.html`. The default mode (`demo`) is the AI Workspace: create a contact (the console shows the protected request), compare the app view with real values against the "SaaS database" view of what the stand-in CRM stores, and press **Summarize this customer** to send the record to Gemini through the approval gate. `?mode=inspect` holds the first unprofiled request on the **Inspection** page: classify on-device, author the profile, adjust each field, approve, then create again. `?mode=unprofiled` shows the fail-closed block.

## Chrome extension

<p align="center"><img src="docs/img/extension.png" alt="Extension architecture" width="100%"></p>

In words: a page script wraps the network calls, a bridge relays over a private port, a background service worker keeps the host list, and the side panel is the only place a decision is made.

The same engine runs as a Manifest V3 extension, so it can protect a site you do not control (a CRM, for example) without that site installing AIRLOCK. It is a side panel: the console in its narrow layout.

```powershell
npm run build:ext          # builds dist-ext/
```

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the `dist-ext` folder. The extension ID is `ombmjhkmnofdcbfafhjcnppjdkalekan` (it follows from the public `key` in the manifest, so it is the same on every machine).
2. Pin the AIRLOCK icon to the toolbar. Clicking it opens the side panel.
3. In the panel, open **Hosts**, type a host name (for example `crm.example.com`, or `*.example.com` for one domain), and press **Add and grant access**. Chrome asks you to allow that host; the extension has no host access until you do. Reload the site's tab.
4. Use the site as usual. CRM and SaaS requests to a listed host are masked and sent at once; the panel shows them in Traffic, with a **Needs review** filter. A host with no saved profile is captured on the **Inspection** page for authoring. A request that waits for your approval (to an AI host) is shown in the panel with the exact outbound body. Every AI step shows the SDK-reported `inferenceSource`, or says it was the regex detectors alone.
5. The panel states which tab it is watching. CRM requests never wait on it, including when it is closed. **For a request that waits for approval (an AI host), a closed panel, another watched tab, or no answer within the hold timeout (120 s by default, 1 to 600 s on the Hosts page) blocks it; nothing is sent.**

### Run the real-CRM demo (self-hosted EspoCRM)

AIRLOCK was run against a real third-party CRM it does not control: **EspoCRM**, open source, self-hosted in Docker on this machine. **HubSpot and Salesforce were not tested.**

1. `docker compose -f demo/espocrm/docker-compose.yml up -d` (about a minute; EspoCRM at `http://localhost:8080`, throwaway demo login `admin` / `airlock-demo-admin`, bound to 127.0.0.1 only; do not reuse those credentials or expose it).
2. `npm run build:ext`, load `dist-ext` as above. In the panel's **Hosts** page add `localhost:8080`.
3. Nothing else to configure: the default SaaS destination is inline, so EspoCRM's dozens of startup requests are masked and sent without a rule.
4. Log in on EspoCRM's own login page, open Contacts, then **Create** a contact (synthetic data) and press Save. The create goes out at once with the email and phone replaced by stand-ins (EspoCRM stores it) and is captured on **Inspection**: classify on-device, author the profile, correct the fields Nano got wrong (use **surrogate**, not **token**, for email and phone: EspoCRM rejects a token as an invalid email), click **Add GET** in the Response locators card, Approve and save. Create the next contact: the saved profile protects names, email, phone and note, again without waiting. EspoCRM stores stand-ins; its own screens show the real values.

`node scripts/e2e-espocrm.mjs` does exactly this through EspoCRM's own UI in real Chrome with real Gemini Nano (build `node scripts/build-ext.mjs --out dist-ext-espo --test-host "http://localhost:8080/*"` first) and writes `scripts/out/espocrm/run.json` and screenshots.

## The console

Six pages, one per question you would ask of a boundary: **Overview** (what is held, sent and blocked), **Traffic** (every request; open one for the original against the exact outbound payload, the policy checks, the wire hash and the restored answer), **Profiles** (view, edit, import and export the JSON), **Policies** (destination rules and what is and is not covered), **Inspection** (hold, classify, author, dry-run, approve a profile for an unprofiled host) and **Audit** (what ran where, and an exportable receipt). The extension adds a **Hosts** page. The look was generated with Google Stitch and re-implemented by hand in plain CSS; every label comes from data and anything unmeasured reads "Not measured". It works full-page, docked beside an app, and in a 420 px Chrome side panel.

## Scope today

AIRLOCK covers the page's own `fetch` and `XMLHttpRequest` traffic. The live CRM test was run on EspoCRM; other CRMs have not been run. It is a strong boundary for what it covers, not a promise of complete privacy. Details, measurements and what was verified: [`docs/LIMITS.md`](docs/LIMITS.md).

## Architecture

Diagrams and design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Licence

Apache-2.0, see [LICENSE](LICENSE). Third-party components are listed in [THIRD_PARTY.md](THIRD_PARTY.md) and [NOTICE](NOTICE).
