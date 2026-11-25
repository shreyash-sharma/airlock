import { useMemo } from "react";
import type { AuditEvent } from "../../core/audit.js";
import type { RequestView } from "../../net/store.js";
import { bucketSeries, clock, consoleStatus, eventSummary, eventTone, kpis } from "../pages/model.js";
import { LineChart, Sparkline } from "./charts.js";
import { useEvents, useViews } from "./data.js";
import { Btn, Card, Chip, Cradle, EmptyState, ProvenanceChip, StatusChip } from "./kit.js";
import type { IconName } from "./icons.js";
import { Icon } from "./icons.js";
import { go, hrefFor } from "./router.js";

function PageHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return (
    <header className="ac-pagehead">
      <div>
        <h1 className="ac-h1">{title}</h1>
        <p className="ac-muted">{description}</p>
      </div>
      {actions && <div className="ac-pagehead-actions">{actions}</div>}
    </header>
  );
}
export { PageHeader };

function Kpi({
  id,
  icon,
  label,
  value,
  caption,
  href,
  spark,
  tone = "primary",
  raw,
}: {
  id: string;
  icon: IconName;
  label: string;
  value: string;
  caption: string;
  href: string;
  spark?: readonly number[];
  tone?: "primary" | "ok" | "blocked" | "masked";
  raw: number;
}) {
  return (
    <a className="ac-kpi" href={href} data-testid={`kpi-${id}`} data-value={raw}>
      <Cradle icon={icon} tone={tone} />
      <div className="ac-kpi-body">
        <span className="ac-kpi-label">{label}</span>
        <span className="ac-kpi-value">{value}</span>
        <span className="ac-muted ac-kpi-cap">{caption}</span>
      </div>
      {spark && <Sparkline values={spark} color={tone === "blocked" ? "var(--blocked)" : "var(--series-protected)"} />}
    </a>
  );
}

function RecentRow({ v }: { v: RequestView }) {
  const status = consoleStatus(v);
  const icon: IconName = status === "blocked" || status === "failed" ? "ban" : status === "awaiting" ? "lock" : status === "denied" ? "x" : "policies";
  const tone = status === "blocked" || status === "failed" ? "blocked" : status === "awaiting" ? "attention" : status === "denied" ? "neutral" : "ok";
  return (
    <a className="ac-listrow" href={hrefFor("traffic", v.id)}>
      <Cradle icon={icon} tone={tone} size={40} />
      <div className="ac-listrow-main">
        <div className="ac-listrow-title">
          {v.host}
          <span className="ac-mono ac-muted">{v.path && v.path !== "(withheld)" ? v.path : ""}</span>
        </div>
        <div className="ac-muted">
          {v.method ?? "POST"}
          {v.profileId ? `, profile ${v.profileId}` : ""}
        </div>
      </div>
      <StatusChip status={status} />
      <span className="ac-muted ac-time">{clock(v.createdAt)}</span>
    </a>
  );
}

const TONE_ICON: Record<string, IconName> = { ok: "policies", blocked: "ban", attention: "lock", info: "send", neutral: "x" };

