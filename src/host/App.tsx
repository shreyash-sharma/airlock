import { useState } from "react";
import { cloudModel } from "../firebase.js";
import { DemoBar } from "./DemoBar.js";
import { readDocumentFile } from "./pdf.js";
import { PRESET_TASKS, SAMPLE_CONTRACT, SAMPLE_CONTRACT_TITLE } from "./sample-contract.js";

type Answer =
  | { status: "idle" }
  | { status: "asking" }
  | { status: "done"; text: string; source: string | undefined }
  | { status: "error"; message: string };

/**
 * A plain Firebase AI Logic document assistant. It knows nothing about AIRLOCK: it just calls the SDK.
 * The guard installed in main.tsx holds and rewrites the real network request.
 */
export function App() {
  const [doc, setDoc] = useState(SAMPLE_CONTRACT);
  const [task, setTask] = useState(PRESET_TASKS[0].task);
  const [answer, setAnswer] = useState<Answer>({ status: "idle" });
  const [docNote, setDocNote] = useState<string | null>(null);

  const openFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const result = await readDocumentFile(file);
      setDoc(result.text);
      setDocNote(result.warning ?? `${file.name}: ${result.pages} page(s) read on this device.`);
    } catch (e) {
      setDocNote(e instanceof Error ? e.message : String(e));
    }
  };

  const ask = async () => {
    setAnswer({ status: "asking" });
    try {
      const result = await cloudModel.generateContent([task, doc]);
      setAnswer({ status: "done", text: result.response.text(), source: result.response.inferenceSource });
    } catch (e) {
      setAnswer({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <DemoBar />
      <section className="h-card" aria-label="Document">
        <h2>Document</h2>
        <div className="h-row">
          <button className="h-btn" onClick={() => setDoc(SAMPLE_CONTRACT)}>Load sample contract</button>
          <label className="h-btn" style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
            Open .txt or PDF
            <input type="file" accept=".txt,.pdf,text/plain,application/pdf" hidden onChange={(e) => void openFile(e.target.files?.[0])} />
          </label>
          <span className="h-note">{docNote ?? (doc === SAMPLE_CONTRACT ? SAMPLE_CONTRACT_TITLE : "Custom text")}</span>
        </div>
        <textarea className="h-text" value={doc} onChange={(e) => setDoc(e.target.value)} aria-label="Document text" spellCheck={false} />
      </section>

      <section className="h-card" aria-label="Task">
        <h2>Ask about it</h2>
        <div className="h-row">
          {PRESET_TASKS.map((p) => (
            <button key={p.label} className="h-chip" onClick={() => setTask(p.task)}>{p.label}</button>
          ))}
        </div>
        <textarea className="h-task" value={task} onChange={(e) => setTask(e.target.value)} aria-label="Task" rows={3} />
        <div className="h-row">
          <button className="h-btn primary" onClick={ask} disabled={answer.status === "asking" || !doc.trim() || !task.trim()}>
            {answer.status === "asking" ? "Waiting for your approval or the cloud…" : "Ask Gemini"}
          </button>
        </div>
        <div className="h-answer" aria-live="polite">
          {answer.status === "idle" && <span className="h-note">The answer will appear here, as the app receives it.</span>}
          {answer.status === "error" && <span className="h-error">{answer.message}</span>}
          {answer.status === "done" && (
            <>
              <div className="h-note">Answer received by the app (SDK reports: {answer.source ?? "no source"})</div>
              <div className="h-answer-text">{answer.text}</div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
