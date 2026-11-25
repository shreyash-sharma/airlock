import { useEffect, useState } from "react";
import { loadOwnFirebase, OWN_FIREBASE_KEY, parseFirebaseConfig } from "../own-firebase.js";

type Nano = "checking" | "ready" | "download" | "missing";

async function nanoState(): Promise<Nano> {
  const api = (globalThis as { LanguageModel?: { availability(): Promise<string> } }).LanguageModel;
  if (!api) return "missing";
  try {
    const a = await api.availability();
    return a === "available" ? "ready" : a === "unavailable" ? "missing" : "download";
  } catch {
    return "missing";
  }
}

const NOTES: Record<Nano, string> = {
  checking: "Checking for on-device Gemini Nano…",
  ready: "On-device Gemini Nano is available in this browser.",
  download: "Gemini Nano is not downloaded yet. Use “Prepare on-device AI” in the console on the right.",
  missing: "This browser has no on-device Gemini Nano (it needs desktop Chrome with the model). AIRLOCK then sends nothing, unless you choose keyword mode, which uses no AI.",
};

/** What a visitor needs to know before asking, and the optional switch to their own Firebase project. */
export function DemoBar() {
  const [nano, setNano] = useState<Nano>("checking");
  const [text, setText] = useState("");
  const [siteKey, setSiteKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const own = loadOwnFirebase();

  useEffect(() => {
    void nanoState().then(setNano);
  }, []);

  const save = () => {
    const config = parseFirebaseConfig(text, siteKey);
    if (!config) return setError("Paste a web config that has apiKey, projectId and appId.");
    localStorage.setItem(OWN_FIREBASE_KEY, JSON.stringify(config));
    location.reload();
  };
  const remove = () => {
    localStorage.removeItem(OWN_FIREBASE_KEY);
    location.reload();
  };

  return (
    <div className="h-demo">
      <span className="h-note">{NOTES[nano]} The sample data is made up; do not paste real secrets into a demo.</span>
      <details className="h-own">
        <summary>{own ? `Using your Firebase project: ${own.projectId}` : "Use my own Firebase (optional)"}</summary>
        <p className="h-note">
          Paste your web app config. It stays in this browser. Your project needs Firebase AI Logic with the Gemini Developer API; if it enforces App Check, add your reCAPTCHA Enterprise site key for this address.
        </p>
        <textarea className="h-task" rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="Firebase web config" placeholder={'apiKey: "…", projectId: "…", appId: "…"'} spellCheck={false} />
        <div className="h-row">
          <input className="h-input" value={siteKey} onChange={(e) => setSiteKey(e.target.value)} placeholder="reCAPTCHA Enterprise site key (optional)" aria-label="reCAPTCHA site key" />
          <button className="h-btn" onClick={save}>Save and reload</button>
          {own && <button className="h-btn" onClick={remove}>Go back to the demo project</button>}
        </div>
        {error && <p className="h-error">{error}</p>}
      </details>
    </div>
  );
}
