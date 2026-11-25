import { describe, expect, it } from "vitest";
import { splitClauses } from "../core/clauses.js";
import { LocalAIError } from "../core/types.js";
import { NanoAnalyzer, type LocalModelLike } from "./local.js";

const doc = Array.from({ length: 12 }, (_, i) => `${i + 1}. Clause ${i + 1}\n${"word ".repeat(60)}\n`).join("\n");
const clauses = splitClauses(doc);

function fakeModel(replies: Array<string | Error>, source: string | undefined = "on_device") {
  const prompts: string[] = [];
  const model: LocalModelLike = {
    async generateContent(prompt) {
      prompts.push(prompt);
      const next = replies.shift() ?? '{"relevant":[]}';
      if (next instanceof Error) throw next;
      return { response: { text: () => next, inferenceSource: source } };
    },
    async initializeDeviceModel() {},
  };
  return { model, prompts };
}
const ready = async () => "ready" as const;

describe("NanoAnalyzer", () => {
  it("keeps only valid ids, in document order, with reasons", async () => {
    const { model } = fakeModel(['{"relevant":[{"id":"C5","reason":"salary"},{"id":"C2","reason":"start"},{"id":"C99","reason":"bogus"}]}']);
    const sel = await new NanoAnalyzer(() => model, { status: ready }).select("task", clauses);
    expect(sel.ids).toEqual(["C2", "C5"]);
    expect(sel.reasons.C5).toBe("salary");
    expect(sel.source).toBe("on_device");
  });
  it("batches long outlines under the per-call budget", async () => {
    const { model, prompts } = fakeModel([]);
    await new NanoAnalyzer(() => model, { status: ready, maxCallChars: 700 }).select("task", clauses);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.every((p) => p.length < 2500)).toBe(true);
  });
  it("retries once on malformed JSON, then fails closed", async () => {
    const { model, prompts } = fakeModel(["not json", '{"relevant":[{"id":"C1","reason":"ok"}]}']);
    const sel = await new NanoAnalyzer(() => model, { status: ready }).select("task", clauses);
    expect(sel.ids).toEqual(["C1"]);
    expect(prompts).toHaveLength(2);
    const bad = fakeModel(["x", "y"]);
    await expect(new NanoAnalyzer(() => bad.model, { status: ready }).select("task", clauses)).rejects.toMatchObject({ kind: "malformed" });
  });
  it("refuses when the SDK did not report on-device inference", async () => {
    const { model } = fakeModel(['{"relevant":[]}'], "in_cloud");
    await expect(new NanoAnalyzer(() => model, { status: ready }).select("task", clauses)).rejects.toBeInstanceOf(LocalAIError);
  });
  it("refuses when the local model is not ready", async () => {
    const { model, prompts } = fakeModel([]);
    const notReady = async () => "downloadable" as const;
    await expect(new NanoAnalyzer(() => model, { status: notReady }).select("task", clauses)).rejects.toMatchObject({ kind: "not-ready" });
    expect(prompts).toHaveLength(0);
  });
});

describe("extractRelevant", () => {
  it("reads fenced JSON and salvages truncated JSON", async () => {
    const { extractRelevant } = await import("./local.js");
    const fenced = '```json\n{"relevant":[{"id":"C3","reason":"salary"},{"id":"C4","reason":"bonus"}]}\n```';
    expect(extractRelevant(fenced)).toEqual([
      { id: "C3", reason: "salary" },
      { id: "C4", reason: "bonus" },
    ]);
    const cut = '```json\n{"relevant":[{"id":"C3","reason":"salary"},{"id":"C7","reason":"non-comp';
    expect(extractRelevant(cut)?.map((r) => r.id)).toEqual(["C3", "C7"]);
    expect(extractRelevant("no json here")).toBeNull();
  });
});
