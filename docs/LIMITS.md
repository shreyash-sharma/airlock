# Scope, limits and verification

What AIRLOCK does not do, what was and was not verified, and the details behind the claims in the [README](../README.md).

## Honest limits

- AIRLOCK does not promise complete privacy. Detection is pattern-based; names and some addresses are protected only if you list them under "Always protect". **Nano's label quality is imperfect**: always read the exact outbound payload, edit any field action that is wrong, and for an AI destination treat your approval, not the model's classification, as the gate; for a CRM, treat the Needs review queue as an after-the-fact check, not a gate.
- It covers `fetch` and `XMLHttpRequest` made by the page itself. Not `sendBeacon`, WebSocket, EventSource, workers, iframes or form posts. Install before any SDK call: a `fetch` reference captured earlier, or an XHR whose `open()` ran before install, bypasses it.
- The extension limits above apply: page-origin vault, a single watched tab, the page-world handshake race, and the unverified items listed there.
- **One real CRM was tested: self-hosted EspoCRM in Docker** (see above), with one authored profile on one machine. **HubSpot and Salesforce were not tested**, and no claim is made that AIRLOCK works with them. A CRM that validates the format of a value rejects a `token`; use `surrogate` for emails and phone numbers.
- **Response locators are proposed by code, from answers the page really received**, not by the model: containers such as `$.list[*]`, plus `$` for the answer to a write (labelled as not observed). They restore every string below them, which only replaces values AIRLOCK protected. Values at places no proposal reaches come back as stand-ins or tokens. The mock-CRM `e2e-engine.mjs` still adds its locators by editing the profile JSON.
- **CRM traffic is inline, not fail closed.** Requests to a SaaS destination (including GET and HEAD, bodies AIRLOCK cannot inspect, and requests no profile covers) are masked as far as the detectors can and sent; an uninspectable body is sent as it is and flagged for review. Only the AI destination holds for approval and fails closed. If you prefer the strict behavior for a host, set `inline: false` on its destination rule. A cache-busting `?t=<epoch>` URL parameter is the only URL value exempt from masking.
- The Gemini path guards non-streaming text requests. Streaming (`streamGenerateContent`) and non-text parts are **blocked fail-closed**.
- Profiled hosts: the profile protects the JSON body. On an inline destination a sensitive-looking value in the URL query or path is replaced by the generic detectors and the request is sent; on a strict destination it blocks the request.
- The dry run's "restore round trip" for an authored profile checks each protected value against the vault, not the profile's response locators.
- On-device Gemini Nano needs desktop Chrome 139+ with the Prompt API, a capable GPU (or enough RAM and cores) and about 22 GB of free disk for the model. The on-device call has a 9,216-token limit, so documents are processed as clause outlines. PDF input handles text-based PDFs only.
- Nano is not deterministic: its choice is a proposal that code validates, and results differ between runs. **Timing and variation:** the first Nano call after a page reload is slow (22.9 s in the clause-selection eval; 27.5 s in the PDF run recorded for the demo film; 8.9 s and 13.1 s on warm runs), and the number of passages chosen varies between runs on the same document (5, 6 and 7 of 16 were seen). Warm Nano up before a demo.
- To restore answers after a reload, original values are kept in browser storage, unencrypted ("Clear local data" removes them). The audit is in memory and resets when the page closes.
- The answer-quality evaluation is small (see above), measured on one machine, and its cloud model returned HTTP 500 for some prompts during the run.

## Inline mode

**Inline mode and its limit.** Without a profile, inline mode masks only what the deterministic detectors recognise (emails, phone numbers with a country code, keys and similar). It does not recognise personal names or free text, and it does not fail closed: a value the detectors miss reaches the CRM. Emails and phones become realistic same-shape stand-ins (a CRM validates those fields and rejects a bare token); everything else becomes a keyed token held in a local vault. Tokens are reversible substitution from a local index, not encryption. A profile (authored by hybrid inference, then corrected by you) is what protects names and other fields. Strict mode (block unprofiled requests, hold for approval) still exists as a destination setting and is used for the AI destination.

## What it is not

AIRLOCK protects fields on the wire by policy, in line, without changing the application. It is not an enterprise gateway:

- **Browser traffic only.** AIRLOCK wraps the page's own `fetch` and `XMLHttpRequest`. It has no database drivers, no file or message-queue connectors and no network-level proxy.
- **Tokens are not format-preserving.** `token` is stable keyed tokenization (`tok_` plus 22 base32 characters from an HMAC-SHA-256 under a per-browser key) with a local reverse index, so the same value always gives the same token and answers can be restored. It does not preserve the format of the original and is not format-preserving encryption.
- **No enterprise key management or central policy server.** Profiles and rules are local JSON in the browser; the only default distribution is the repository.
- **The vault is local and unencrypted.** See the limits.

