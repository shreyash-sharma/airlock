import { useEffect, useState, type ReactNode } from "react";
import type { AuditEvent } from "../../core/audit.js";
import { detect } from "../../core/detect.js";
import { INJECTED_LEAK } from "../../net/guard.js";
import type { RequestView } from "../../net/store.js";
import {
  clock,
  consoleStatus,
  decisionLine,
  diffRows,
  eventSummary,
  eventTone,
  policyChecks,
  prettyJson,
  protectedLineCount,
  type DiffRow,
} from "../pages/model.js";
import { eventsFor, inferenceOf, useEnv, useEvents, useViews } from "./data.js";
import { Btn, Card, Chip, Cradle, CopyBtn, EmptyState, Placeholders, ProvenanceChip, StatusChip, Tabs } from "./kit.js";
import { Icon, type IconName } from "./icons.js";
import { go, hrefFor } from "./router.js";

const isGemini = (v: RequestView): boolean => v.pipeline !== "field-protect";

/** The exact text that will leave (or did leave). */
export function outboundText(v: RequestView): string | undefined {
  return v.pipeline === "field-protect" ? v.outboundBody : v.prepared?.outboundBody;
}

/* ------------------------------ Payload comparison ------------------------------ */

function Highlighted({ text }: { text: string }) {
  const entities = detect(text);
  const nodes: ReactNode[] = [];
  let at = 0;
  entities.forEach((e, i) => {
    if (e.start < at) return;
    nodes.push(<span key={`t${i}`}>{text.slice(at, e.start)}</span>);
    nodes.push(
      <mark key={`m${i}`} className="ac-secret" title={e.type}>
        {text.slice(e.start, e.end)}
      </mark>,
    );
    at = e.end;
  });
  nodes.push(<span key="tail">{text.slice(at)}</span>);
  return <>{nodes}</>;
}

function GeminiOriginal({ v }: { v: RequestView }) {
  return (
    <div className="ac-pane-body ac-mono" tabIndex={0} aria-label="Original request, local only">
      {v.task && (
        <div className="ac-pane-line">
          <b>Task:</b> {v.task}
        </div>
      )}
      {v.clauses.length > 0 ? (
        v.clauses.map((c) => (
          <div key={c.id} className={`ac-pane-line ${c.selected ? "ac-kept" : "ac-withheld"}`}>
            [{c.id}] {c.selected ? <Highlighted text={c.text.trim()} /> : c.text.trim()}
          </div>
        ))
      ) : (
        <Highlighted text={v.originalDocument} />
      )}
    </div>
  );
}

function GeminiOutbound({ v }: { v: RequestView }) {
  const text = v.prepared?.outboundText ?? "";
  const at = v.injected ? text.indexOf(INJECTED_LEAK) : -1;
  return (
    <div className="ac-pane-body ac-mono" tabIndex={0} aria-label="Exact outbound payload" data-testid="outbound">
      {at === -1 ? (
        <Placeholders text={text} />
      ) : (
        <>
          <Placeholders text={text.slice(0, at)} />
          <mark className="ac-leak" data-testid="leak">
            {INJECTED_LEAK}
          </mark>
        </>
      )}
    </div>
  );
}

function DiffLine({ n, text, side, kind }: { n: number; text: string | undefined; side: "left" | "right"; kind: DiffRow["kind"] }) {
  if (text === undefined) {
    return (
      <div className={`ac-ln ac-ln-gap ac-ln-${kind}`}>
        <span className="ac-ln-n" />
        <span className="ac-ln-t">{kind === "removed" ? "Dropped, not sent" : ""}</span>
      </div>
    );
  }
  const tag = kind === "same" ? null : side === "left" ? (kind === "added" ? null : "sensitive") : kind === "removed" ? null : "protected";
  return (
    <div className={`ac-ln ac-ln-${side} ac-ln-${kind}`}>
      <span className="ac-ln-n">{String(n).padStart(3, "0")}</span>
      <span className="ac-ln-t">
        {side === "right" ? <Placeholders text={text} /> : text}
        {tag && <span className="ac-ln-tag">{tag}</span>}
      </span>
    </div>
  );
}

