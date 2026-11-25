import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "../host/base.css";
import "../host/host.css";
import "./crm.css";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { installAirlock } from "../airlock/index.js";
import type { Profile } from "../airlock/profiles/types.js";
import { AUTHORING_GENERATION_CONFIG, CLOUD_MODEL_NAME, getAuthoringModel, getLocalClassifierModel, getLocalJsonModel } from "../firebase.js";
import { MOCK_CRM_API, Workspace } from "./Workspace.js";

/**
 * The AI Workspace page: the labelled mock CRM (a stand-in for Salesforce or HubSpot, served by the Vite dev server)
 * beside the AIRLOCK console. Synthetic data only.
 *   ?mode=demo        (default) the CRM host is in scope with a profile the app supplies, so create, list and
 *                     "Summarize this customer" work at once and the console shows every request.
 *   ?mode=inspect     the CRM host is in scope and has inspection on: an unprofiled request is held, classified
 *                     on-device, authored by hybrid inference, vetted and approved on the Inspection page.
 *   ?mode=unprofiled  the CRM host is in scope with inspection off: an unprofiled request is blocked with a reason.
 */

const CRM_HOST = "127.0.0.1:5173";
const API = `${MOCK_CRM_API}/contacts`;
const requested = new URLSearchParams(location.search).get("mode");
const mode = requested === "unprofiled" || requested === "inspect" ? requested : "demo";

/** Captured before AIRLOCK installs, so the "SaaS database" view reads the CRM without being held or rewritten. */
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/** What the app's developer declares for the mock CRM: names get stand-ins, contact and money get tokens, the note is dropped. */
const CRM_PROFILE: Profile = {
  version: 1,
  id: "mock-crm-contacts",
  name: "Mock CRM contacts",
  kind: "saas",
  pipeline: "field-protect",
  match: { hosts: [CRM_HOST], paths: ["/mock-crm/api/**"] },
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

const airlock = installAirlock({
  mount: document.getElementById("airlock-root")!,
  scope: [CRM_HOST],
  ...(mode === "demo" ? { profiles: [CRM_PROFILE], localModel: getLocalJsonModel } : {}),
  ...(mode === "inspect"
    ? {
        inspectHosts: [CRM_HOST],
        classifierModel: getLocalClassifierModel,
        authoringModel: () => ({ model: getAuthoringModel(), name: CLOUD_MODEL_NAME, generationConfig: AUTHORING_GENERATION_CONFIG }),
      }
    : {}),
});

type Out = "fetch" | "xhr";

function xhrRequest(method: string, body: string | null): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, API);
    if (body !== null) xhr.setRequestHeader("content-type", "application/json");
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new Error("XMLHttpRequest network error: AIRLOCK blocked the request or it failed (see the console)"));
    xhr.send(body);
  });
}

const SAMPLE = {
  properties: {
    firstname: "Rohan",
    lastname: "Mehta",
    email: "rohan.mehta@example.com",
    phone: "9876543210",
    city: "Pune",
    plan: "Enterprise",
    salary: "68000",
    internal_note: "Renewal is at risk; the buyer wants a discount before signing.",
  },
};

function App() {
  const [out, setOut] = useState<Record<Out, string>>({ fetch: "", xhr: "" });
  const [errors, setErrors] = useState<string[]>([]);
  const [profileErrors, setProfileErrors] = useState<string[]>([]);

  const refreshProfileErrors = useCallback(() => setProfileErrors([...airlock.profileErrors()]), []);
  // Stored profiles load asynchronously: show what the registry reported once it is ready.
  useEffect(() => {
    void airlock.engine.ready.then(refreshProfileErrors);
  }, [refreshProfileErrors]);

  const addError = useCallback((message: string) => setErrors((e) => [...e, message]), []);

  const run = async (where: Out, label: string, action: () => Promise<{ status: number; text: string }>) => {
    try {
      const r = await action();
      setOut((o) => ({ ...o, [where]: `${label} -> HTTP ${r.status}\n${r.text}` }));
    } catch (err) {
      addError(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    refreshProfileErrors();
  };

  const post = JSON.stringify(SAMPLE);
  const viaFetch = async (method: string, body: string | null) => {
    const res = await fetch(API, { method, headers: body === null ? {} : { "content-type": "application/json" }, body });
    return { status: res.status, text: await res.text() };
  };

  const all = [...profileErrors, ...errors];
  return (
    <>
      <Workspace mode={mode} nativeFetch={nativeFetch} setProtectedTerms={(t) => airlock.setProtectedTerms(t)} onError={addError} canSummarize={mode === "demo"} />
      <section className="crm-card crm-test" aria-labelledby="crm-test-title">
        <div className="crm-card-head">
          <h2 id="crm-test-title">Transport test (fetch and XHR)</h2>
        </div>
        <p className="crm-hint">Sends the same sample contact through each transport and shows the raw answer the page receives. Used by the browser checks.</p>
        <div className="crm-actions">
          <button className="h-btn primary" onClick={() => void run("fetch", "Create via fetch", () => viaFetch("POST", post))}>Create via fetch</button>
          <button className="h-btn primary" onClick={() => void run("xhr", "Create via XHR", () => xhrRequest("POST", post))}>Create via XHR</button>
          <button className="h-btn" onClick={() => void run("fetch", "List via fetch", () => viaFetch("GET", null))}>List via fetch</button>
          <button className="h-btn" onClick={() => void run("xhr", "List via XHR", () => xhrRequest("GET", null))}>List via XHR</button>
        </div>
        <div className="crm-tests">
          <div>
            <h3>Page received (fetch)</h3>
            <pre id="out-fetch" className="crm-pre">{out.fetch}</pre>
          </div>
          <div>
            <h3>Page received (XHR)</h3>
            <pre id="out-xhr" className="crm-pre">{out.xhr}</pre>
          </div>
        </div>
        <h3>Errors the page caught</h3>
        <pre id="errors" className="crm-pre crm-pre-error">{all.join("\n")}</pre>
      </section>
    </>
  );
}

createRoot(document.getElementById("host-root")!).render(<App />);
