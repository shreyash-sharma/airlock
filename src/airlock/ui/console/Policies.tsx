import { useEffect, useState, useSyncExternalStore } from "react";
import { ACTIONS, type Action, type Approval, type Category, type RulesData } from "../../profiles/types.js";
import { ROLES, ROLE_LABEL, ROLE_SUMMARY, type Role } from "../../flows/roles.js";
import { SENSITIVE_CATEGORIES } from "../../flows/rules.js";
import {
  addHostRule,
  CATEGORIES,
  CATEGORY_LABEL,
  destinationLabel,
  destinationSub,
  parseRulesText,
  removeDestination,
  setAllowReads,
  setApproval,
  setDefault,
  setHosts,
  type EditResult,
} from "../pages/rules-model.js";
import { useEnv } from "./data.js";
import { Btn, Card, Chip, ErrorList, Select } from "./kit.js";
import { Icon } from "./icons.js";
import { PageHeader } from "./Overview.js";

const ACTION_OPTIONS = [{ value: "", label: "(none: blocks if sensitive)" }, ...ACTIONS.map((a) => ({ value: a, label: a }))];
const APPROVAL_OPTIONS = [
  { value: "ask", label: "Ask me each time" },
  { value: "auto", label: "Send automatically" },
];

const ACTION_HELP: Record<Action, string> = {
  allow: "Sends the value as it is.",
  mask: "Replaces it with a placeholder; the original stays here.",
  surrogate: "Replaces it with a believable stand-in.",
  token: "Replaces it with a reversible token.",
  drop: "Removes the field.",
  block: "Stops the request.",
};

/** The destination rules in force, reloaded whenever the registry saves them. */
function useRules(): { rules: RulesData | null; custom: boolean } {
  const { source } = useEnv();
  const version = useSyncExternalStore(source.registry.subscribe, source.registry.version);
  const [rules, setRules] = useState<RulesData | null>(null);
  useEffect(() => {
    let live = true;
    void source.loadRules().then((r) => live && setRules(r));
    return () => {
      live = false;
    };
  }, [source, version]);
  return { rules, custom: rules !== null && JSON.stringify(rules) !== JSON.stringify(source.defaultRules) };
}