export function ActivityFeed({ events }: { events: readonly AuditEvent[] }) {
  const recent = [...events].slice(-15).reverse();
  return (
    <div className="ac-insp-inner" data-testid="activity-feed">
      <div className="ac-insp-scroll">
        <div className="ac-section-head">
          <h2 className="ac-h2">Live protection activity</h2>
        </div>
        <p className="ac-muted ac-live">
          <i className="ac-dot ac-dot-ok" />
          {events.length === 0 ? "No events yet" : `Last event ${clock(events[events.length - 1].ts)}`}
        </p>
        {recent.length === 0 ? (
          <EmptyState icon="shield" title="Nothing recorded yet">
            When a request is held, checked or sent, each step shows up here with where it ran.
          </EmptyState>
        ) : (
          <ol className="ac-feed">
            {recent.map((e) => (
              <li key={e.id}>
                <a className="ac-feed-item" href={hrefFor("audit")}>
                  <Cradle icon={TONE_ICON[eventTone(e)]} tone={eventTone(e) === "info" ? "cloud" : (eventTone(e) as "ok" | "blocked" | "attention" | "neutral")} size={36} />
                  <div>
                    <div className="ac-feed-text">{eventSummary(e)}</div>
                    <div className="ac-muted">
                      {clock(e.ts)} <ProvenanceChip where={e.where} />
                    </div>
                  </div>
                </a>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

const ACTION_ORDER = ["mask", "surrogate", "token", "drop", "allow"] as const;

export function Overview() {
  const views = useViews();
  const events = useEvents();
  const k = useMemo(() => kpis(events), [events]);
  const series = useMemo(() => bucketSeries(events, Date.now()), [events]);
  const awaiting = views.filter((v) => consoleStatus(v) === "awaiting").length;
  const recent = [...views].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
  const actionTotals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const v of views) for (const [a, n] of Object.entries(v.actionCounts ?? {})) t[a] = (t[a] ?? 0) + n;
    return t;
  }, [views]);
  const actionMax = Math.max(1, ...Object.values(actionTotals));
  const aiTotal = k.aiCalls.on_device + k.aiCalls.in_cloud + k.aiCalls.code;
  const localAnalyses = events.filter((e) => e.kind === "local-analysis").slice(-6).reverse();

  return (
    <div className="ac-page" data-testid="page-overview">
      <PageHeader
        title="Overview"
        description="What AIRLOCK did since this page loaded."
        actions={
          <>
            <Chip icon="clock">Since this page loaded</Chip>
            <Btn variant="soft" icon="download" onClick={() => go(hrefFor("audit"))}>
              Export disclosure receipt
            </Btn>
          </>
        }
      />

      {awaiting > 0 && (
        <div className="ac-banner-lg ac-banner-attention" data-testid="awaiting-banner">
          <Cradle icon="lock" tone="attention" size={32} />
          <div className="ac-banner-text">
            <div className="ac-banner-title">
              {awaiting} request{awaiting === 1 ? "" : "s"} awaiting your decision
            </div>
          </div>
          <Btn variant="soft" onClick={() => go(hrefFor("traffic", undefined, { status: "awaiting" }))}>
            Review requests
          </Btn>
        </div>
      )}

      <div className="ac-kpis">
        <Kpi id="protected" icon="policies" label="Requests protected" value={String(k.requestsProtected)} raw={k.requestsProtected} caption={k.requestsProtected ? "Sent after checks" : "None yet"} href={hrefFor("traffic", undefined, { status: "protected" })} spark={series.protected} />
        <Kpi id="masked" icon="shield" label="Values masked" value={String(k.valuesMasked)} raw={k.valuesMasked} caption={k.valuesMasked ? "Masked, replaced, tokenised or dropped" : "None yet"} href={hrefFor("audit", undefined, { kind: "sent" })} tone="masked" />
        <Kpi id="blocked" icon="ban" label="Requests blocked" value={String(k.requestsBlocked)} raw={k.requestsBlocked} caption={k.requestsBlocked ? "Stopped by code. Nothing sent" : "None yet"} href={hrefFor("traffic", undefined, { status: "blocked" })} spark={series.blocked} tone="blocked" />
        <Kpi id="ai" icon="cpu" label="AI calls" value={`${k.aiCalls.on_device} on-device`} raw={k.aiCalls.on_device + k.aiCalls.in_cloud} caption={`${k.aiCalls.in_cloud} cloud, ${k.aiCalls.code} as code, no AI`} href={hrefFor("audit", undefined, { kind: "local-analysis" })} tone="ok" />
      </div>

      <div className="ac-strip" data-testid="egress-strip">
        <Icon name={k.unprotectedSends > 0 ? "ban" : "send"} size={18} />
        <span className={k.unprotectedSends > 0 ? "ac-blocked-text" : undefined}>
          Left this device: <b>{k.requestsProtected + k.unprotectedSends} request(s)</b>, {(k.bytesSent / 1024).toFixed(1)} KB, {k.valuesMasked} value(s) withheld. Unprotected sends: {k.unprotectedSends}.
        </span>
      </div>

      <Card title="Requests over time" caption="Protected and blocked requests since this page loaded">
        <LineChart series={series} />
        <div className="ac-legend">
          <span>
            <i className="ac-swatch" style={{ background: "var(--series-protected)" }} />
            Protected
          </span>
          <span>
            <i className="ac-swatch ac-swatch-dash" style={{ borderColor: "var(--blocked)" }} />
            Blocked
          </span>
        </div>
      </Card>

      <Card title="Recent requests" aside={<a className="ac-link" href={hrefFor("traffic")}>View all</a>}>
        {recent.length === 0 ? (
          <EmptyState icon="traffic" title="No requests yet">
            Requests the app makes to protected hosts appear here, with the exact payload and the checks that ran on it.
          </EmptyState>
        ) : (
          <div className="ac-list">
            {recent.map((v) => (
              <RecentRow key={v.id} v={v} />
            ))}
          </div>
        )}
      </Card>

      <div className="ac-twoup">
        <Card title="Protection by action" caption="Fields handled, from profile actions">
          {Object.keys(actionTotals).length === 0 ? (
            <p className="ac-muted">No profile-driven requests yet.</p>
          ) : (
            <ul className="ac-barlist">
              {ACTION_ORDER.filter((a) => actionTotals[a]).map((a) => (
                <li key={a}>
                  <span>{a}</span>
                  <span className="ac-bar">
                    <i style={{ width: `${(actionTotals[a] / actionMax) * 100}%` }} />
                  </span>
                  <b>{actionTotals[a]}</b>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Where AI ran" caption="Steps recorded in the audit log">
          {aiTotal === 0 ? (
            <p className="ac-muted">No analysis steps yet.</p>
          ) : (
            <>
              <div className="ac-split" role="img" aria-label={`${k.aiCalls.on_device} on-device, ${k.aiCalls.in_cloud} cloud, ${k.aiCalls.code} code`}>
                <i style={{ flex: k.aiCalls.on_device, background: "var(--ondevice)" }} />
                <i style={{ flex: k.aiCalls.in_cloud, background: "var(--cloud)" }} />
                <i style={{ flex: k.aiCalls.code, background: "var(--text-3)" }} />
              </div>
              <ul className="ac-steps">
                {localAnalyses.map((e) => (
                  <li key={e.id}>
                    <ProvenanceChip where={e.where} />
                    <span>{eventSummary(e)}</span>
                    {e.latencyMs !== undefined && <span className="ac-muted">{e.latencyMs} ms</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

