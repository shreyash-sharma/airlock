import { useMemo, useRef, useState } from "react";
import { ACTIONS, CATEGORIES, type Action, type Category, type FieldSpec, type Profile } from "../../profiles/types.js";
import {
  addField,
  AUTHOR_LABEL,
  changedLabel,
  deleteSummary,
  draftErrors,
  exportJson,
  hostsLabel,
  ORIGIN_LABEL,
  parseImport,
  parseProfileText,
  profileRows,
  removeField,
  setField,
  stampUser,
  type ProfileRow,
  type Side,
} from "../pages/profiles-model.js";
import { useEnv, useProfileEntries } from "./data.js";
import { Btn, Card, Chip, ConfirmDialog, EmptyState, ErrorList, Segmented, Select, Tabs, type Tone } from "./kit.js";
import { Icon } from "./icons.js";
import { PageHeader } from "./Overview.js";
import { go, hrefFor, type Route } from "./router.js";

const AUTHOR_TONE: Record<Profile["author"]["by"], Tone> = { builtin: "neutral", user: "primary", on_device: "ok", in_cloud: "cloud" };

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function AuthorChip({ by }: { by: Profile["author"]["by"] }) {
  return (
    <Chip tone={AUTHOR_TONE[by]} icon={by === "on_device" ? "cpu" : by === "in_cloud" ? "cloud" : by === "user" ? "pencil" : "shield"}>
      {AUTHOR_LABEL[by]}
    </Chip>
  );
}

export function Profiles({ route }: { route: Route }) {
  const entries = useProfileEntries();
  if (route.id) {
    const entry = entries.find((e) => e.profile.id === route.id);
    if (entry) return <ProfileEditor key={entry.profile.id} profile={entry.profile} origin={entry.origin} />;
  }
  return <ProfileList notFound={route.id} />;
}

type KindFilter = "all" | "ai" | "saas";

