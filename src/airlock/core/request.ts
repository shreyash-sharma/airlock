/** Parsing and rebuilding of Gemini generateContent request bodies. */

export interface TextPartRef {
  contentIndex: number;
  partIndex: number;
  text: string;
}

export interface ParsedRequest {
  body: Record<string, unknown>;
  contents: Array<{ role?: string; parts: Array<Record<string, unknown>> }>;
  /** Index of the last user turn, whose parts carry the task and document. */
  userTurn: number;
  /** "task+document" when the user turn has two or more text parts, otherwise "single". */
  shape: "task+document" | "single";
  task: string;
  document: string;
  textParts: TextPartRef[];
  systemInstructionText: string | null;
}

export type ParseResult = { ok: true; request: ParsedRequest } | { ok: false; reason: string };

export function isStreamingUrl(url: string): boolean {
  return /:streamGenerateContent|alt=sse/i.test(url);
}

export function parseGeminiBody(bodyText: string): ParseResult {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { ok: false, reason: "The request body is not JSON." };
  }
  if (!body || typeof body !== "object") return { ok: false, reason: "The request body is not a JSON object." };
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.contents) || obj.contents.length === 0) {
    return { ok: false, reason: "The request has no contents array, so AIRLOCK cannot tell what it would send." };
  }

  const contents = obj.contents as ParsedRequest["contents"];
  const textParts: TextPartRef[] = [];
  for (let c = 0; c < contents.length; c++) {
    const parts = contents[c]?.parts;
    if (!Array.isArray(parts)) return { ok: false, reason: `contents[${c}] has no parts array.` };
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (typeof part.text === "string") {
        textParts.push({ contentIndex: c, partIndex: p, text: part.text });
      } else {
        return {
          ok: false,
          reason: `contents[${c}].parts[${p}] is not plain text (for example an image or file). Phase 1 only guards text.`,
        };
      }
    }
  }

  let userTurn = contents.length - 1;
  for (let c = contents.length - 1; c >= 0; c--) {
    if (contents[c].role === "user" || contents[c].role === undefined) {
      userTurn = c;
      break;
    }
  }
  const turnParts = textParts.filter((t) => t.contentIndex === userTurn);
  const shape = turnParts.length >= 2 ? "task+document" : "single";
  const task = shape === "task+document" ? turnParts[0].text : "";
  const document = shape === "task+document" ? turnParts.slice(1).map((t) => t.text).join("\n\n") : "";

  let systemInstructionText: string | null = null;
  const si = obj.systemInstruction as { parts?: Array<{ text?: unknown }> } | string | undefined;
  if (typeof si === "string") systemInstructionText = si;
  else if (si && Array.isArray(si.parts)) {
    systemInstructionText = si.parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("\n");
  }

  return {
    ok: true,
    request: { body: obj, contents, userTurn, shape, task, document, textParts, systemInstructionText },
  };
}

/** Return a copy of the request body with the given replacements applied. Everything else is kept. */
export function rebuildBody(
  req: ParsedRequest,
  rewrite: {
    /** Replacement parts for the user turn, in order. */
    userTurnParts?: string[];
    /** Mask function applied to every other text part and to the system instruction. */
    maskOther: (text: string) => string;
  },
): string {
  const next = JSON.parse(JSON.stringify(req.body)) as Record<string, unknown>;
  const contents = next.contents as ParsedRequest["contents"];
  contents.forEach((content, c) => {
    if (c === req.userTurn && rewrite.userTurnParts) {
      content.parts = rewrite.userTurnParts.map((text) => ({ text }));
    } else {
      content.parts = content.parts.map((part) => ({ ...part, text: rewrite.maskOther(String(part.text)) }));
    }
  });
  const si = next.systemInstruction as { parts?: Array<{ text?: string }> } | string | undefined;
  if (typeof si === "string") next.systemInstruction = rewrite.maskOther(si);
  else if (si && Array.isArray(si.parts)) {
    si.parts = si.parts.map((p) => (typeof p.text === "string" ? { ...p, text: rewrite.maskOther(p.text) } : p));
  }
  return JSON.stringify(next);
}

/** All outbound text parts joined, for the policy engine and the inspector. */
export function outboundText(bodyText: string): string {
  const parsed = parseGeminiBody(bodyText);
  if (!parsed.ok) return "";
  const parts = parsed.request.textParts.map((t) => t.text);
  if (parsed.request.systemInstructionText) parts.unshift(parsed.request.systemInstructionText);
  return parts.join("\n");
}

/** Restore placeholders inside a non-streaming generateContent response. */
export function restoreResponse(
  responseText: string,
  restore: (text: string) => string,
): { cloudView: string; restoredBody: string; restoredView: string } | null {
  let json: { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
  try {
    json = JSON.parse(responseText);
  } catch {
    return null;
  }
  const cloud: string[] = [];
  const restored: string[] = [];
  for (const cand of json.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      const original = part.text;
      if (typeof original === "string") {
        const back = restore(original);
        cloud.push(original);
        restored.push(back);
        part.text = back;
      }
    }
  }
  return { cloudView: cloud.join("\n"), restoredBody: JSON.stringify(json), restoredView: restored.join("\n") };
}