## Chrome extension: verification and limits

What has and has not been verified:

- Verified in real Chrome 158 by `scripts/e2e-ext.mjs` against the mock CRM (synthetic data, 59 checks): a fetch and an XHR create go out masked without any approval step and the page still sees its own values; a closed panel does not block a CRM request; adding and removing a host through the panel registers and unregisters the scripts; a permission request outside a user gesture is refused and shown; and a real Gemini Nano inspection run through the panel (classify, author, approve, then a second create is protected). The hold, deny, timeout and closed-panel behavior of a request that waits for approval is covered by the unit harness (`src/ext/harness.test.ts`, strict rules) and, for Gemini, by `scripts/e2e-loop.mjs` in real Chrome. The script loads the extension into a dedicated automation profile and uninstalls it afterwards.

- **Not verified:** the real Chrome permission prompt for a host the extension does not already hold (a native prompt cannot be driven from DevTools); the toolbar click itself (only `openPanelOnActionClick` is checked) and the panel docked in the Chrome window (the check opens `sidepanel.html` as a tab); following the active tab (`tabs.onActivated`); removing a permission granted at runtime (a unit test with a fake only); downloading the Nano model from the panel (the model was already installed, so the user-gesture question is untested); App Check in the extension (none is used, see below); another machine, another Chrome version, or any site other than the mock CRM.

Limits of the extension:

