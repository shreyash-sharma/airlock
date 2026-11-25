import { useCallback, useEffect, useState } from "react";
import { cloudModel } from "../firebase.js";

/**
 * The AI Workspace demo screen: a stand-in CRM page (clearly labelled, deliberately unlike the console) whose
 * calls AIRLOCK protects. Left: the app view with real values. Right: the "SaaS database" view, read through a fetch
 * captured before AIRLOCK was installed so AIRLOCK does not touch it, and the "Summarize this customer" action that
 * sends the record to Gemini through the same engine, with the approval gate. Synthetic data only.
 */

export const MOCK_CRM_API = "/mock-crm/api";

export interface Contact {
  id: string;
  properties: Record<string, string>;
}

const FIELDS: Array<{ key: string; label: string; wide?: boolean }> = [
  { key: "firstname", label: "First name" },
  { key: "lastname", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "city", label: "City" },
  { key: "plan", label: "Plan" },
  { key: "salary", label: "Salary" },
  { key: "internal_note", label: "Internal note", wide: true },
];

/** Synthetic customers. Emails use the reserved example.com domain. */
export const SAMPLES: Array<Record<string, string>> = [
  { firstname: "Rohan", lastname: "Mehta", email: "rohan.mehta@example.com", phone: "9876543210", city: "Pune", plan: "Enterprise", salary: "68000", internal_note: "Renewal is at risk; the buyer wants a discount before signing." },
  { firstname: "Priya", lastname: "Nair", email: "priya.nair@example.com", phone: "9123456780", city: "Mumbai", plan: "Growth", salary: "54000", internal_note: "Asked for an SSO add-on. Happy with support, unhappy with the invoice format." },
  { firstname: "Alex", lastname: "Carter", email: "alex.carter@example.com", phone: "9988776655", city: "Leeds", plan: "Starter", salary: "47000", internal_note: "Trial ends Friday. Needs a security questionnaire answered before buying." },
];

export const SUMMARY_TASK = "Summarize this customer: their plan, the renewal risk and the next step for the account manager.";

/** The record the app sends to the AI: one short paragraph per topic, so on-device AI can pick only what the task needs. */
export function recordText(c: Contact): string {
  const p = c.properties;
  return [
    "Customer",
    `Name: ${p.firstname ?? ""} ${p.lastname ?? ""}`.trim(),
    "",
    "Contact",
    `Email: ${p.email ?? ""}`,
    `Phone: ${p.phone ?? ""}`,
    "",
    "Account",
    `City: ${p.city ?? ""}. Plan: ${p.plan ?? ""}.`,
    "",
    "Compensation",
    `Salary: ${p.salary ?? ""}`,
    "",
    "Account manager note",
    p.internal_note ?? "",
  ].join("\n");
}

/** The values AIRLOCK should always protect while this customer is summarized: the name parts, email, phone and salary. */
export function protectedFor(c: Contact): string[] {
  const p = c.properties;
  const v = [`${p.firstname ?? ""} ${p.lastname ?? ""}`.trim(), p.firstname, p.lastname, p.email, p.phone, p.salary];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && x.length >= 3))];
}

type Answer =
  | { status: "idle" }
  | { status: "asking"; id: string }
  | { status: "done"; id: string; text: string; source: string | undefined }
  | { status: "error"; id: string; message: string };

const isToken = (v: unknown): boolean => typeof v === "string" && v.startsWith("tok_");

