import { useState, useSyncExternalStore } from "react";
import type { LocalState } from "../../ai/local.js";
import { useEnv, type HostRow, type HostsController } from "./data.js";
import { Btn, Card, Chip, EmptyState, type Tone } from "./kit.js";
import { Icon } from "./icons.js";
import { PageHeader } from "./Overview.js";

const MODEL_CHIP: Record<LocalState, { tone: Tone; text: string }> = {
  ready: { tone: "ok", text: "On-device AI ready" },
  downloadable: { tone: "attention", text: "On-device AI needs a download" },
  downloading: { tone: "attention", text: "On-device AI downloading" },
  unavailable: { tone: "blocked", text: "On-device AI unavailable" },
  unsupported: { tone: "blocked", text: "No on-device AI in this browser" },
};

const NEVER = (): (() => void) => () => undefined;

/** What the side panel says about the tab it watches, and what happens when it is closed. Extension only. */
export function AttachStrip() {
  const { source } = useEnv();
  const ext = source.extension;
  const a = useSyncExternalStore(ext ? ext.subscribe : NEVER, ext ? ext.attachment : () => null);
  if (!ext || !a) return null;
  const model = MODEL_CHIP[ext.model.state()];
  const label = !a.connected ? "Not connected to the extension" : a.attached ? `Watching ${a.hosts.join(", ") || "this page"}` : "Not attached to a protected page";
  return (
    <div className="ac-attach" data-testid="attach-strip" data-attached={a.attached}>
      <div className="ac-row">
        <Chip tone={a.attached ? "ok" : "attention"} icon={a.attached ? "shield" : "alert"}>
          {label}
        </Chip>
        {a.attached && (
          <Chip tone={model.tone} icon="cpu" title="Gemini Nano as the protected page sees it">
            {model.text}
          </Chip>
        )}
      </div>
      <span className="ac-note ac-attach-note">
        {a.attached
          ? `Tab ${a.tabId}. CRM and SaaS requests are masked and sent at once, never held. A request that waits for your approval (to an AI host) is blocked after ${a.timeoutMs ? Math.round(a.timeoutMs / 1000) : "the timeout"} s, and closing this panel or watching another tab blocks it too.`
          : a.following
            ? "This tab is not on your host list, or needs a reload after you add it. Requests held in a tab this panel is not watching are blocked."
            : `Tab ${a.tabId ?? "?"} has no protected page. Requests held in a tab this panel is not watching are blocked.`}
      </span>
    </div>
  );
}

function HostItem({ row, c, onStatus }: { row: HostRow; c: HostsController; onStatus: (s: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string; note?: string }>): Promise<void> => {
    setBusy(true);
    onStatus(null);
    const r = await fn();
    setBusy(false);
    onStatus(r.ok ? (r.note ?? null) : (r.error ?? "That did not work."));
  };
  const state = row.granted ? (row.registered ? "protecting" : "starting") : "needs-access";
  return (
    <li className="ac-hostrow" data-testid="host-row" data-host={row.name} data-state={state}>
      <div className="ac-hostmain">
        <span className="ac-mono ac-hostname">{row.name}</span>
        <span className="ac-muted ac-note ac-mono">{row.pattern}</span>
        <div className="ac-row">
          {row.granted ? <Chip tone="ok" icon="check">Access granted</Chip> : <Chip tone="attention" icon="alert">Access needed</Chip>}
          {row.registered ? <Chip tone="ok" icon="shield">Protecting</Chip> : <Chip tone="neutral">Not running</Chip>}
        </div>
      </div>
      <div className="ac-btn-row">
        {!row.granted && (
          <Btn variant="primary" size="sm" disabled={busy} data-testid="host-grant" onClick={() => void run(() => c.add(row.name))}>
            Grant access
          </Btn>
        )}
        <Btn variant="secondary" size="sm" icon="trash" disabled={busy} data-testid="host-remove" onClick={() => void run(() => c.remove(row.pattern))}>
          Remove
        </Btn>
      </div>
    </li>
  );
}

