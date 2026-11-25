import { useState } from "react";
import { wildcardPath } from "../../inspect/capture.js";
import type { InspectItem } from "../../inspect/session.js";
import { ACTIONS, CATEGORIES, type Action, type Category } from "../../profiles/types.js";
import { useEnv, useInspectItems, type InspectionLike } from "./data.js";
import { Btn, Card, Chip, EmptyState, ErrorList, Select } from "./kit.js";
import { Icon } from "./icons.js";
import { PageHeader } from "./Overview.js";
import { ResponseLocators } from "./ResponseLocators.js";
import { hrefFor } from "./router.js";

const DECIDED = new Set(["saved", "discarded", "passed-through"]);

type StepState = "done" | "active" | "pending";

/** Where each of the five steps stands, from the item's real state. */
export function stepStates(item: InspectItem): StepState[] {
  const decided = DECIDED.has(item.status);
  const classified = item.classification !== undefined;
  const proposed = item.profile !== undefined;
  const s = (done: boolean, active: boolean): StepState => (done ? "done" : active ? "active" : "pending");
  return [
    "done",
    s(classified, !classified),
    s(proposed, classified && !proposed),
    s(item.status === "saved" || (proposed && decided), proposed && !decided),
    s(item.status === "saved", false),
  ];
}

const STEPS = ["Captured", "Classified", "Proposed", "Reviewed", "Saved"];

