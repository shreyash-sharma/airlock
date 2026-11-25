import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "../tokens.css";
import "../console.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { readLocalStatus, type LocalState, type NanoAnalyzer } from "../../ai/local.js";
import { consoleStatus, countByStatus } from "../pages/model.js";
import { ConsoleContext, useEnv, useEvents, useInspectItems, useViews, type ConsoleSource } from "./data.js";
import { Btn, Chip, IconBtn } from "./kit.js";
import { Icon, type IconName } from "./icons.js";
import { ActivityFeed, Overview } from "./Overview.js";
import { Audit } from "./Audit.js";
import { AttachStrip, Hosts } from "./Hosts.js";
import { Inspection } from "./Inspection.js";
import { Policies } from "./Policies.js";
import { Profiles } from "./Profiles.js";
import { RequestFactsColumn, RequestInspector, RequestPage } from "./Request.js";
import { go, hrefFor, PAGES, useRoute, type Page } from "./router.js";
import { SelectRequest, Traffic, type Density } from "./Traffic.js";

const NAV: Record<Page, { label: string; icon: IconName }> = {
  overview: { label: "Overview", icon: "overview" },
  traffic: { label: "Traffic", icon: "traffic" },
  profiles: { label: "Profiles", icon: "profiles" },
  policies: { label: "Policies", icon: "policies" },
  inspection: { label: "Inspection", icon: "inspection" },
  audit: { label: "Audit", icon: "audit" },
  hosts: { label: "Hosts", icon: "globe" },
};

const DENSITY_KEY = "airlock.ui.v1";

function loadDensity(): Density {
  try {
    const raw = localStorage.getItem(DENSITY_KEY);
    const parsed = raw ? (JSON.parse(raw) as { density?: string }) : {};
    return parsed.density === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

const MODEL_COPY: Record<LocalState, { tone: "ok" | "attention" | "blocked"; text: string }> = {
  ready: { tone: "ok", text: "On-device AI ready" },
  downloadable: { tone: "attention", text: "On-device AI needs a download" },
  downloading: { tone: "attention", text: "On-device AI downloading" },
  unavailable: { tone: "blocked", text: "On-device AI unavailable" },
  unsupported: { tone: "blocked", text: "No on-device AI in this browser" },
};

function ModelStatus({ analyzer }: { analyzer: NanoAnalyzer | null }) {
  const { source } = useEnv();
  const remote = source.extension?.model;
  useViews(); // a remote model state arrives with the published snapshot
  const [localState, setState] = useState<LocalState>("unsupported");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (!remote) void readLocalStatus().then(setState);
  }, [remote]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);
  const state = remote ? remote.state() : localState;
  const canPrepare = remote ? true : analyzer !== null;
  const prepare = async (): Promise<void> => {
    if (!canPrepare) return;
    setError(null);
    setProgress(0);
    try {
      if (remote) await remote.prepare();
      else await analyzer?.prepare((f) => setProgress(f));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setProgress(null);
    refresh();
  };
  const copy = MODEL_COPY[state];
  return (
    <>
      <Chip tone={copy.tone} icon="cpu">
        {copy.text}
      </Chip>
      {progress !== null && <Chip tone="attention">Downloading {Math.round(progress * 100)}%</Chip>}
      {state !== "ready" && state !== "unsupported" && progress === null && canPrepare && (
        <Btn variant="soft" size="sm" onClick={() => void prepare()}>
          Prepare on-device AI
        </Btn>
      )}
      {error && <span className="ac-blocked-text ac-note">{error}</span>}
    </>
  );
}

function CloudStatus() {
  const events = useEvents();
  const last = [...events].reverse().find((e) => e.where === "in_cloud" && (e.kind === "response" || e.kind === "error"));
  if (!last) return <Chip icon="cloud">Cloud: not called yet</Chip>;
  return last.kind === "response" ? (
    <Chip tone="cloud" icon="cloud">
      Cloud: last call ok
    </Chip>
  ) : (
    <Chip tone="blocked" icon="cloud">
      Cloud: last call failed
    </Chip>
  );
}

function ProtectionStatus({ source }: { source: ConsoleSource }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, []);
  const errors = source.profileErrors().length;
  if (errors > 0) return <Chip tone="attention" icon="alert">Attention: {errors} profile error(s)</Chip>;
  if (!source.isReady()) return <Chip icon="shield">Starting</Chip>;
  return (
    <Chip tone="ok" icon="shield" title="Covers fetch and XMLHttpRequest from this page to configured hosts. Other channels are not intercepted.">
      Protection on: fetch and XHR
    </Chip>
  );
}

function TopBar({ expanded, onToggleExpand, onToggleInspector }: { expanded: boolean; onToggleExpand?: () => void; onToggleInspector: () => void }) {
  const { analyzer, source, environment } = useEnv();
  const views = useViews();
  const awaiting = countByStatus(views).awaiting;
  return (
    <header className="ac-top">
      <div className="ac-brand">
        <span className="ac-mark">
          <Icon name="shield" size={20} />
        </span>
        <span className="ac-wordmark">airlock</span>
      </div>
      <div className="ac-top-chips">
        <span className="ac-t ac-t-env">
          <Chip icon="laptop">{environment}</Chip>
        </span>
        <span className="ac-t ac-t-model">
          <ModelStatus analyzer={analyzer} />
        </span>
        <span className="ac-t ac-t-cloud">
          <CloudStatus />
        </span>
        <span className="ac-t ac-t-prot">
          <ProtectionStatus source={source} />
        </span>
      </div>
      <div className="ac-top-right">
        {awaiting > 0 && (
          <a className="ac-pill-await" href={hrefFor("traffic", undefined, { status: "awaiting" })} data-testid="awaiting-pill">
            <Icon name="lock" size={16} />
            {awaiting} awaiting your decision
          </a>
        )}
        <span className="ac-only-medium">
          <IconBtn icon="panel" label="Show details panel" onClick={onToggleInspector} />
        </span>
        {onToggleExpand && <IconBtn icon={expanded ? "collapse" : "expand"} label={expanded ? "Collapse the console" : "Expand the console"} onClick={onToggleExpand} pressed={expanded} />}
      </div>
    </header>
  );
}

