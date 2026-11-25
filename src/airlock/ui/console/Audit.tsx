import { useMemo, useState } from "react";
import { filterEvents, GROUP_LABEL, groupByDay, groupCounts, toneOf, type Group, type Where } from "../pages/audit-model.js";
import { clock, eventSummary, kpis } from "../pages/model.js";
import { buildReceipt, collectForbidden, type BuildResult } from "../pages/receipt.js";
import { useEvents, useViews } from "./data.js";
import { Btn, Card, ConfirmDialog, EmptyState, ProvenanceChip, Segmented, Select } from "./kit.js";
import { Icon } from "./icons.js";
import { PageHeader } from "./Overview.js";
import type { Route } from "./router.js";

const WHERE_OPTIONS = [
  { value: "", label: "Anywhere" },
  { value: "on_device", label: "On-device" },
  { value: "in_cloud", label: "Cloud" },
  { value: "code", label: "Code, no AI" },
];

const GROUPS = Object.keys(GROUP_LABEL) as Group[];

export function Audit({ route }: { route: Route }) {
  const events = useEvents();
  const views = useViews();
  const initial = (GROUPS as string[]).includes(route.query.group ?? "") ? (route.query.group as Group) : "all";
  const [group, setGroup] = useState<Group>(initial);
  const [where, setWhere] = useState<"" | Where>("");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState(false);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [building, setBuilding] = useState(false);

  const counts = useMemo(() => groupCounts(events), [events]);
  const filtered = group === "all" && !where && !query.trim() ? "all" : "filtered";
  const shown = useMemo(() => filterEvents(events, { group, where: where || undefined, query }), [events, group, where, query]);
  const days = useMemo(() => groupByDay(shown, Date.now()), [shown]);
  const k = kpis(events);

  const build = async (): Promise<void> => {
    setBuilding(true);
    setResult(null);
    const profiles = [...new Map(views.filter((v) => v.profileId).map((v) => [v.profileId as string, { id: v.profileId as string, authoredBy: v.authoredBy }])).values()];
    const built = await buildReceipt({ events: shown.slice().sort((a, b) => a.id - b.id), selection: filtered, profiles, forbidden: collectForbidden(views), now: Date.now() });
    setResult(built);
    setBuilding(false);
  };
  const openDialog = (): void => {
    setDialog(true);
    void build();
  };
  const download = (): void => {
    if (!result?.ok) return;
    const url = URL.createObjectURL(new Blob([result.json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
    setDialog(false);
  };

  return (
    <div className="ac-page" data-testid="page-audit">
      <PageHeader
        title="Audit"
        description="Every decision and send, recorded as counts and hashes. Never values."
        actions={
          <Btn variant="primary" icon="download" onClick={openDialog} data-testid="audit-export">
            Export disclosure receipt
          </Btn>
        }
      />
      <Card
        title="Activity"
        caption={`${events.length} recorded since this page loaded. Audit resets on reload. ${k.requestsProtected} sent, ${k.requestsBlocked} blocked.`}
      >
        <div className="ac-toolbar">
          <label className="ac-search">
            <Icon name="search" size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search kind, request or text" aria-label="Search the audit" />
          </label>
          <Segmented<Group> label="Event group" value={group} onChange={setGroup} options={GROUPS.map((g) => ({ value: g, label: GROUP_LABEL[g], count: counts[g] }))} />
          <Select label="Where it ran" value={where} options={WHERE_OPTIONS} onChange={(v) => setWhere(v as "" | Where)} />
          <span className="ac-count ac-muted">{shown.length} of {events.length}</span>
        </div>
        {shown.length === 0 ? (
          <EmptyState icon="audit" title={events.length === 0 ? "The audit log is empty" : "No event matches"}>
            {events.length === 0 ? "Every held request, decision and send is listed here as it happens." : "Clear the search or the filters to see the other events."}
          </EmptyState>
        ) : (
          <div className="al-audit" data-testid="audit-list">
            {days.map((d) => (
              <section key={d.day} className="ac-auditday">
                <h3 className="ac-fact-k ac-dayhead">{d.day}</h3>
                <ol className="ac-timeline ac-timeline-audit">
                  {d.events.map((e) => {
                    const tone = toneOf(e);
                    return (
                      <li key={e.id} className={`ac-tl-item ac-tl-${tone}`}>
                        <span className="ac-tl-dot" />
                        <div>
                          <div className="ac-tl-text">
                            <b>{e.kind}</b> <span className="ac-muted ac-tl-sum">{eventSummary(e)}{e.latencyMs !== undefined ? `, ${e.latencyMs} ms` : ""}</span>
                          </div>
                          <div className="ac-muted">
                            <span className="ac-tnum">{clock(e.ts)}</span>
                            <ProvenanceChip where={e.where} />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}
      </Card>

      <ConfirmDialog open={dialog} title="Export a disclosure receipt" confirmLabel="Download receipt" confirmDisabled={!result?.ok} onConfirm={download} onCancel={() => setDialog(false)}>
        <p className="ac-muted">
          The receipt lists {filtered === "all" ? "every event" : `the ${shown.length} filtered event(s)`} as counts, hashes and the names of profiles. It never contains an original value. AIRLOCK checks that before offering the download.
        </p>
        {building && <p role="status">Checking the receipt.</p>}
        {result && (
          <ul className="ac-checks ac-receipt-checks" data-testid="receipt-checks">
            {result.checks.map((c) => (
              <li key={c.id} className={`ac-check ${c.passed ? "" : "ac-check-blocked"}`}>
                <span className={`ac-check-mark ac-check-mark-${c.passed ? "pass" : "blocked"}`}><Icon name={c.passed ? "check" : "x"} size={16} /></span>
                <span className="ac-check-title">{c.label}</span>
                <span className="ac-muted">{c.passed ? "passed" : "failed"}</span>
              </li>
            ))}
          </ul>
        )}
        {result?.ok && (
          <dl className="ac-receipt-facts" data-testid="receipt-facts">
            <div><dt>File</dt><dd className="ac-mono">{result.filename}</dd></div>
            <div><dt>Events</dt><dd>{result.receipt.events.length}</dd></div>
            <div><dt>Requests sent</dt><dd>{result.receipt.counts.requestsProtected}</dd></div>
            <div><dt>Values masked</dt><dd>{result.receipt.counts.valuesMasked}</dd></div>
            <div><dt>Blocked</dt><dd>{result.receipt.counts.requestsBlocked}</dd></div>
            <div><dt>Events hash (SHA-256)</dt><dd className="ac-mono ac-hash">{result.receipt.integrity.eventsSha256}</dd></div>
          </dl>
        )}
        {result && !result.ok && (
          <div className="ac-banner ac-banner-blocked" role="alert">
            <p>Export refused: rule {result.rule} failed at {result.path}. Nothing was exported.</p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