export function Workspace({
  mode,
  nativeFetch,
  setProtectedTerms,
  onError,
  canSummarize,
}: {
  mode: string;
  nativeFetch: typeof fetch;
  setProtectedTerms: (t: string[]) => void;
  onError: (message: string) => void;
  canSummarize: boolean;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [raw, setRaw] = useState<Array<{ id: string; properties: Record<string, unknown> }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer>({ status: "idle" });
  const [sampleAt, setSampleAt] = useState(0);

  /** The SaaS database view: read with the fetch captured before AIRLOCK installed, so it is never held or rewritten. */
  const loadRaw = useCallback(async () => {
    try {
      const res = await nativeFetch(`${MOCK_CRM_API}/_raw`);
      const body = (await res.json()) as { contacts: Array<{ id: string; properties: Record<string, unknown> }> };
      setRaw(body.contacts);
    } catch (e) {
      onError(`SaaS database view: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [nativeFetch, onError]);

  /** The app view: through the guarded fetch, so what AIRLOCK restores is what the app sees. */
  const loadContacts = useCallback(async () => {
    try {
      const res = await fetch(`${MOCK_CRM_API}/contacts`);
      const body = (await res.json()) as { results?: Contact[] };
      setContacts(body.results ?? []);
    } catch (e) {
      onError(`List contacts: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [onError]);

  // The app view loads at once only when the app has its own profile for the CRM (mode demo). In the other modes a
  // first request would be held or blocked before anyone asked for it, so the user starts it with Refresh.
  useEffect(() => {
    void loadRaw();
    if (canSummarize) void loadContacts();
    else setContacts([]);
  }, [loadRaw, loadContacts, canSummarize]);

  const create = async (): Promise<void> => {
    setBusy("create");
    try {
      const properties = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ""));
      const res = await fetch(`${MOCK_CRM_API}/contacts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ properties }) });
      if (!res.ok) throw new Error(`The CRM answered HTTP ${res.status}`);
      setForm({});
    } catch (e) {
      onError(`Create contact: ${e instanceof Error ? e.message : String(e)}`);
    }
    await Promise.all([loadContacts(), loadRaw()]);
    setBusy(null);
  };

  const summarize = async (c: Contact): Promise<void> => {
    setAnswer({ status: "asking", id: c.id });
    setProtectedTerms(protectedFor(c));
    try {
      const result = await cloudModel.generateContent([SUMMARY_TASK, recordText(c)]);
      setAnswer({ status: "done", id: c.id, text: result.response.text(), source: result.response.inferenceSource });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setAnswer({ status: "error", id: c.id, message });
    } finally {
      setProtectedTerms([]);
    }
  };

  const fillSample = (): void => {
    setForm(SAMPLES[sampleAt % SAMPLES.length]);
    setSampleAt(sampleAt + 1);
  };

  const asked = answer.status === "idle" ? undefined : contacts?.find((c) => c.id === answer.id);

  return (
    <div className="crm" data-testid="crm-workspace">
      <header className="crm-top">
        <div className="crm-brand">
          <span className="crm-logo" aria-hidden="true">M</span>
          <div>
            <h1 id="crm-title">Mock CRM</h1>
            <p>Customer accounts</p>
          </div>
        </div>
        <div className="crm-standin" role="note">
          <b>Mock CRM: stand-in for Salesforce or HubSpot</b>
          <span>Served by the dev server, synthetic data only. Mode: <b id="crm-mode">{mode}</b></span>
        </div>
      </header>

      <div className="crm-grid">
        <section className="crm-card crm-span2" aria-labelledby="crm-new">
          <div className="crm-card-head">
            <h2 id="crm-new">New contact</h2>
            <button type="button" className="crm-btn crm-btn-quiet" onClick={fillSample}>Fill a sample customer</button>
          </div>
          <div className="crm-form">
            {FIELDS.map((f) => (
              <label key={f.key} className={f.wide ? "crm-wide" : undefined}>
                <span>{f.label}</span>
                <input value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} data-testid={`crm-field-${f.key}`} />
              </label>
            ))}
          </div>
          <div className="crm-actions">
            <button type="button" className="crm-btn crm-btn-primary" disabled={busy !== null || Object.values(form).every((v) => !v.trim())} onClick={() => void create()} data-testid="crm-create">
              {busy === "create" ? "Saving" : "Create contact"}
            </button>
            <span className="crm-hint">The request to the CRM goes through AIRLOCK before it leaves this page.</span>
          </div>
        </section>

        <section className="crm-card" aria-labelledby="crm-list">
          <div className="crm-card-head">
            <h2 id="crm-list">Contacts (what the app shows)</h2>
            <button type="button" className="crm-btn crm-btn-quiet" onClick={() => void loadContacts()}>Refresh</button>
          </div>
          <p className="crm-hint">Real values, restored on this device after the answer comes back.</p>
          {contacts === null ? (
            <p className="crm-empty">Loading.</p>
          ) : contacts.length === 0 ? (
            <p className="crm-empty">{canSummarize ? "No contacts yet. Create one above." : "Nothing loaded. Refresh asks the CRM through AIRLOCK."}</p>
          ) : (
            <ul className="crm-contacts" data-testid="crm-contacts">
              {contacts.map((c) => (
                <li key={c.id} data-testid="crm-contact">
                  <div className="crm-avatar" aria-hidden="true">{(c.properties.firstname ?? "?").slice(0, 1)}</div>
                  <div className="crm-contact-main">
                    <b>{c.properties.firstname} {c.properties.lastname}</b>
                    <span>{c.properties.email} · {c.properties.phone}</span>
                    <span>{c.properties.city} · {c.properties.plan} · salary {c.properties.salary}</span>
                    {c.properties.internal_note && <span className="crm-note">{c.properties.internal_note}</span>}
                  </div>
                  <button type="button" className="crm-btn crm-btn-ai" disabled={answer.status === "asking" || !canSummarize} onClick={() => void summarize(c)} data-testid="crm-summarize" title={canSummarize ? undefined : "Summaries need the app's AI profile (mode demo)"}>
                    Summarize this customer
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="crm-card crm-db" aria-labelledby="crm-db">
          <div className="crm-card-head">
            <h2 id="crm-db">SaaS database (what the CRM stores)</h2>
            <button type="button" className="crm-btn crm-btn-quiet" onClick={() => void loadRaw()}>Refresh</button>
          </div>
          <p className="crm-hint">Read with a fetch captured before AIRLOCK was installed, so this view is not itself intercepted. Dev-server view only.</p>
          {raw === null ? (
            <p className="crm-empty">Loading.</p>
          ) : raw.length === 0 ? (
            <p className="crm-empty">The database is empty.</p>
          ) : (
            <div className="crm-dbwrap">
              <table data-testid="crm-db-table">
                <thead>
                  <tr><th>id</th>{FIELDS.slice(0, 7).map((f) => <th key={f.key}>{f.key}</th>)}<th>internal_note</th></tr>
                </thead>
                <tbody>
                  {raw.map((r) => (
                    <tr key={r.id} data-testid="crm-db-row">
                      <td>{r.id}</td>
                      {FIELDS.slice(0, 7).map((f) => (
                        <td key={f.key} className={isToken(r.properties[f.key]) ? "crm-tok" : undefined}>{String(r.properties[f.key] ?? "")}</td>
                      ))}
                      <td className="crm-gone">{"internal_note" in r.properties ? String(r.properties.internal_note) : "not stored"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="crm-card crm-span2 crm-ai" aria-labelledby="crm-ai" data-testid="crm-ai">
          <div className="crm-card-head">
            <h2 id="crm-ai">Ask AI about a customer</h2>
          </div>
          {answer.status === "idle" && <p className="crm-empty">Choose Summarize this customer on a contact. The record goes through AIRLOCK, you approve the exact text in the console, and the answer appears here with real values restored.</p>}
          {answer.status !== "idle" && (
            <div className="crm-answer" aria-live="polite">
              <p className="crm-hint">Task: {SUMMARY_TASK}{asked ? ` (contact ${asked.properties.firstname} ${asked.properties.lastname})` : ""}</p>
              {answer.status === "asking" && <p data-testid="crm-ai-status">Waiting for your approval in the AIRLOCK console, or for the cloud.</p>}
              {answer.status === "error" && <p className="crm-error" data-testid="crm-ai-error">{answer.message}</p>}
              {answer.status === "done" && (
                <>
                  <p className="crm-hint" data-testid="crm-ai-source">Answer received by the app (SDK reports: {answer.source ?? "no source"})</p>
                  <div className="crm-answer-text" data-testid="crm-ai-answer">{answer.text}</div>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