function ProfileList({ notFound }: { notFound?: string }) {
  const { source } = useEnv();
  const entries = useProfileEntries();
  const rows = useMemo(() => profileRows(entries), [entries]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const now = Date.now();
  const shown = rows.filter((r) => (kind === "all" || r.kind === kind) && (query.trim() === "" || `${r.name} ${r.id} ${r.hosts.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())));
  const stored = entries.filter((e) => e.origin === "stored").map((e) => e.profile);

  const importFile = async (file: File | undefined): Promise<void> => {
    setProblems([]);
    setNotice(null);
    if (!file) return;
    if (file.size > 512 * 1024) return setProblems(["file: larger than 512 KB"]);
    const parsed = parseImport(await file.text());
    if (!parsed.ok) return setProblems(parsed.errors);
    const saved = await source.registry.saveMany(parsed.items);
    if (!saved.ok) return setProblems(saved.errors);
    setNotice(`Imported ${saved.profiles.length} profile(s). They apply to the next request.`);
  };

  return (
    <div className="ac-page" data-testid="page-profiles">
      <PageHeader
        title="Profiles"
        description="How AIRLOCK recognises a request and which fields in it matter."
        actions={
          <>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden data-testid="profiles-import-input" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
            <Btn variant="secondary" icon="upload" onClick={() => fileRef.current?.click()}>Import JSON</Btn>
            <Btn variant="secondary" icon="download" disabled={stored.length === 0} onClick={() => download("airlock-profiles.json", exportJson(stored))} title={stored.length === 0 ? "No profile is stored in this browser yet" : undefined}>
              Export stored
            </Btn>
          </>
        }
      />
      {notFound && <div className="ac-banner ac-banner-attention" role="status"><p>No profile with the id {notFound} exists.</p></div>}
      {notice && <div className="ac-banner ac-banner-neutral" role="status" data-testid="profiles-notice"><p>{notice}</p></div>}
      <ErrorList errors={problems} title="Import refused: nothing was saved" />
      <Card>
        <div className="ac-toolbar">
          <label className="ac-search">
            <Icon name="search" size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, id or host" aria-label="Search profiles" />
          </label>
          <Segmented<KindFilter> label="Kind" value={kind} onChange={setKind} options={[{ value: "all", label: "All", count: rows.length }, { value: "ai", label: "AI", count: rows.filter((r) => r.kind === "ai").length }, { value: "saas", label: "SaaS", count: rows.filter((r) => r.kind === "saas").length }]} />
        </div>
        {shown.length === 0 ? (
          <EmptyState icon="profiles" title="No profile matches">
            Clear the search, or teach AIRLOCK a new service on the Inspection page.
          </EmptyState>
        ) : (
          <div className="ac-tablewrap">
            <table className="ac-table" data-testid="profiles-table">
              <thead>
                <tr>
                  <th>Profile</th>
                  <th className="c-hosts">Hosts</th>
                  <th>Kind</th>
                  <th>Authored by</th>
                  <th className="c-num">Fields</th>
                  <th className="c-num c-flows">Flows</th>
                  <th className="c-lat">Last changed</th>
                  <th><span className="ac-sr">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <ProfileRowView key={r.id} r={r} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="ac-note ac-muted">Stored profiles are kept in this browser. Built-in profiles ship with AIRLOCK and the app can supply its own; those are read-only, and can be duplicated into a profile you own.</p>
      </Card>
    </div>
  );
}

function ProfileRowView({ r, now }: { r: ProfileRow; now: number }) {
  return (
    <tr onClick={() => go(hrefFor("profiles", r.id))} data-testid={`profile-row-${r.id}`}>
      <td className="c-name">
        <a className="ac-host" href={hrefFor("profiles", r.id)} onClick={(e) => e.stopPropagation()}>{r.name}</a>
        <span className="ac-path ac-mono">{r.id} · {ORIGIN_LABEL[r.origin]}</span>
        <span className="ac-path ac-mono ac-only-narrow">{hostsLabel(r.hosts)}</span>
      </td>
      <td className="c-hosts ac-mono ac-muted">{hostsLabel(r.hosts)}</td>
      <td><Chip tone={r.kind === "ai" ? "cloud" : "masked"}>{r.kind === "ai" ? "AI" : "SaaS"}</Chip></td>
      <td><AuthorChip by={r.authoredBy} /></td>
      <td className="c-num ac-tnum">{r.fields}</td>
      <td className="c-num c-flows ac-tnum">{r.flows}</td>
      <td className="c-lat ac-muted">{changedLabel(r.changedAt, now)}</td>
      <td><Icon name="chevron" size={16} /></td>
    </tr>
  );
}

const CATEGORY_OPTIONS = [{ value: "", label: "(no category)" }, ...CATEGORIES.map((c) => ({ value: c, label: c }))];
const ACTION_OPTIONS = [{ value: "", label: "(default for category)" }, ...ACTIONS.map((a) => ({ value: a, label: a }))];

function FieldTable({ side, draft, setDraft, readOnly }: { side: Side; draft: Profile; setDraft: (p: Profile) => void; readOnly: boolean }) {
  const fields = draft[side].fields;
  const patch = (i: number, f: FieldSpec): void => setDraft(setField(draft, side, i, f));
  return (
    <div className="ac-fieldtable" data-testid={`fields-${side}`}>
      {fields.length === 0 && <p className="ac-muted ac-note">No {side} field is listed. {side === "request" ? "Detected values are still masked by the destination defaults." : "Nothing in the answer is restored by locator."}</p>}
      {fields.map((f, i) => (
        <div className="ac-fieldrow" key={i}>
          <input
            className="ac-input ac-mono"
            aria-label={`${side} field ${i + 1} locator`}
            value={f.path}
            disabled={readOnly}
            spellCheck={false}
            onChange={(e) => patch(i, { ...f, path: e.target.value })}
          />
          {side === "request" ? (
            <>
              <Select label={`${side} field ${i + 1} category`} value={f.category ?? ""} options={CATEGORY_OPTIONS} disabled={readOnly} onChange={(v) => { const { category: _c, ...rest } = f; patch(i, v ? { ...rest, category: v as Category } : rest); }} />
              <Select
                label={`${side} field ${i + 1} action`}
                value={f.flow?.action ?? ""}
                options={ACTION_OPTIONS}
                disabled={readOnly}
                onChange={(v) => { const { flow, ...rest } = f; patch(i, v ? { ...rest, flow: { ...flow, action: v as Action } } : rest); }}
              />
            </>
          ) : (
            <span className="ac-muted ac-note ac-fieldnote">answer value, restored on return</span>
          )}
          {!readOnly && <Btn variant="ghost" size="sm" icon="trash" aria-label={`Remove ${side} field ${i + 1}`} onClick={() => setDraft(removeField(draft, side, i))} />}
        </div>
      ))}
      {!readOnly && (
        <Btn variant="soft" size="sm" icon="plus" onClick={() => setDraft(addField(draft, side))}>
          Add {side} field
        </Btn>
      )}
    </div>
  );
}

function ProfileEditor({ profile, origin }: { profile: Profile; origin: ProfileRow["origin"] }) {
  const { source } = useEnv();
  const readOnly = origin !== "stored";
  const [draft, setDraft] = useState<Profile>(profile);
  const [tab, setTab] = useState<"fields" | "json">("fields");
  const [jsonText, setJsonText] = useState("");
  const [jsonErrors, setJsonErrors] = useState<string[]>([]);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile);
  const live = useMemo(() => [...draftErrors(draft), ...(draft.id !== profile.id ? ["id: cannot be changed here, duplicate the profile instead"] : [])], [draft, profile.id]);
  const errors = tab === "json" && jsonErrors.length > 0 ? jsonErrors : live;
  const hostsText = draft.match.hosts.join(", ");

  const change = (p: Profile): void => {
    setDraft(p);
    setNotice(null);
    setSaveErrors([]);
  };
  const csv = (t: string): string[] => t.split(",").map((x) => x.trim()).filter(Boolean);

  const save = async (): Promise<void> => {
    const stamped = stampUser(draft, Date.now());
    const r = await source.registry.save(stamped);
    if (!r.ok) return setSaveErrors(r.errors);
    setDraft(r.profile);
    setNotice("Saved. It applies to the next request, and the profile is now marked as authored by you.");
  };
  const remove = async (): Promise<void> => {
    setConfirm(false);
    const r = await source.registry.remove(profile.id);
    if (r.ok) go(hrefFor("profiles"));
    else setSaveErrors([r.reason ?? "The profile could not be deleted."]);
  };
  const duplicate = async (): Promise<void> => {
    const copy: Profile = { ...profile, id: `user-${profile.id}`.slice(0, 64), name: `${profile.name} (copy)`.slice(0, 120), author: { by: "user", at: new Date().toISOString() } };
    const r = await source.registry.save(copy);
    if (r.ok) go(hrefFor("profiles", r.profile.id));
    else setSaveErrors(r.errors);
  };

  return (
    <div className="ac-page" data-testid="page-profile-detail">
      <nav className="ac-crumbs" aria-label="Breadcrumb">
        <a href={hrefFor("profiles")}>Profiles</a>
        <Icon name="chevron" size={14} />
        <span>{profile.name}</span>
      </nav>
      <PageHeader
        title={profile.name}
        description={`${profile.id} · ${ORIGIN_LABEL[origin]} · ${profile.kind === "ai" ? "AI service" : "SaaS service"} · pipeline ${profile.pipeline}`}
        actions={
          <>
            <AuthorChip by={profile.author.by} />
            <Btn variant="secondary" icon="download" onClick={() => download(`${profile.id}.json`, exportJson([profile]))}>Export JSON</Btn>
            {readOnly ? (
              <Btn variant="primary" icon="copy" onClick={() => void duplicate()}>Duplicate as my profile</Btn>
            ) : (
              <Btn variant="danger" icon="trash" onClick={() => setConfirm(true)} data-testid="profile-delete">Delete</Btn>
            )}
          </>
        }
      />
      {readOnly && (
        <div className="ac-banner ac-banner-neutral" role="status">
          <p>This profile is read-only because it is {origin === "app" ? "supplied by the app" : "built into AIRLOCK"}. Duplicate it to change it.</p>
        </div>
      )}
      {notice && <div className="ac-banner ac-banner-neutral" role="status" data-testid="profile-notice"><p>{notice}</p></div>}
      <ErrorList errors={saveErrors.length > 0 ? saveErrors : dirty || errors.length > 0 ? errors : []} />

      <Card title="Match" caption="Which requests this profile applies to. Hosts are exact names, never wildcards.">
        <div className="ac-formgrid">
          <label className="ac-labelled">
            <span className="ac-fact-k">Name</span>
            <input className="ac-input" value={draft.name} disabled={readOnly} onChange={(e) => change({ ...draft, name: e.target.value })} />
          </label>
          <label className="ac-labelled">
            <span className="ac-fact-k">Hosts (comma separated)</span>
            <input className="ac-input ac-mono" aria-label="Hosts" value={hostsText} disabled={readOnly} spellCheck={false} onChange={(e) => change({ ...draft, match: { ...draft.match, hosts: csv(e.target.value) } })} />
          </label>
          <label className="ac-labelled">
            <span className="ac-fact-k">Paths (globs, comma separated)</span>
            <input className="ac-input ac-mono" aria-label="Paths" value={draft.match.paths.join(", ")} disabled={readOnly} spellCheck={false} onChange={(e) => change({ ...draft, match: { ...draft.match, paths: csv(e.target.value) } })} />
          </label>
          <label className="ac-labelled">
            <span className="ac-fact-k">Methods (empty means any)</span>
            <input className="ac-input ac-mono" aria-label="Methods" value={(draft.match.methods ?? []).join(", ")} disabled={readOnly} spellCheck={false} onChange={(e) => { const m = csv(e.target.value); const { methods: _m, ...rest } = draft.match; change({ ...draft, match: m.length ? { ...rest, methods: m } : rest }); }} />
          </label>
        </div>
      </Card>

      <Card
        title="Fields and flows"
        caption="A locator picks the values; the category says what they are; the action says what happens to them. A container such as $ covers every text value beneath it."
        aside={<Tabs<"fields" | "json"> label="Editor" value={tab} onChange={(t) => { if (t === "json") { setJsonText(JSON.stringify(draft, null, 2)); setJsonErrors([]); } setTab(t); }} tabs={[{ value: "fields", label: "Fields" }, { value: "json", label: "JSON" }]} />}
      >
        {tab === "fields" ? (
          <>
            <h3 className="ac-h3">Request fields</h3>
            <FieldTable side="request" draft={draft} setDraft={change} readOnly={readOnly} />
            <h3 className="ac-h3">Response fields</h3>
            <FieldTable side="response" draft={draft} setDraft={change} readOnly={readOnly} />
          </>
        ) : (
          <textarea
            className="ac-code ac-jsonarea"
            aria-label="Profile JSON"
            spellCheck={false}
            value={jsonText}
            readOnly={readOnly}
            onChange={(e) => {
              setJsonText(e.target.value);
              const r = parseProfileText(e.target.value);
              if (r.ok) {
                setJsonErrors([]);
                change(r.profile);
              } else setJsonErrors(r.errors);
            }}
          />
        )}
      </Card>

      {!readOnly && (
        <div className="ac-btn-row">
          <Btn variant="primary" icon="check" disabled={!dirty || errors.length > 0} onClick={() => void save()} data-testid="profile-save">Save changes</Btn>
          <Btn variant="secondary" disabled={!dirty} onClick={() => { setDraft(profile); setJsonText(JSON.stringify(profile, null, 2)); setJsonErrors([]); setSaveErrors([]); }}>Revert</Btn>
          <span className="ac-note ac-muted">{dirty ? (errors.length > 0 ? `${errors.length} problem(s): nothing is saved until they are fixed.` : "Unsaved changes.") : "No changes."}</span>
        </div>
      )}
      <ConfirmDialog open={confirm} title="Delete this profile?" confirmLabel="Delete profile" danger onConfirm={() => void remove()} onCancel={() => setConfirm(false)}>
        <p>{deleteSummary(profile)}</p>
      </ConfirmDialog>
    </div>
  );
}