function Nav({ page }: { page: Page }) {
  const views = useViews();
  const { source } = useEnv();
  const awaiting = countByStatus(views).awaiting;
  const pages = PAGES.filter((p) => p !== "hosts" || source.extension);
  return (
    <nav className="ac-nav" aria-label="Console">
      <ul>
        {pages.map((p) => (
          <li key={p}>
            <a href={hrefFor(p)} className="ac-navitem" aria-current={page === p ? "page" : undefined} aria-label={NAV[p].label} title={NAV[p].label} data-testid={`nav-${p}`}>
              <Icon name={NAV[p].icon} />
              <span className="ac-navlabel">{NAV[p].label}</span>
              {p === "traffic" && awaiting > 0 && <span className="ac-navbadge">{awaiting}</span>}
            </a>
          </li>
        ))}
      </ul>
      <div className="ac-navfoot">
        <div className="ac-navcard">
          <b>
            <i className="ac-dot ac-dot-ok" /> Computed on this device
          </b>
          <p>Audit resets on reload. Hashes are computed locally.</p>
        </div>
      </div>
    </nav>
  );
}

/** Selects a newly awaiting request once, unless the user is typing or already on a request page. */
function useAutoOpen(rootRef: React.RefObject<HTMLDivElement | null>): void {
  const views = useViews();
  const seen = useRef<Set<string>>(new Set());
  const route = useRoute();
  useEffect(() => {
    for (const v of views) {
      if (consoleStatus(v) !== "awaiting" || seen.current.has(v.id)) continue;
      seen.current.add(v.id);
      const active = document.activeElement;
      const typing = active instanceof HTMLElement && rootRef.current?.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
      if (typing || route.view === "full") return;
      go(hrefFor("traffic", v.id));
    }
  }, [views, route.view, rootRef]);
}

/** Opens the Inspection page once for each newly held request, unless the user is typing. */
function useAutoOpenInspection(rootRef: React.RefObject<HTMLDivElement | null>): void {
  const items = useInspectItems();
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const i of items) {
      if (seen.current.has(i.id)) continue;
      seen.current.add(i.id);
      const active = document.activeElement;
      const typing = active instanceof HTMLElement && rootRef.current?.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
      if (!typing) go(hrefFor("inspection"));
    }
  }, [items, rootRef]);
}

export interface ConsoleProps {
  source: ConsoleSource;
  analyzer: NanoAnalyzer | null;
  initialTerms?: string;
  environment?: string;
  expanded?: boolean;
  onToggleExpand?: () => void;
}

export function Console({ source, analyzer, initialTerms = "", environment = "Demo, local", expanded = false, onToggleExpand }: ConsoleProps) {
  const env = useMemo(() => ({ source, analyzer, environment, initialTerms }), [source, analyzer, environment, initialTerms]);
  return (
    <ConsoleContext.Provider value={env}>
      <Shell expanded={expanded} onToggleExpand={onToggleExpand} />
    </ConsoleContext.Provider>
  );
}

function Shell({ expanded, onToggleExpand }: { expanded: boolean; onToggleExpand?: () => void }) {
  const { source } = useEnv();
  const route = useRoute();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [density, setDensityState] = useState<Density>(loadDensity);
  const [manualOpen, setManualOpen] = useState(false);
  const setDensity = (d: Density): void => {
    setDensityState(d);
    try {
      localStorage.setItem(DENSITY_KEY, JSON.stringify({ density: d }));
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  };
  useAutoOpen(rootRef);
  useAutoOpenInspection(rootRef);
  const events = useEvents();
  const full = route.page === "traffic" && route.id !== undefined && route.view === "full";

  let center: ReactNode;
  let inspector: ReactNode = null;
  switch (route.page) {
    case "overview":
      center = <Overview />;
      inspector = <ActivityFeed events={events} />;
      break;
    case "traffic":
      if (full && route.id) {
        center = <RequestPage id={route.id} />;
        inspector = <RequestFactsColumn id={route.id} />;
      } else {
        center = <Traffic route={route} density={density} setDensity={setDensity} />;
        inspector = route.id ? <RequestInspector id={route.id} /> : <SelectRequest />;
      }
      break;
    case "profiles":
      center = <Profiles route={route} />;
      break;
    case "policies":
      center = <Policies />;
      break;
    case "inspection":
      center = <Inspection />;
      break;
    case "audit":
      center = <Audit route={route} />;
      break;
    case "hosts":
      center = <Hosts />;
      break;
  }
  const inspectorOpen = manualOpen || (route.page === "traffic" && route.id !== undefined && !full);

  return (
    <div className="al-console" data-testid="console" ref={rootRef} data-expanded={expanded || undefined}>
      <div className={`ac-frame ${source.extension ? "ac-frame-ext" : ""}`}>
        <TopBar expanded={expanded} onToggleExpand={onToggleExpand} onToggleInspector={() => setManualOpen((o) => !o)} />
        <AttachStrip />
        <div className={`ac-body ${inspector ? "ac-has-insp" : ""}`}>
          <Nav page={route.page} />
          <main className="ac-main" id="ac-main" key={route.page}>
            {center}
          </main>
          {inspector && (
            <aside className="ac-insp" data-open={inspectorOpen} aria-label="Details" onKeyDown={(e) => e.key === "Escape" && setManualOpen(false)}>
              {inspector}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
