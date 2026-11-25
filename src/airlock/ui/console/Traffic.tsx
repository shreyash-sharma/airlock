import { useMemo, useState } from "react";
import type { RequestView } from "../../net/store.js";
import { clock, consoleStatus, countByStatus, FILTER_ORDER, pinAwaiting, STATUS_LABEL, withheldCount, type ConsoleStatus } from "../pages/model.js";
import { useEvents, useViews } from "./data.js";
import { Card, Chip, EmptyState, Segmented, StatusChip } from "./kit.js";
import { Icon } from "./icons.js";
import { PageHeader } from "./Overview.js";
import { go, hrefFor, type Route } from "./router.js";

export type Density = "comfortable" | "compact";

const RENDER_CAP = 200;

function pathOf(v: RequestView): string {
  return v.path && v.path !== "(withheld)" ? v.path : v.path === "(withheld)" ? "(withheld)" : "";
}

export function Traffic({ route, density, setDensity }: { route: Route; density: Density; setDensity: (d: Density) => void }) {
  const views = useViews();
  const [query, setQuery] = useState("");
  const [cap, setCap] = useState(RENDER_CAP);
  // CRM requests are masked and sent without waiting; this filter is the queue of the ones worth a later look.
  const [reviewOnly, setReviewOnly] = useState(false);
  const status = (FILTER_ORDER as readonly string[]).includes(route.query.status ?? "") ? (route.query.status as ConsoleStatus) : "all";
  const counts = useMemo(() => countByStatus(views), [views]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pinAwaiting(views).filter((v) => {
      if (status !== "all" && consoleStatus(v) !== status) return false;
      if (reviewOnly && !(v.reviewReasons && v.reviewReasons.length > 0)) return false;
      if (!q) return true;
      return [v.host, v.path ?? "", v.profileId ?? "", v.method ?? ""].some((s) => s.toLowerCase().includes(q));
    });
  }, [views, query, status, reviewOnly]);

  const shown = rows.slice(0, cap);
  const setStatus = (s: ConsoleStatus | "all"): void => go(hrefFor("traffic", route.id, s === "all" ? {} : { status: s }));
  const filtersOn = status !== "all" || query !== "" || reviewOnly;
  const reviewCount = views.filter((v) => v.reviewReasons && v.reviewReasons.length > 0).length;

  return (
    <div className="ac-page" data-testid="page-traffic">
      <PageHeader title="Traffic" description="Every request AIRLOCK held, protected, blocked or let through, with the exact payload." />

      <div className="ac-toolbar">
        <label className="ac-search">
          <Icon name="search" size={18} />
          <input type="search" placeholder="Search host, path or profile" aria-label="Search requests" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Segmented
          label="Status filter"
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "All", count: views.length },
            ...FILTER_ORDER.filter((s) => counts[s] > 0 || s === status || ["awaiting", "protected", "blocked"].includes(s)).map((s) => ({ value: s, label: STATUS_LABEL[s], count: counts[s] })),
          ]}
        />
        <button type="button" className="ac-link-btn" data-testid="review-filter" aria-pressed={reviewOnly} onClick={() => setReviewOnly((r) => !r)}>
          {reviewOnly ? "Showing: needs review" : "Needs review"} ({reviewCount})
        </button>
        <Segmented
          label="Row density"
          testId="density-toggle"
          value={density}
          onChange={setDensity}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
        {filtersOn && (
          <button
            type="button"
            className="ac-link-btn"
            onClick={() => {
              setQuery("");
              setStatus("all");
            }}
          >
            Clear filters
          </button>
        )}
        <span className="ac-muted ac-count" aria-live="polite">
          {rows.length} of {views.length} requests
        </span>
      </div>

      <Card className={`ac-tablecard ac-density-${density}`}>
        {views.length === 0 ? (
          <EmptyState icon="traffic" title="No requests yet">
            When the app calls a protected host, AIRLOCK holds the request here. Nothing leaves this device until the checks pass.
          </EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState icon="search" title="No requests match">
            Try clearing a filter.
          </EmptyState>
        ) : (
          <>
            <table className="ac-table" data-testid="traffic-table">
              <thead>
                <tr>
                  <th className="c-time">Time</th>
                  <th className="c-status">Status</th>
                  <th className="c-method">Method</th>
                  <th>Host and path</th>
                  <th className="c-profile">Profile</th>
                  <th className="c-dest">Destination</th>
                  <th className="c-num">Fields</th>
                  <th className="c-num c-bytes">Bytes</th>
                  <th className="c-num c-lat">Latency</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((v) => {
                  const s = consoleStatus(v);
                  const selected = route.id === v.id;
                  return (
                    <tr key={v.id} className={`${s === "awaiting" ? "ac-row-await" : ""} ${selected ? "ac-row-sel" : ""}`} onClick={() => go(hrefFor("traffic", v.id, route.query))} data-testid={`row-${v.id}`}>
                      <td className="c-time">
                        <button
                          type="button"
                          className="ac-rowbtn ac-tnum"
                          aria-current={selected || undefined}
                          onKeyDown={(e) => {
                            const tr = e.currentTarget.closest("tr");
                            const next = e.key === "ArrowDown" ? tr?.nextElementSibling : e.key === "ArrowUp" ? tr?.previousElementSibling : null;
                            if (next) {
                              e.preventDefault();
                              next.querySelector("button")?.focus();
                            }
                          }}
                        >
                          {clock(v.createdAt)}
                        </button>
                      </td>
                      <td className="c-status">
                        <StatusChip status={s} />
                      </td>
                      <td className="c-method ac-mono">{v.method ?? "POST"}</td>
                      <td className="c-host" title={`${v.host}${pathOf(v)}`}>
                        <span className="ac-host">{v.host}</span>
                        <span className="ac-path ac-mono">{pathOf(v)}</span>
                      </td>
                      <td className="c-profile ac-mono">{v.profileId ?? "-"}</td>
                      <td className="c-dest">{v.pipeline ? <Chip>{v.pipeline === "ai-minimize" ? "AI" : "SaaS"}</Chip> : <span className="ac-muted">-</span>}</td>
                      <td className="c-num ac-tnum">{withheldCount(v) || "-"}</td>
                      <td className="c-num c-bytes ac-tnum">{v.bytesSent ?? "-"}</td>
                      <td className="c-num c-lat ac-tnum">{v.cloudLatencyMs !== undefined ? `${v.cloudLatencyMs} ms` : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="ac-tablefoot">
              <span className="ac-muted">
                Showing {shown.length} of {rows.length}
              </span>
              {rows.length > shown.length && (
                <button type="button" className="ac-link-btn" onClick={() => setCap((c) => c + RENDER_CAP)}>
                  Show {Math.min(RENDER_CAP, rows.length - shown.length)} more
                </button>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/** Right column when no request is selected. */
export function SelectRequest() {
  const views = useViews();
  const events = useEvents();
  const decisions = events.filter((e) => e.kind === "approved" || e.kind === "denied").slice(-5).reverse();
  return (
    <div className="ac-insp-inner">
      <div className="ac-insp-scroll">
        <EmptyState icon="traffic" title="Select a request">
          Choose a row to see its payload, checks and decision.
        </EmptyState>
        <div className="ac-section-head">
          <h2 className="ac-h2">Recent decisions</h2>
        </div>
        {decisions.length === 0 ? (
          <p className="ac-muted">No decisions yet.</p>
        ) : (
          <ul className="ac-decisions">
            {decisions.map((e) => {
              const v = views.find((x) => x.id === e.requestId);
              const denied = e.kind === "denied";
              return (
                <li key={e.id}>
                  <a href={hrefFor("traffic", e.requestId)} className="ac-decision">
                    <i className={`ac-dot ${denied ? "ac-dot-neutral" : "ac-dot-ok"}`} />
                    <div>
                      <div className="ac-feed-text">{denied ? "Denied by you" : String(e.detail?.by ?? "").startsWith("inline") ? `Sent at once, masked, by inline mode (${String(e.detail?.destination ?? "")})` : e.detail?.by === "auto" ? `Approved automatically by rule ${String(e.detail?.destination ?? "")}` : "Approved by you"}</div>
                      <div className="ac-muted">
                        {v?.host ?? "request"} at {clock(e.ts)}
                      </div>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