export function Policies() {
  const { source, initialTerms } = useEnv();
  const { rules, custom } = useRules();
  const [terms, setTerms] = useState(initialTerms);
  const [cleared, setCleared] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [hostDraft, setHostDraft] = useState<Record<string, string>>({});
  const [newHosts, setNewHosts] = useState("");
  const [newKind, setNewKind] = useState<"ai" | "saas">("saas");
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");

  /** Validate an edit, and keep it only when valid. An invalid edit is reported and the stored rules stay as they were. */
  const apply = async (result: EditResult, what: string): Promise<boolean> => {
    setNotice(null);
    if (!result.ok) {
      setErrors(result.errors);
      return false;
    }
    const saved = await source.registry.saveRules(result.rules);
    if (!saved.ok) {
      setErrors(saved.errors);
      return false;
    }
    setErrors([]);
    setNotice(`${what} Applies to the next request.`);
    return true;
  };

  return (
    <div className="ac-page" data-testid="page-policies">
      <PageHeader title="Policies" description="What AIRLOCK covers, what happens to each kind of detail, and the details it always protects." />
      <Card title="What protection covers">
        <p>
          <Chip tone="ok" icon="shield">Protection on: fetch and XHR</Chip>
        </p>
        <p className="ac-muted">Covers fetch and XMLHttpRequest from this page to the hosts configured for it. Other channels are not intercepted.</p>
      </Card>

      <Card title="Viewer role" caption="Who is looking at this page. The same stored record is shown differently to each role: restored values come back only as far as the role allows. This is a policy view on this machine, not a sign-in.">
        {!rules ? (
          <p className="ac-muted">Loading rules.</p>
        ) : (
          <>
            <Select
              label="Viewer role"
              value={rules.viewer ?? "owner"}
              options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
              onChange={(v) => void apply({ ok: true, rules: { ...rules, viewer: v as Role } }, `Now viewing as ${ROLE_LABEL[v as Role]}.`)}
              testId="viewer-role"
            />
            <p className="ac-muted" data-testid="viewer-role-summary">{ROLE_SUMMARY[rules.viewer ?? "owner"]}</p>
          </>
        )}
      </Card>

      <Card
        title="Destination rules"
        caption="Per destination: whether you are asked before a request leaves, and what happens to each category when a profile field has no flow of its own. A field's own flow always wins."
        aside={
          <>
            <Chip tone={custom ? "primary" : "neutral"}>{custom ? "Customised" : "Defaults"}</Chip>
            <Btn variant="secondary" size="sm" disabled={!custom} onClick={() => void apply({ ok: true, rules: source.defaultRules }, "Rules reset to the defaults.")}>Reset to defaults</Btn>
          </>
        }
      >
        <ErrorList errors={errors} title="Not saved: the rules were left as they were" />
        {notice && <div className="ac-banner ac-banner-neutral" role="status" data-testid="rules-notice"><p>{notice}</p></div>}
        {!rules ? (
          <p className="ac-muted">Loading rules.</p>
        ) : (
          <div className="ac-tablewrap">
            <table className="ac-table ac-matrix" data-testid="rules-matrix">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  {rules.destinations.map((d) => (
                    <th scope="col" key={d.id} className="ac-matrix-head">
                      <span className="ac-host">{destinationLabel(d)}</span>
                      <span className="ac-note ac-muted">{destinationSub(d)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Before it leaves</th>
                  {rules.destinations.map((d) => (
                    <td key={d.id}>
                      <Select label={`Approval for ${destinationLabel(d)}`} value={d.approval} options={APPROVAL_OPTIONS} onChange={(v) => void apply(setApproval(rules, d.id, v as Approval), "Approval changed.")} testId={`approval-${d.id}`} />
                    </td>
                  ))}
                </tr>
                {CATEGORIES.map((c: Category) => (
                  <tr key={c}>
                    <th scope="row">{CATEGORY_LABEL[c]}</th>
                    {rules.destinations.map((d) => {
                      const action = d.defaults[c];
                      const risky = action === "allow" && SENSITIVE_CATEGORIES.has(c);
                      return (
                        <td key={d.id}>
                          <Select
                            label={`${CATEGORY_LABEL[c]} at ${destinationLabel(d)}`}
                            value={action ?? ""}
                            options={ACTION_OPTIONS}
                            onChange={(v) => void apply(setDefault(rules, d.id, c, v as Action | ""), `${CATEGORY_LABEL[c]} now ${v || "has no default"} for ${destinationLabel(d)}.`)}
                            testId={`rule-${d.id}-${c}`}
                          />
                          {risky ? <span className="ac-note ac-attn">Sends this category unchanged.</span> : action && <span className="ac-note ac-muted">{ACTION_HELP[action]}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr>
                  <th scope="row">Applies to hosts</th>
                  {rules.destinations.map((d) => {
                    const hostRule = d.match.hosts !== undefined;
                    const draft = hostDraft[d.id] ?? (d.match.hosts ?? []).join(", ");
                    return (
                      <td key={d.id}>
                        {hostRule ? (
                          <>
                            <input
                              className="ac-input ac-mono"
                              aria-label={`Hosts for ${d.id}`}
                              value={draft}
                              spellCheck={false}
                              onChange={(e) => setHostDraft({ ...hostDraft, [d.id]: e.target.value })}
                              onBlur={() => hostDraft[d.id] !== undefined && void apply(setHosts(rules, d.id, hostDraft[d.id]), "Hosts changed.").then((ok) => ok && setHostDraft(({ [d.id]: _gone, ...rest }) => rest))}
                              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                            />
                            <Btn variant="ghost" size="sm" icon="trash" onClick={() => void apply(removeDestination(rules, d.id), "Host rule removed.")}>Remove rule</Btn>
                          </>
                        ) : (
                          <span className="ac-muted ac-note">every {d.match.kind === "ai" ? "AI" : d.match.kind === "saas" ? "SaaS" : ""} host without a rule of its own</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {rules && (
          <form
            className="ac-addrule"
            onSubmit={(e) => {
              e.preventDefault();
              void apply(addHostRule(rules, newHosts, newKind), "Host rule added.").then((ok) => ok && setNewHosts(""));
            }}
          >
            <input className="ac-input ac-mono" aria-label="Hosts for a new rule" placeholder="crm.example.com" value={newHosts} spellCheck={false} onChange={(e) => setNewHosts(e.target.value)} />
            <Select label="Kind of the new rule" value={newKind} options={[{ value: "saas", label: "SaaS" }, { value: "ai", label: "AI" }]} onChange={(v) => setNewKind(v as "ai" | "saas")} />
            <Btn variant="soft" icon="plus" type="submit">Add host rule</Btn>
          </form>
        )}
        <details className="ac-details" open={jsonOpen} onToggle={(e) => { const open = (e.target as HTMLDetailsElement).open; setJsonOpen(open); if (open && rules) setJsonText(JSON.stringify(rules, null, 2)); }}>
          <summary>Edit as JSON</summary>
          <textarea className="ac-code ac-jsonarea" aria-label="Rules JSON" spellCheck={false} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
          <div className="ac-btn-row">
            <Btn variant="secondary" size="sm" onClick={() => void apply(parseRulesText(jsonText), "Rules saved from JSON.")}>Validate and save</Btn>
          </div>
        </details>
      </Card>

      <Card
        title="Reads without a body"
        caption="Off by default, and only for a host you name. A single-page app loads its own data with GET requests that no profile covers; with this on for its host, each such GET or HEAD is sent after its URL is scanned for sensitive values, and every one is listed in the audit log. Writes, and anything with a body, are never affected."
        testId="allow-reads-card"
      >
        {!rules ? (
          <p className="ac-muted">Loading rules.</p>
        ) : rules.destinations.filter((d) => (d.match.hosts?.length ?? 0) > 0).length === 0 ? (
          <p className="ac-muted">Add a rule for a host above, then allow reads for it here.</p>
        ) : (
          <div className="ac-fieldtable">
            {rules.destinations
              .filter((d) => (d.match.hosts?.length ?? 0) > 0)
              .map((d) => (
                <label className="ac-fieldrow ac-fieldrow-locator" key={d.id}>
                  <input
                    type="checkbox"
                    checked={d.allowReads === true}
                    aria-label={`Allow reads without a body for ${destinationLabel(d)}`}
                    data-testid={`allow-reads-${d.id}`}
                    onChange={(e) => void apply(setAllowReads(rules, d.id, e.target.checked), e.target.checked ? "Reads without a body are now allowed for this host." : "Reads without a body are held or blocked again for this host.")}
                  />
                  <span className="ac-mono ac-fieldpath">{destinationLabel(d)}</span>
                  <span className="ac-note ac-muted">{d.allowReads === true ? "Allowed: each read is URL-scanned and audited." : "Off: a read no profile covers is held or blocked."}</span>
                </label>
              ))}
          </div>
        )}
      </Card>

      <Card title="Always protect" caption="Your own details, comma separated. They are masked wherever they appear.">
        <input
          className="ac-input"
          value={terms}
          aria-label="Details to always protect"
          placeholder="For example a name or an address"
          onChange={(e) => {
            setTerms(e.target.value);
            source.setProtectedTerms(e.target.value.split(",").map((t) => t.trim()).filter(Boolean));
          }}
        />
      </Card>
      <Card title="Local data">
        <p className="ac-muted">
          <Icon name="lock" size={14} />{" "}
          {source.extension
            ? "Original values are kept in the protected site's own local storage in this browser, unencrypted. Scripts on that site can read it."
            : "Original values are kept only in this browser's local storage."}
        </p>
        <div className="ac-btn-row">
          <Btn variant="danger" onClick={() => void source.clearLocalData().then(() => setCleared(true))}>Clear local data</Btn>
          {cleared && <span className="ac-muted" role="status">Local data cleared.</span>}
        </div>
      </Card>
    </div>
  );
}