function Stepper({ item }: { item: InspectItem }) {
  const states = stepStates(item);
  return (
    <ol className="ac-stepper" aria-label="Inspection steps">
      {STEPS.map((label, i) => (
        <li key={label} className={`ac-step ac-step-${states[i]}`} aria-current={states[i] === "active" ? "step" : undefined}>
          <span className="ac-step-dot">{states[i] === "done" ? <Icon name="check" size={14} /> : i + 1}</span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

function Leaves({ item }: { item: InspectItem }) {
  return (
    <Card title="Captured fields" caption={`${item.leaves.length} field(s) in the held request. Previews show shape only, never a value.`}>
      <div className="ac-tablewrap ac-scrollbox" tabIndex={0} aria-label="Captured fields">
        <table className="ac-table">
          <thead>
            <tr>
              <th>Side</th>
              <th>Path</th>
              <th>Type</th>
              <th>Detector hits</th>
              <th>Preview</th>
            </tr>
          </thead>
          <tbody>
            {item.leaves.map((l) => (
              <tr key={`${l.side} ${l.path}`}>
                <td>{l.side}</td>
                <td className="ac-mono">{l.path}</td>
                <td>{l.valueType}</td>
                <td>{l.detectorHits.length > 0 ? l.detectorHits.map((h) => <Chip key={h} tone="masked">{h}</Chip>) : <span className="ac-muted">none</span>}</td>
                <td className="ac-mono ac-muted">{l.preview}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {item.truncated && <p className="ac-note ac-attn">This request had more fields than the inspector lists; the extra ones are not covered.</p>}
    </Card>
  );
}

function Classification({ item, store }: { item: InspectItem; store: InspectionLike }) {
  const c = item.classification;
  const busy = item.status === "classifying";
  return (
    <Card
      title="Classification"
      caption="Mode ONLY_ON_DEVICE: the real values are read on this device and never leave it."
      aside={
        <Btn variant={c ? "secondary" : "primary"} icon="cpu" disabled={busy || DECIDED.has(item.status)} onClick={() => void store.classify(item.id)}>
          {busy ? "Classifying" : "Classify on-device"}
        </Btn>
      }
    >
      {c ? (
        <>
          <div className="ac-row">
            {c.source === "on_device" ? (
              <Chip tone="ok" icon="cpu">Proposed on-device by Gemini Nano (inferenceSource: on_device)</Chip>
            ) : (
              <>
                <Chip tone="attention" icon="alert">Detector-only fallback</Chip>
                <span className="ac-note ac-attn ac-wrap">: {c.note}</span>
              </>
            )}
            <span className="ac-note ac-muted ac-tnum">{c.latencyMs} ms, {c.calls} call(s)</span>
          </div>
          {c.source !== "on_device" && <p className="ac-note ac-muted">No AI read these values. Only the regex detectors classified them, so unusual fields may be missed. Review every field below.</p>}
          <div className="ac-clauses">
            {c.fields.filter((f) => f.side === "request").map((f) => (
              <div key={f.path} className="ac-clause ac-clause-on ac-classrow">
                <span className="ac-mono">{f.path}</span>
                <span><Chip tone="neutral">{f.class}</Chip> <span className="ac-muted">{f.reason}</span></span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="ac-muted">Not classified yet. Without on-device AI this step is labelled detector-only and never shown as on-device.</p>
      )}
    </Card>
  );
}

function Authoring({ item, store }: { item: InspectItem; store: InspectionLike }) {
  const busy = item.status === "authoring";
  const a = item.authored;
  const decided = DECIDED.has(item.status);
  const promptRefused = item.prompt !== undefined && item.prompt.startsWith("(not shown");
  return (
    <Card
      title="Authoring"
      caption="Mode PREFER_ON_DEVICE: a prompt of paths, types and classes only. The SDK may fall back to the cloud model, and the answer says which one wrote the profile."
      aside={
        <Btn variant={item.profile ? "secondary" : "primary"} icon="sparkles" disabled={busy || decided || !item.classification} onClick={() => void store.author(item.id)} title={item.classification ? undefined : "Classify first"}>
          {busy ? "Authoring" : "Author profile"}
        </Btn>
      }
    >
      {item.prompt !== undefined && (
        <>
          <div className="ac-row">
            <b>The exact prompt that was sent</b>
            {promptRefused ? <Chip tone="blocked" icon="ban">Withheld</Chip> : <Chip tone="ok" icon="circle-check">Assertion passed: no captured value in it</Chip>}
          </div>
          <pre className="ac-code" tabIndex={0} aria-label="Authoring prompt">{item.prompt}</pre>
          <p className="ac-note ac-muted">assertStructureOnly checks the prompt against every captured value before the call. If it finds one, no model call is made and the prompt is withheld here.</p>
        </>
      )}
      {a && (
        <p>
          Authored by: <b>{a.source ?? "no model answer"}</b>
          <span className="ac-note ac-muted ac-tnum"> {(a.latencyMs / 1000).toFixed(1)} s, {a.calls} call(s)</span>{" "}
          {a.source === "on_device" && <Chip tone="ok" icon="cpu">On-device</Chip>}
          {a.source === "in_cloud" && <Chip tone="cloud" icon="cloud">Cloud fallback (structure only)</Chip>}
        </p>
      )}
      {item.errors.length > 0 && <ErrorList errors={item.errors} title="Not valid" />}
      {item.dryRun && (
        <div className="ac-row" data-testid="dry-run">
          <span>Dry run:</span>
          {item.dryRun.ok ? <Chip tone="ok" icon="circle-check">passed</Chip> : <Chip tone="blocked" icon="circle-x">failed</Chip>}
          <span className="ac-note ac-muted">The restore round trip {item.dryRun.restored ? "reproduced the originals" : "was not shown"}. Response locators are not tested without a sample answer.</span>
        </div>
      )}
      {item.dryRun && !item.dryRun.ok && item.dryRun.failures.length > 0 && <ErrorList errors={item.dryRun.failures} title="Dry run failures" />}
    </Card>
  );
}

const CAT_OPTIONS = [{ value: "", label: "(none)" }, ...CATEGORIES.map((c) => ({ value: c, label: c }))];
const ACTION_OPTIONS = [{ value: "", label: "default for its class" }, ...ACTIONS.map((a) => ({ value: a, label: a }))];

function FieldEditor({ item, store }: { item: InspectItem; store: InspectionLike }) {
  if (!item.profile) return null;
  const paths = [...new Set(item.leaves.filter((l) => l.side === "request").map((l) => wildcardPath(l.path)))];
  const fields = item.profile.request.fields;
  // The field that governs a path: the exact entry, else the longest container locator above it (such as $).
  const governing = (path: string) => {
    const exact = fields.find((f) => f.path === path);
    if (exact) return { field: exact, inherited: false };
    const above = fields.filter((f) => path.startsWith(`${f.path}.`) || path.startsWith(`${f.path}[`)).sort((x, y) => y.path.length - x.path.length)[0];
    return { field: above, inherited: above !== undefined };
  };
  const locked = DECIDED.has(item.status);
  return (
    <Card title="Review each field" caption="Change what a field is and what happens to it. Every change is validated and the dry run repeats; nothing is saved until you approve.">
      <div className="ac-fieldtable">
        {paths.map((path) => {
          const g = governing(path);
          return (
            <div className="ac-fieldrow ac-fieldrow-insp" key={path}>
              <span className="ac-mono ac-fieldpath">{path}</span>
              <Select label={`Category for ${path}`} value={g.field?.category ?? ""} options={CAT_OPTIONS} disabled={locked} onChange={(v) => v && void store.edit(item.id, path, undefined, v as Category)} />
              <Select label={`Action for ${path}`} value={g.field?.flow?.action ?? ""} options={ACTION_OPTIONS} disabled={locked} onChange={(v) => v && void store.edit(item.id, path, v as Action)} />
              {g.inherited ? <span className="ac-note ac-muted">inherited from {g.field?.path}</span> : <span />}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Decision({ item, store }: { item: InspectItem; store: InspectionLike }) {
  const [approveErrors, setApproveErrors] = useState<string[]>([]);
  if (DECIDED.has(item.status)) {
    return (
      <Card>
        {item.status === "saved" ? (
          <div className="ac-row">
            <Chip tone="ok" icon="circle-check">Profile saved</Chip>
            {item.profile && <a className="ac-link" href={hrefFor("profiles", item.profile.id)}>Open it on the Profiles page</a>}
          </div>
        ) : (
          <Chip tone="neutral">{item.status === "discarded" ? "Discarded, nothing sent" : "Sent once, unprotected"}</Chip>
        )}
        <p className="ac-note ac-muted">The captured values were cleared from memory.</p>
      </Card>
    );
  }
  return (
    <Card className="ac-decision-card">
      <div className="ac-row">
        <Chip tone="attention" icon="alert">Awaiting your decision</Chip>
        <span className="ac-muted">Nothing is saved until you approve. The request stays held on this device.</span>
      </div>
      <ErrorList errors={approveErrors} title="Not saved" />
      <div className="ac-btn-row">
        <Btn variant="primary" icon="check" disabled={item.status !== "ready"} onClick={() => void store.approve(item.id).then((r) => setApproveErrors(r.errors))}>
          Approve and save profile
        </Btn>
        <Btn variant="secondary" icon="x" onClick={() => store.discard(item.id)}>Discard capture</Btn>
        <Btn variant="ghost" size="sm" onClick={() => store.passThrough(item.id)}>Send once unprotected</Btn>
      </div>
      <p className="ac-note ac-attn">Warning: "Send once unprotected" lets this request leave as it is, with no protection. The audit records it as an unprotected send.</p>
    </Card>
  );
}

export function Inspection() {
  const { source } = useEnv();
  const items = useInspectItems();
  const store = source.inspection;
  const [picked, setPicked] = useState<string | null>(null);
  const active = items.find((i) => i.id === picked) ?? items[items.length - 1];

  return (
    <div className="ac-page" data-testid="page-inspection">
      <PageHeader title="Inspection" description="Teach AIRLOCK a new service: capture a request, let AI propose a profile from its structure, check it, then approve it." />
      {!store || !active ? (
        <Card>
          <EmptyState icon="inspection" title={store ? "No request is held for inspection" : "Inspection is off in this app"}>
            {store
              ? `When a request to ${source.inspectHosts.join(", ")} matches no profile, AIRLOCK holds it here. Nothing leaves this device while it is held.`
              : "Unknown hosts are blocked with a reason. An app turns inspection on for the hosts it wants to learn."}
          </EmptyState>
          {!store && <p className="ac-note ac-muted ac-center">To try it, open the mock CRM workspace in inspect mode.</p>}
        </Card>
      ) : (
        <>
          {items.length > 1 && (
            <div className="ac-btn-row" aria-label="Held requests">
              {items.map((i) => (
                <Btn key={i.id} variant={i.id === active.id ? "soft" : "secondary"} size="sm" aria-pressed={i.id === active.id} onClick={() => setPicked(i.id)}>
                  {i.method} {i.host}{i.path} ({i.status})
                </Btn>
              ))}
            </div>
          )}
          <Card className="ac-held" testId="inspection-held">
            <div className="ac-row">
              <Chip tone="attention" icon="search">CAPTURED</Chip>
              <span className="ac-mono ac-heldtitle">{active.method} {active.host}{active.path}</span>
              <span className="ac-note ac-muted">status: {active.status}</span>
            </div>
            <Stepper item={active} />
          </Card>
          <Leaves item={active} />
          <Classification item={active} store={store} />
          <Authoring item={active} store={store} />
          <FieldEditor item={active} store={store} />
          <ResponseLocators item={active} store={store} />
          <Decision item={active} store={store} />
        </>
      )}
    </div>
  );
}