- Covers `fetch` and `XMLHttpRequest` made by the page itself. Beacons, WebSocket, EventSource, workers, form posts and other channels are not intercepted.
- The vault of original values lives in the protected site's own `localStorage`, unencrypted, so **scripts on that site can read it**. Moving it into extension storage is not built.
- The panel watches **one tab at a time**. Switching tabs makes the previous tab's held requests fail closed.
- A hostile page could try to race the private **handshake** between the page and the extension. The bridge runs first at `document_start` and a missing bridge blocks, so in practice it cannot take over, but nothing in the page's own JavaScript world can prove that.
- Gemini Nano needs the Prompt API (Chrome 139+) and the model downloaded; download it first from the web app.
- A held inspection is discarded after the hold timeout, so classification and authoring must finish inside it.
- **No App Check in the extension** (App Check's reCAPTCHA needs the page body and would load a Google frame into your page). On-device calls need no token. If your Firebase project enforces App Check, a cloud fallback of the authoring call is refused and authoring fails visibly. To bind App Check and the API-key restriction to the extension, use the origin `chrome-extension://ombmjhkmnofdcbfafhjcnppjdkalekan`.
- The build reads the public Firebase web config from `.env.local` at build time. `dist-ext/` embeds it and stays untracked.

## Real-CRM run (EspoCRM)

**What the last run showed (44 of 44 checks, Chrome 158, synthetic data, EspoCRM from `espocrm:latest` on 2026-11-25):**

- Logging in and navigating EspoCRM worked with no per-host rule: its own requests were masked and sent inline, nothing was blocked and nothing waited.
- The first create from EspoCRM's own form went out at once with the email replaced by a same-shape stand-in (the CRM stored it), and was captured on **Inspection**. **Without a profile the real first name and the note were stored in the CRM** (generic detectors do not recognise names or free text), and the Indian phone number typed without a country code was not detected either; this is the documented limit of inline mode.
- Nano classified the capture on-device (`inferenceSource: on_device`) and authored a profile on-device. **Nano got fields wrong** and the user step corrected them (names to surrogate, email and phone to surrogate, description to a token); no success rate was measured.
- After the profile was saved, the next create stored, as read from EspoCRM's REST API (curl-style, not through the page), a stand-in name, a format-valid stand-in email and phone, the city in clear (declared non-sensitive) and a token for the note. None of the real name, email, phone or note was stored. EspoCRM's detail and list views showed the real values, also after a reload. The same contact created again got the same stand-ins, a second contact worked, and a create made with the side panel closed still went through, protected, with no wait.
- The **Needs review** queue on Traffic listed the generic-masked requests with their reasons.
- **Does not work or not covered:** CRM-side search on a real value finds nothing (the CRM only holds stand-ins); sorting, e-mail sending and export operate on stand-ins; PUT (edit) and DELETE are not covered by the authored profile (not exercised in the run); attachments, WebSocket and other channels are not intercepted; the vault is in the page origin's `localStorage`; one profile, one machine, one run of 44 checks.

## Hybrid inference: what was actually run

What was actually run (one Windows machine, Chrome 158 with Gemini Nano, synthetic data, `scripts/e2e-engine.mjs` against the mock CRM): classification ran on-device (the first call after a reload took about 34 to 38 s, a warm one about 2 s), authoring ran on-device in about 15 to 17 s, and with the browser's on-device availability overridden to simulate it being unavailable (`--author-cloud`, printed as SIMULATED), the same authoring call fell back to the cloud in 8.8 s and its request body held no sample value. A handful of runs is not a benchmark. Nano's first proposals were imperfect: after on-device authoring the script's user step changed 3 to 4 of 8 field actions, and 1 of 8 after the cloud fallback (for example Nano proposed `allow` for a last name). That is why **the per-field edit and your approval are the real gate**, not the model's label.

## Measured results, in full

All data is synthetic, and every number below comes from a command in this repository. `npm test` currently passes **326 tests in 30 files**. Reports: [`docs/EVAL.md`](EVAL.md) (`npm run eval`), [`docs/EVAL-NANO.md`](EVAL-NANO.md) (`npm run eval:nano`), [`docs/EVAL-QUALITY.md`](EVAL-QUALITY.md) (`node scripts/eval-quality.mjs`).

- **Answer quality against real cloud Gemini** (`gemini-3.5-flash-lite` through Firebase AI Logic, 5 tasks on the synthetic contract, 3 repeats per arm, deterministic fact checks, no LLM judge). The full document sent to the cloud answered 15 of 15 runs with every expected fact. AIRLOCK, with on-device Nano choosing the passages, masking and restoring, also answered **15 of 15** while sending a mean of **1.8 of 16 clauses** and **72% fewer bytes** (909 against 3277), with **0 of 10** sensitive values on the wire (the full document put **10 of 10** there). Two control gateways show the metric cannot be gamed: one that withheld the document scored 0 of 13 completed runs, and one that masked every number scored 6 of 15. AIRLOCK was slower end to end (median 7.6 s against 3.2 s, because it includes on-device selection). Limits: 5 tasks, one document, 15 runs per arm; the harness plays the approver; 2 control runs failed with HTTP 500 from the cloud model and were not redone; 79 cloud calls in total counting the 500s.
- **Clause selection by on-device Nano** (15 real runs through the real console): recall 98%, precision 92%, 2.0 of 16 clauses kept, median 3.7 s (the first call after a reload took 22.9 s). One run missed the probation clause for the termination task.
- **Masking:** 0 of 24 protected values leaked outside the documented weaknesses (4 of 29, or 13.8%, including them); 0 of 33 needed values wrongly masked.
- **Policy:** blocks 8 of 8 injected attack strings and 0 of 3 harmless additions.
- **Honest failures:** 4 documented misses, including names you did not list, bare account numbers, a full-width `@` and keys split into fragments. See `docs/EVAL.md`.
- **Real-Chrome checks** (`scripts/e2e-loop.mjs`, `e2e-pdf.mjs`, `e2e-engine.mjs`, `e2e-ext.mjs`, `e2e-ui-b.mjs`) drive real Chrome; what each run covered is described above.

## Known gaps (design)

- Streaming responses, non-text input (multipart, WebSocket), name and address recognition beyond listed terms, and scanned PDFs are not handled. See above and [`EVAL.md`](EVAL.md).
- The generalize (banding) action and format-preserving encryption are not implemented.
- Response locators are learned only from answers the page actually received (and the unobserved `$` proposal for a write's answer). A response that carries protected values at a place no proposal reaches, or on a path no profile covers, comes back with tokens or stand-ins. Locators restore containers, not single fields. `scripts/e2e-engine.mjs` still adds locators to the mock-CRM profile by editing its JSON and says so.
- A CRM that validates a value's format rejects a `token` (found with EspoCRM: `Bad request ... Field: emailAddress`). Use `surrogate` for email addresses and phone numbers, which gives a format-valid stand-in. Search, sort, export and e-mail sending on protected values work on stand-ins, not on the real values.
- Gemini Nano's field classes and first-proposal actions are imperfect (see the README); the Approve step and per-field edits are what make the result right.
- A real CRM was tested once: self-hosted EspoCRM in Docker, with one authored profile, on one machine (see the README). HubSpot and Salesforce were not tested. Not built yet: moving the extension's vault out of the page origin into `chrome.storage`, App Check bound to the extension ID, and shipping default destination rules through Remote Config.