function AddHost({ c }: { c: HostsController }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    // The permission request runs synchronously inside this click, so the browser sees a user gesture.
    setError(null);
    setBusy(true);
    void c.add(text).then((r) => {
      setBusy(false);
      if (r.ok) setText("");
      else setError(r.error);
    });
  };
  return (
    <form
      className="ac-addhost"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="ac-labelled">
        <span className="ac-note">Host name</span>
        <input
          className="ac-input"
          value={text}
          placeholder="crm.example.com"
          aria-label="Host to protect"
          aria-invalid={error ? true : undefined}
          aria-describedby="add-host-help"
          spellCheck={false}
          autoComplete="off"
          data-testid="host-input"
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
      </label>
      <Btn variant="primary" icon="plus" type="submit" disabled={busy || text.trim() === ""} data-testid="host-add">
        Add and grant access
      </Btn>
      <p className="ac-note ac-muted" id="add-host-help">
        A host name only, such as <span className="ac-mono">crm.example.com</span>, <span className="ac-mono">*.example.com</span> or <span className="ac-mono">localhost:3000</span>. No scheme and no path. HTTPS is used; local addresses use HTTP.
      </p>
      {error && (
        <div className="ac-banner ac-banner-blocked" role="alert" data-testid="host-error">
          <p>{error}</p>
        </div>
      )}
    </form>
  );
}

function TimeoutCard({ c, ms }: { c: HostsController; ms: number }) {
  const [text, setText] = useState(String(Math.round(ms / 1000)));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = (): void => {
    const n = Number(text);
    void c.setHoldTimeout(n).then((r) => {
      if (r.ok) {
        setText(String(r.seconds));
        setMsg({ ok: true, text: `Saved: ${r.seconds} s.` });
      } else setMsg({ ok: false, text: r.error });
    });
  };
  return (
    <Card title="Hold timeout" caption="How long a held request waits for your decision before AIRLOCK blocks it. Between 1 and 600 seconds; the default is 120.">
      <form
        className="ac-addhost"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="ac-labelled">
          <span className="ac-note">Seconds</span>
          <input className="ac-input" inputMode="numeric" value={text} aria-label="Hold timeout in seconds" data-testid="timeout-input" onChange={(e) => (setText(e.target.value), setMsg(null))} />
        </label>
        <Btn variant="secondary" type="submit" data-testid="timeout-save">
          Save timeout
        </Btn>
      </form>
      {msg && (
        <p className={`ac-note ${msg.ok ? "ac-muted" : "ac-blocked-text"}`} role="status" data-testid="timeout-msg">
          {msg.text}
        </p>
      )}
    </Card>
  );
}

/** The configured hosts, their permissions, and the hold timeout. Only the extension's side panel has this. */
export function Hosts() {
  const { source } = useEnv();
  const ext = source.extension;
  const c = ext?.hosts;
  const [status, setStatus] = useState<string | null>(null);
  const view = useSyncExternalStore(c ? c.subscribe : () => () => undefined, c ? c.getSnapshot : () => null);
  if (!c || !view) {
    return (
      <div className="ac-page" data-testid="page-hosts">
        <PageHeader title="Hosts" description="Which sites AIRLOCK protects." />
        <Card>
          <EmptyState icon="globe" title="Hosts belong to the Chrome extension">
            In this web app, protection covers the hosts the app configures. The Chrome extension lets you choose them here.
          </EmptyState>
        </Card>
      </div>
    );
  }
  return (
    <div className="ac-page" data-testid="page-hosts">
      <PageHeader title="Hosts" description="AIRLOCK runs only on the sites listed here. Chrome asks you to allow each one, and nothing else is touched." />
      <Card title="Protected hosts" testId="hosts-card">
        {view.problem && (
          <div className="ac-banner ac-banner-blocked" role="alert" data-testid="hosts-problem">
            <p>{view.problem}</p>
          </div>
        )}
        {!view.loaded ? (
          <p className="ac-muted">Reading the host list.</p>
        ) : view.rows.length === 0 ? (
          <EmptyState icon="globe" title="No hosts yet">
            Add a host to start protecting its requests. Until you do, AIRLOCK does nothing on any site.
          </EmptyState>
        ) : (
          <ul className="ac-hostlist" aria-label="Configured hosts">
            {view.rows.map((r) => (
              <HostItem key={r.pattern} row={r} c={c} onStatus={setStatus} />
            ))}
          </ul>
        )}
        {status && (
          <p className="ac-note ac-attn" role="status" data-testid="hosts-status">
            {status}
          </p>
        )}
        <AddHost c={c} />
        <p className="ac-note ac-muted">
          <Icon name="lock" size={14} /> Removing a host stops AIRLOCK from protecting it: requests to that site are then sent as the page makes them. After adding a host, reload its tab.
        </p>
      </Card>
      <TimeoutCard key={view.holdTimeoutMs} c={c} ms={view.holdTimeoutMs} />
    </div>
  );
}