/** Original on the left (local only), what leaves on the right. `tabbed` shows one pane at a time for narrow places. */
export function PayloadDiff({ v, tabbed, hideOriginal }: { v: RequestView; tabbed: boolean; hideOriginal?: boolean }) {
  const [pane, setPane] = useState<"outbound" | "original">("outbound");
  const outbound = outboundText(v);
  const gemini = isGemini(v);
  const original = v.originalBody;
  const rows = !gemini && original !== undefined && outbound !== undefined ? diffRows(original, outbound) : null;

  const left = hideOriginal ? (
    <div className="ac-pane-body ac-muted">Original values are hidden. Choose Show values to see them.</div>
  ) : gemini ? (
    <GeminiOriginal v={v} />
  ) : rows ? (
    <div className="ac-pane-body" tabIndex={0} aria-label="Original request, local only">
      {rows.map((r, i) => (
        <DiffLine key={i} n={i + 1} text={r.left} side="left" kind={r.kind} />
      ))}
    </div>
  ) : (
    <div className="ac-pane-body ac-muted">
      {original === undefined && v.method !== undefined && v.method !== "GET" ? "The original is kept in memory for the latest 50 requests only, and it is not held for this one." : "This request has no body."}
    </div>
  );

  const right = gemini ? (
    <GeminiOutbound v={v} />
  ) : rows ? (
    <div className="ac-pane-body" tabIndex={0} aria-label="Exact outbound payload" data-testid="outbound">
      {rows.map((r, i) => (
        <DiffLine key={i} n={i + 1} text={r.right} side="right" kind={r.kind} />
      ))}
    </div>
  ) : outbound !== undefined ? (
    <div className="ac-pane-body ac-mono" tabIndex={0} aria-label="Exact outbound payload" data-testid="outbound">
      <Placeholders text={prettyJson(outbound)} />
    </div>
  ) : (
    <div className="ac-pane-body ac-muted" aria-label="Exact outbound payload" data-testid="outbound">
      {v.status === "blocked" ? "Blocked, so no outbound payload was built for display. Nothing was sent." : "No outbound payload yet."}
    </div>
  );

  const leftHead = (
    <div className="ac-diff-title">
      <i className="ac-dot ac-dot-attention" />
      Original <span className="ac-muted">(stays on this device)</span>
    </div>
  );
  const rightHead = (
    <div className="ac-diff-title">
      <i className="ac-dot ac-dot-ok" />
      Outbound <span className="ac-muted">(what will leave)</span>
    </div>
  );
  const bytes = outbound !== undefined ? new TextEncoder().encode(outbound).length : undefined;

  if (tabbed) {
    return (
      <div className="ac-diff ac-diff-tabbed">
        <Tabs
          label="Payload view"
          value={pane}
          onChange={setPane}
          tabs={[
            { value: "outbound", label: "Outbound" },
            { value: "original", label: "Original (local)" },
          ]}
        />
        <div className="ac-diff-pane">{pane === "outbound" ? right : left}</div>
        <div className="ac-diff-foot">
          <span>{pane === "original" ? "Local only. Never stored or exported." : "Sent exactly as shown."}</span>
          {bytes !== undefined && pane === "outbound" && <span>{bytes} bytes</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="ac-diff ac-diff-wide" data-testid="payload-diff">
      <div className="ac-diff-col ac-diff-orig">
        <div className="ac-diff-head">{leftHead}</div>
        <div className="ac-diff-pane">{left}</div>
        <div className="ac-diff-foot">
          <span>Local only. Never stored or exported.</span>
        </div>
      </div>
      <div className="ac-diff-col ac-diff-out">
        <div className="ac-diff-head">
          {rightHead}
          <Chip tone="ok" icon="shield">Checked by code</Chip>
        </div>
        <div className="ac-diff-pane">{right}</div>
        <div className="ac-diff-foot">
          <span>Hash computed locally before send.</span>
          {bytes !== undefined && <span>{bytes} bytes</span>}
        </div>
      </div>
    </div>
  );
}

/** One line: how many values changed, from the diff for field requests or the prepared counts for Gemini. */
export function ProtectionSummary({ v }: { v: RequestView }) {
  if (v.prepared) {
    return (
      <p className="ac-note" data-testid="protection-summary">
        {v.prepared.maskedTotal} value(s) masked, {v.prepared.withheldClauses} passage(s) withheld, mode {v.prepared.mode}.
      </p>
    );
  }
  const counts = Object.entries(v.actionCounts ?? {});
  if (counts.length === 0) return null;
  const rows = v.originalBody !== undefined && v.outboundBody !== undefined ? protectedLineCount(diffRows(v.originalBody, v.outboundBody)) : null;
  return (
    <p className="ac-note" data-testid="protection-summary">
      {counts.map(([a, n]) => `${n} ${a}`).join(", ")}
      {rows !== null && ` (${rows} line(s) differ from the original)`}.
    </p>
  );
}

/** Chosen passages for a Gemini request (the e2e check reads this list). */
export function Clauses({ v }: { v: RequestView }) {
  if (v.clauses.length === 0 || !v.prepared) return null;
  const selected = v.clauses.filter((c) => c.selected);
  return (
    <div className="ac-tile">
      <div className="ac-tile-head">
        {v.selection?.source === "on_device" ? <ProvenanceChip where="on_device" /> : <Chip tone="neutral" icon="shield">Keywords, no AI</Chip>}
        <b>
          Chosen passages: {selected.length} of {v.clauses.length}
        </b>
        {v.selection && v.selection.source === "on_device" && (
          <span className="ac-muted">
            {v.selection.latencyMs} ms, {v.selection.calls} call(s)
          </span>
        )}
      </div>
      <div className="ac-clauses" data-testid="clauses">
        {v.clauses.map((c) => (
          <div key={c.id} className={`ac-clause ${c.selected ? "ac-clause-on" : "ac-clause-off"}`}>
            <span className="ac-mono">{c.id}</span>
            <span>
              {c.heading}
              {c.selected && c.reason && <span className="ac-muted"> - {c.reason}</span>}
              {!c.selected && <span className="ac-muted"> (withheld{c.flag ? `: text that ${c.flag}` : ""})</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------ Policy checks ------------------------------ */

export function PolicyChecks({ v, grid }: { v: RequestView; grid?: boolean }) {
  const checks = policyChecks(v);
  const passed = checks.filter((c) => c.state === "pass").length;
  return (
    <div data-testid="policy-checks">
      <div className="ac-section-head">
        <h3 className="ac-h3">Checked by code (no AI)</h3>
        <span className="ac-muted">
          {passed} of {checks.length} passed
        </span>
      </div>
      <div className={grid ? "ac-checks ac-checks-grid" : "ac-checks"}>
        {checks.map((c) => (
          <div key={c.rule} className={`ac-check ac-check-${c.state}`}>
            <span className={`ac-check-mark ac-check-mark-${c.state}`}>
              <Icon name={c.state === "pass" ? "check" : c.state === "blocked" ? "x" : "clock"} size={16} />
            </span>
            <div>
              <div className="ac-check-title">{c.title}</div>
              <div className="ac-check-rule ac-mono">{c.rule}</div>
              <div className="ac-muted">{c.explain}</div>
            </div>
            <Chip tone={c.state === "pass" ? "ok" : c.state === "blocked" ? "blocked" : "neutral"}>{c.state === "pass" ? "Pass" : c.state === "blocked" ? "Blocked" : "Pending"}</Chip>
          </div>
        ))}
      </div>
      {v.flagged && v.flagged.length > 0 && (
        <p className="ac-note ac-attn">
          Instruction-like text withheld: {v.flagged.map((f) => `${f.id} (${f.why})`).join("; ")}. The document is treated as data.
        </p>
      )}
    </div>
  );
}

/* ------------------------------ Boundary ------------------------------ */

export function Boundary({ v }: { v: RequestView }) {
  const gemini = isGemini(v);
  const stays = gemini
    ? ["The original document and task", "Every value replaced by a placeholder", "The local map that restores the answer"]
    : ["The original request body", "Every value that was masked, replaced or dropped", "The local map that restores the answer"];
  const leaves = gemini
    ? ["The task with placeholders", "Only the passages you can see", "Nothing that failed a code check"]
    : ["The protected body shown in the Outbound pane", "Fields you allowed to pass unchanged", "Nothing that failed a code check"];
  return (
    <div data-testid="boundary">
      <div className="ac-boundary">
        <div className="ac-bcard ac-bcard-stay">
          <div className="ac-bcard-head">
            <span>
              <i className="ac-dot ac-dot-ok" /> Stays on this device
            </span>
            <Chip tone="ok">Local</Chip>
          </div>
          <ul>
            {stays.map((s) => (
              <li key={s}>
                <Icon name="laptop" size={16} />
                {s}
              </li>
            ))}
          </ul>
        </div>
        <div className="ac-bcard ac-bcard-leave">
          <div className="ac-bcard-head">
            <span>
              <i className="ac-dot ac-dot-cloud" /> Leaves this device
            </span>
            <Chip tone="cloud">{gemini ? "Cloud" : "SaaS"}</Chip>
          </div>
          <ul>
            {leaves.map((s) => (
              <li key={s}>
                <Icon name="send" size={16} />
                {s}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="ac-note ac-center">AIRLOCK hashes the exact outbound payload before it is sent. The hash is computed locally and recorded in the audit log.</p>
    </div>
  );
}

/* ------------------------------ Timeline, facts ------------------------------ */

export function Timeline({ events }: { events: readonly AuditEvent[] }) {
  if (events.length === 0) return <p className="ac-muted">No events recorded for this request yet.</p>;
  return (
    <ol className="ac-timeline" data-testid="timeline">
      {events.map((e) => (
        <li key={e.id} className={`ac-tl-item ac-tl-${eventTone(e)}`}>
          <span className="ac-tl-dot" />
          <div>
            <div className="ac-tl-text">{eventSummary(e)}</div>
            <div className="ac-muted">
              {clock(e.ts)} <ProvenanceChip where={e.where} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="ac-fact">
      <span className="ac-fact-k">{k}</span>
      <span className="ac-fact-v">{children}</span>
    </div>
  );
}

export function Facts({ v }: { v: RequestView }) {
  const events = useEvents();
  const inf = inferenceOf(v, events);
  const dur = v.startedAt !== undefined && v.endedAt !== undefined ? v.endedAt - v.startedAt : undefined;
  return (
    <div className="ac-facts" data-testid="facts">
      <Row k="Status">
        <StatusChip status={consoleStatus(v)} />
      </Row>
      <Row k="Wire hash">
        {v.wireHash ? (
          <>
            <span className="ac-hash ac-mono" data-testid="wire-hash">
              {v.wireHash}
            </span>
            <span className="ac-muted">SHA-256, computed locally</span>
            <CopyBtn text={v.wireHash} label="Copy wire hash" />
          </>
        ) : (
          <span className="ac-muted">Not computed yet</span>
        )}
      </Row>
      <Row k="Destination">
        <span className="ac-mono">{v.host}</span>
        {v.destinationId && <span className="ac-muted"> rule {v.destinationId}</span>}
      </Row>
      <Row k="inferenceSource">
        {inf ? (
          <>
            <span className="ac-mono">{inf}</span> <ProvenanceChip where={inf} />
          </>
        ) : (
          <span className="ac-muted">None ran for this request</span>
        )}
      </Row>
      <Row k="Bytes sent">{v.bytesSent !== undefined ? `${v.bytesSent} bytes` : <span className="ac-muted">Not sent</span>}</Row>
      <Row k="Cloud latency">{v.cloudLatencyMs !== undefined ? `${v.cloudLatencyMs} ms` : <span className="ac-muted">Not measured</span>}</Row>
      {dur !== undefined && <Row k="Held for">{dur} ms in total</Row>}
      <Row k="Profile">
        {v.profileId ? (
          <>
            <span className="ac-mono">{v.profileId}</span>
            <span className="ac-muted"> authored by {v.authoredBy ?? "unknown"}</span>
          </>
        ) : (
          <span className="ac-muted">None matched</span>
        )}
      </Row>
      <Row k="Decision">{decisionLine(v) ?? <span className="ac-muted">Waiting</span>}</Row>
    </div>
  );
}

/* ------------------------------ Answer ------------------------------ */

export function Answer({ v }: { v: RequestView }) {
  const [tab, setTab] = useState<"restored" | "cloud">("restored");
  const review = v.reviewReasons ?? [];
  if (v.restoredView === undefined) {
    return (
      <div>
        {review.length > 0 && (
          <div data-testid="review-reasons">
            <p className="ac-muted">
              <strong>Needs a later look.</strong> This request was masked and sent without waiting for you.
            </p>
            {review.map((r) => (
              <p key={r} className="ac-muted">
                {r}
              </p>
            ))}
          </div>
        )}
        {(v.notes ?? []).map((n) => (
          <p key={n} className="ac-muted">
            {n}
          </p>
        ))}
        {(v.restoredCount ?? 0) > 0 && <p className="ac-muted">{v.restoredCount} value(s) in the answer were restored to their originals on this device.</p>}
        {(v.notes ?? []).length === 0 && !v.restoredCount && <p className="ac-muted">No answer text is shown for this request.</p>}
      </div>
    );
  }
  return (
    <div data-testid="answer">
      <div className="ac-row">
        <Tabs
          label="Answer view"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "restored", label: "Restored for you" },
            { value: "cloud", label: "As the cloud saw it" },
          ]}
        />
        {v.cloudLatencyMs !== undefined && <span className="ac-muted">{v.cloudLatencyMs} ms</span>}
      </div>
      <div className="ac-pane-body ac-mono ac-answer">{tab === "restored" ? v.restoredView : <Placeholders text={v.cloudView ?? ""} />}</div>
      {v.citations && v.citations.cited.length > 0 && (
        <p className="ac-note">
          Cites: {v.citations.cited.map((c) => (
            <mark key={c} className="ac-token">
              {c}
            </mark>
          ))}
          {v.citations.outside.length > 0 && <span className="ac-attn"> Needs attention: {v.citations.outside.join(", ")} was not part of what was sent.</span>}
        </p>
      )}
      {v.unresolved && v.unresolved.length > 0 && <p className="ac-note ac-attn">The cloud used placeholders AIRLOCK could not restore: {v.unresolved.join(", ")}</p>}
    </div>
  );
}

/* ------------------------------ Actions ------------------------------ */

/** The decision bar. It exists once per screen: either in the inspector or on the full request page. */
export function ActionBar({ v, full }: { v: RequestView; full?: boolean }) {
  const { source } = useEnv();
  const { store } = source;
  const gemini = isGemini(v);
  const status = consoleStatus(v);

  if (v.status === "awaiting-approval") {
    return (
      <div className="ac-actions" data-testid="action-bar">
        <p className="ac-note">Awaiting your approval. Only the Outbound side will be sent. It is hashed first, then sent exactly as shown.</p>
        <div className="ac-btn-row">
          <Btn variant="primary" size="lg" icon="policies" data-testid="drawer-approve" onClick={() => store.approve(v.id)}>
            {gemini ? "Approve and send to cloud" : "Approve and send"}
          </Btn>
          {full && (
            <Btn variant="secondary" size="lg" icon="sliders" onClick={() => go(hrefFor(v.profileId ? "profiles" : "policies"))}>
              Edit protection rules
            </Btn>
          )}
          <Btn variant="secondary" size="lg" data-testid="drawer-deny" onClick={() => store.deny(v.id)}>
            Deny, send nothing
          </Btn>
        </div>
        {full && <p className="ac-note">Edit protection rules applies to the next request. This one stays held.</p>}
        {gemini && store.injectLeak && (
          <div className="ac-demo">
            <span className="ac-muted">Demo tools</span>
            <Btn variant="ghost" size="sm" title="Adds an unauthorized secret to this payload so you can watch the gate stop it" onClick={() => store.injectLeak?.(v.id)}>
              Demo: inject a secret
            </Btn>
            <span className="ac-muted">Simulates a bug or poisoned document adding a secret after the preview. The check that stops it is the real one.</span>
          </div>
        )}
      </div>
    );
  }
  if (v.status === "local-failed") {
    return (
      <div className="ac-actions" data-testid="action-bar">
        <p className="ac-note">On-device analysis could not run. Nothing was sent.{v.localError ? ` ${v.localError}` : ""}</p>
        <div className="ac-btn-row">
          <Btn variant="secondary" size="lg" onClick={() => store.useFallback(v.id)}>
            Use keyword matching (no AI)
          </Btn>
          <Btn variant="secondary" size="lg" onClick={() => store.deny(v.id)}>
            Cancel, send nothing
          </Btn>
        </div>
      </div>
    );
  }
  if (v.status === "inspecting") {
    return (
      <div className="ac-actions" data-testid="action-bar">
        <p className="ac-note">Held for inspection. Nothing was sent. No profile covers this request; classify it and author a profile in Inspection.</p>
        <div className="ac-btn-row">
          <Btn variant="primary" size="lg" icon="inspection" onClick={() => go(hrefFor("inspection"))}>
            Open in Inspection
          </Btn>
        </div>
      </div>
    );
  }
  if (status === "analyzing") return <div className="ac-actions"><p className="ac-note">Running on this device. The document is not leaving it.</p></div>;
  if (v.status === "sending" || v.status === "done") {
    return (
      <div className="ac-actions ac-result" data-testid="action-bar">
        <Icon name="circle-check" />
        <span>
          {v.approvedBy === "user" ? "Approved. " : ""}Sent {v.bytesSent ?? 0} bytes
          {v.endedAt ? ` at ${clock(v.endedAt)}` : ""}.
          {v.wireHash && (
            <>
              {" "}
              Wire hash <span className="ac-mono ac-hash-inline" data-testid="wire-hash-inline">{v.wireHash.slice(0, 16)}...</span>
            </>
          )}
        </span>
      </div>
    );
  }
  if (v.status === "denied") {
    return (
      <div className="ac-actions ac-result" data-testid="action-bar">
        <Icon name="x" />
        <span>Denied. Nothing was sent.</span>
      </div>
    );
  }
  return null;
}

/* ------------------------------ Request inspector (docked column) ------------------------------ */

type InspTab = "payload" | "policy" | "audit" | "answer";

export function RequestInspector({ id }: { id: string }) {
  const views = useViews();
  const events = useEvents();
  const [tab, setTab] = useState<InspTab>("payload");
  const v = views.find((x) => x.id === id);
  const answered = v?.restoredView !== undefined;
  useEffect(() => {
    // When the answer arrives, bring it forward once.
    if (answered) setTab("answer");
  }, [answered, id]);
  if (!v) {
    return (
      <div className="ac-insp-inner">
        <EmptyState icon="search" title="Request not found">
          It may have been cleared by a reload. The audit resets on reload.
        </EmptyState>
      </div>
    );
  }
  const status = consoleStatus(v);
  const tabs: Array<{ value: InspTab; label: string }> = [
    { value: "payload", label: "Payload" },
    { value: "policy", label: "Policy" },
    { value: "audit", label: "Audit" },
    ...(v.restoredView !== undefined ? [{ value: "answer" as const, label: "Answer" }] : []),
  ];
  const title = `${v.method ?? "POST"} ${v.host}${v.path && v.path !== "(withheld)" ? v.path : ""}`;
  return (
    <div className="ac-insp-inner" data-testid="drawer">
      <header className="ac-insp-head">
        <div className="ac-insp-title">
          <h2 className="ac-h2 ac-mono ac-ellipsis" title={title} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="ac-iconbtn" aria-label="Close request details" onClick={() => go(hrefFor("traffic"))}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="ac-row">
          <StatusChip status={status} />
          <Btn variant="ghost" size="sm" icon="expand" data-testid="request-open-full" onClick={() => go(hrefFor("traffic", v.id, { view: "full" }))}>
            Open full view
          </Btn>
        </div>
        {v.wireHash && (
          <div className="ac-tile">
            <div className="ac-muted">Wire hash (SHA-256 of the exact body, computed locally)</div>
            <div className="ac-hash ac-mono" data-testid="wire-hash">
              {v.wireHash}
            </div>
            <div>
              <CopyBtn text={v.wireHash} label="Copy wire hash" />
            </div>
          </div>
        )}
        <div className="ac-meta">
          {v.profileId && (
            <span>
              Profile <span className="ac-mono">{v.profileId}</span>, authored by {v.authoredBy ?? "unknown"}
            </span>
          )}
          <ProvenanceChip where={inferenceOf(v, events)} />
          <span className="ac-muted">{clock(v.createdAt)}</span>
        </div>
      </header>
      <div className="ac-insp-scroll">
        <Tabs label="Request sections" value={tab} onChange={setTab} tabs={tabs} />
        {v.message && (v.status === "blocked" || v.status === "failed" || v.status === "denied" || v.status === "local-failed") && (
          <div className={`ac-banner ${v.status === "denied" ? "ac-banner-neutral" : "ac-banner-blocked"}`}>
            {v.status === "denied" ? (
              <Chip tone="neutral">Nothing sent</Chip>
            ) : v.status === "local-failed" ? (
              <Chip tone="attention">Needs attention</Chip>
            ) : (
              <Chip tone="blocked">{v.status === "failed" ? "Failed" : "Blocked"}</Chip>
            )}
            <p>{v.message}</p>
            {v.status === "blocked" && <p className="ac-muted">Nothing was sent.</p>}
          </div>
        )}
        {tab === "payload" && (
          <>
            <ProtectionSummary v={v} />
            <Clauses v={v} />
            <PayloadDiff v={v} tabbed />
          </>
        )}
        {tab === "policy" && (
          <>
            <PolicyChecks v={v} />
            <p className="ac-note">{decisionLine(v) ?? "No decision yet."}</p>
          </>
        )}
        {tab === "audit" && <Timeline events={eventsFor(events, v.id)} />}
        {tab === "answer" && <Answer v={v} />}
      </div>
      <footer className="ac-insp-foot">
        <ActionBar v={v} />
      </footer>
    </div>
  );
}

/* ------------------------------ Full request page ------------------------------ */

const BANNER: Record<string, { title: string; icon: IconName }> = {
  awaiting: { title: "Authorization required", icon: "lock" },
  analyzing: { title: "Analyzing on this device", icon: "cpu" },
  sending: { title: "Sending after checks", icon: "send" },
  protected: { title: "Sent after checks", icon: "circle-check" },
  restored: { title: "Sent after checks, answer restored", icon: "circle-check" },
  passed: { title: "Sent, nothing needed protecting", icon: "circle-check" },
  blocked: { title: "Blocked by code", icon: "ban" },
  denied: { title: "Denied, nothing sent", icon: "x" },
  failed: { title: "The request failed", icon: "alert" },
};

type EvidenceTab = "payload" | "policy" | "audit" | "answer";

export function RequestPage({ id }: { id: string }) {
  const views = useViews();
  const events = useEvents();
  const [showValues, setShowValues] = useState(true);
  const [evidence, setEvidence] = useState<EvidenceTab>("payload");
  const v = views.find((x) => x.id === id);
  if (!v) {
    return (
      <div className="ac-page">
        <a className="ac-crumb" href={hrefFor("traffic")}>
          <Icon name="back" size={16} /> Traffic
        </a>
        <Card>
          <EmptyState icon="search" title="Request not found">
            It may have been cleared by a reload. The audit resets on reload.
          </EmptyState>
        </Card>
      </div>
    );
  }
  const status = consoleStatus(v);
  const banner = v.status === "local-failed" ? { title: "On-device analysis could not run", icon: "alert" as IconName } : v.status === "inspecting" ? { title: "Held for inspection", icon: "inspection" as IconName } : BANNER[status];
  const awaiting = status === "awaiting";
  const gemini = isGemini(v);
  const checks = policyChecks(v);
  const out = outboundText(v);
  const evTabs: Array<{ value: EvidenceTab; label: string }> = [
    { value: "payload", label: "Captured payload" },
    { value: "policy", label: "Policy match log" },
    { value: "audit", label: "Audit trail" },
    ...(v.restoredView !== undefined ? [{ value: "answer" as const, label: "Answer" }] : []),
  ];
  const path = v.path && v.path !== "(withheld)" ? v.path : "";
  const protectedCount = v.prepared ? v.prepared.maskedTotal + v.prepared.withheldClauses : Object.entries(v.actionCounts ?? {}).filter(([a]) => a !== "allow").reduce((n, [, c]) => n + c, 0);

  return (
    <div className="ac-page" data-testid="request-page">
      <nav className="ac-crumbs" aria-label="Breadcrumb">
        <a href={hrefFor("traffic")}>Traffic</a>
        <Icon name="chevron" size={14} />
        <span>Request</span>
        <span className="ac-mono ac-idchip">{v.id.slice(0, 8)}</span>
      </nav>

      <div className={`ac-banner-lg ${awaiting ? "ac-banner-attention" : status === "blocked" || status === "failed" ? "ac-banner-blocked" : "ac-banner-neutral"}`}>
        <Cradle icon={banner.icon} tone={awaiting ? "attention" : status === "blocked" || status === "failed" ? "blocked" : "primary"} size={40} />
        <div className="ac-banner-text">
          <div className="ac-banner-title">{banner.title}</div>
          <p>
            {awaiting && v.status === "awaiting-approval"
              ? "Awaiting your approval. Only the Outbound side will be sent. It is hashed first, then sent exactly as shown."
              : awaiting
                ? "Nothing was sent. Decide below."
              : (decisionLine(v) ?? "Every step is recorded below, in the order it happened.")}
            {v.message && status !== "awaiting" ? ` ${v.message}` : ""}
          </p>
          {status === "denied" && <Chip tone="neutral">Nothing sent</Chip>}
        </div>
        <div className="ac-banner-chips">
          <StatusChip status={status} />
          <span className="ac-mono ac-idchip">{v.id.slice(0, 8)}</span>
        </div>
      </div>

      <Card className="ac-main-card">
        <div className="ac-title-row">
          <h1 className="ac-h1">
            {v.method ?? "POST"} <span className="ac-hostchip ac-mono">{v.host}</span>
          </h1>
        </div>
        {path && <p className="ac-mono ac-muted ac-path">{path}</p>}
        <p className="ac-muted">
          {v.profileId ? `Profile ${v.profileId}, authored by ${v.authoredBy ?? "unknown"}. ` : ""}
          {gemini ? "Gemini request: on-device AI chooses passages, code checks them." : "Field-protect: each field handled by its profile action."}
        </p>
        <div className="ac-targets">
          <div className="ac-tile">
            <span className="ac-fact-k">Destination</span>
            <b>{gemini ? "AI" : "SaaS"}</b>
            <span className="ac-mono ac-muted">{v.host}</span>
          </div>
          <div className="ac-tile">
            <span className="ac-fact-k">Profile</span>
            <b className="ac-mono">{v.profileId ?? "none"}</b>
            <span className="ac-muted">{v.authoredBy ? `authored by ${v.authoredBy}` : "no profile matched"}</span>
          </div>
          <div className="ac-tile">
            <span className="ac-fact-k">Pipeline</span>
            <b>{v.pipeline ?? "unknown"}</b>
            <span className="ac-muted">{protectedCount} value(s) protected</span>
          </div>
        </div>

        <PolicyChecks v={v} grid />
        <Boundary v={v} />

        <div>
          <div className="ac-section-head">
            <h3 className="ac-h3">Payload comparison</h3>
            <Btn variant="ghost" size="sm" icon="eye" onClick={() => setShowValues((s) => !s)}>
              {showValues ? "Hide values" : "Show values"}
            </Btn>
          </div>
          <div className="ac-strip">
            <Icon name="shield" size={18} />
            <b>{protectedCount} value(s) protected before sending.</b>
            <span className="ac-muted">Original values are shown here and nowhere else. They are never stored, exported or logged.</span>
          </div>
          <PayloadDiff v={v} tabbed={false} hideOriginal={!showValues} />
          <Clauses v={v} />
          <ProtectionSummary v={v} />
        </div>

        <ActionBar v={v} full />
      </Card>

      <Card title="Evidence">
        <Tabs label="Evidence" value={evidence} onChange={setEvidence} tabs={evTabs} />
        <div className="ac-evidence">
          {evidence === "payload" && (
            <>
              <div className="ac-row">
                <span className="ac-muted">{out !== undefined ? `${new TextEncoder().encode(out).length} bytes, exactly as it will or did leave` : "No outbound payload was built."}</span>
                {out !== undefined && <CopyBtn text={out} label="Copy outbound payload" />}
              </div>
              <pre className="ac-code">{out !== undefined ? prettyJson(out) : "Nothing to show."}</pre>
            </>
          )}
          {evidence === "policy" && (
            <>
              {checks.map((c) => (
                <div key={c.rule} className="ac-log-row">
                  <span className="ac-mono">{c.rule}</span>
                  <span>{c.explain}</span>
                  <Chip tone={c.state === "pass" ? "ok" : c.state === "blocked" ? "blocked" : "neutral"}>{c.state}</Chip>
                </div>
              ))}
            </>
          )}
          {evidence === "audit" && <Timeline events={eventsFor(events, v.id)} />}
          {evidence === "answer" && <Answer v={v} />}
        </div>
      </Card>

      <Card title="Request timeline" caption="In the order recorded">
        <Timeline events={eventsFor(events, v.id)} />
      </Card>
    </div>
  );
}

/** The right-hand column of the full request page. */
export function RequestFactsColumn({ id }: { id: string }) {
  const views = useViews();
  const v = views.find((x) => x.id === id);
  if (!v) return null;
  return (
    <div className="ac-insp-inner">
      <div className="ac-insp-scroll">
        <h2 className="ac-h2">Request facts</h2>
        <Facts v={v} />
        <p className="ac-note ac-tile">This log is kept in memory and ends when the page closes.</p>
      </div>
    </div>
  );
}
