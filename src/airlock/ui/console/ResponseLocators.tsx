import { useState } from "react";
import type { InspectItem } from "../../inspect/session.js";
import type { InspectionLike } from "./data.js";
import { Btn, Card, Chip, ErrorList } from "./kit.js";

const DECIDED = new Set(["saved", "discarded", "passed-through"]);

/**
 * Response locators and read coverage for the draft. Code (not the model) proposes them from value-free shapes of
 * answers AIRLOCK saw from this host. Accepted ones are already in the draft; nothing is saved until you approve.
 */
export function ResponseLocators({ item, store }: { item: InspectItem; store: InspectionLike }) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string[]>([]);
  const s = item.suggestions;
  const locked = DECIDED.has(item.status);
  const methods = item.profile?.match.methods ?? [];
  if (!item.profile) return null;
  return (
    <Card
      title="Response locators"
      caption="Where in an answer your protected values come back, so the page shows the real values again. Suggested by code from an observed response, not by the model."
      testId="response-locators"
    >
      {s && s.locators.length > 0 ? (
        <div className="ac-fieldtable">
          {s.locators.map((l) => (
            <label className="ac-fieldrow ac-fieldrow-locator" key={l.locator}>
              <input type="checkbox" checked={l.accepted} disabled={locked} aria-label={`Restore at ${l.locator}`} onChange={(e) => void store.setLocatorAccepted(item.id, l.locator, e.target.checked)} />
              <span className="ac-mono ac-fieldpath">{l.locator}</span>
              <span className="ac-note ac-muted">
                {l.observed ? `Observed ${l.from}` : l.from}
                {l.observed ? `, ${l.resolves} text value(s) below it in the sample shape` : ""}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="ac-muted">No answer from this host has been observed yet. Let the page load its lists, or type a locator below.</p>
      )}
      <div className="ac-row">
        <span>Covers methods:</span>
        <span className="ac-mono">{methods.length > 0 ? methods.join(", ") : "any"}</span>
        {s?.getAdded && <Chip tone="ok" icon="check">GET added</Chip>}
      </div>
      {s?.addGet && !s.getAdded && (
        <div className="ac-row" data-testid="add-get">
          <span className="ac-note ac-attn">This profile only matches {methods.join(", ") || "writes"}, so a read of this host is held or blocked and its answer is not restored. Add GET to cover reads of these paths and one record below each?</span>
          <Btn variant="soft" size="sm" icon="plus" disabled={locked} onClick={() => void store.addGet(item.id)}>Add GET</Btn>
        </div>
      )}
      <form
        className="ac-addrule"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim() === "") return;
          void store.addLocator(item.id, typed.trim()).then((r) => {
            setProblem(r.ok ? [] : [r.error ?? "That locator was not accepted."]);
            if (r.ok) setTyped("");
          });
        }}
      >
        <input className="ac-input ac-mono" aria-label="Add a response locator" placeholder="$.list[*]" value={typed} spellCheck={false} disabled={locked} onChange={(e) => setTyped(e.target.value)} />
        <Btn variant="secondary" size="sm" type="submit" disabled={locked}>Add locator</Btn>
      </form>
      <ErrorList errors={problem} title="Not added" />
    </Card>
  );
}
