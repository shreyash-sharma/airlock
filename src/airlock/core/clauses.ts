import type { Clause } from "./types.js";

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

// A clause starts at "3. Title", "3.1 Title", "3) Title" or "Section 3 Title". A bare "3 months" does not.
const HEADING =
  /^[ \t]*(?:(?:clause|section|article)[ \t]+\d+(?:\.\d+)*[.)]?|\d+(?:\.\d+)*[.)])[ \t]+\S/i;

export interface SplitOptions {
  /** Longest clause kept whole, in characters. Longer ones are split at blank lines, then sentences. */
  maxChars?: number;
}

function splitLong(text: string, from: number, to: number, maxChars: number): number[] {
  // Returns extra cut points inside [from, to) so every piece is at most maxChars.
  const cuts: number[] = [];
  let start = from;
  while (to - start > maxChars) {
    const window = text.slice(start, start + maxChars);
    let cut = window.lastIndexOf("\n\n");
    if (cut < maxChars * 0.3) {
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"));
      cut = sentence > maxChars * 0.3 ? sentence + 1 : maxChars;
    } else {
      cut += 2;
    }
    start += cut;
    cuts.push(start);
  }
  return cuts;
}

/**
 * Split a document into clauses C1..Cn. The pieces are contiguous and cover the whole string, so
 * clause offsets always map back into the original text and nothing is ever dropped silently.
 */
export function splitClauses(text: string, opts: SplitOptions = {}): Clause[] {
  const maxChars = opts.maxChars ?? 6000;
  if (!text.trim()) return [];

  const cutSet = new Set<number>([0]);
  let pos = 0;
  let headings = 0;
  for (const line of text.split("\n")) {
    if (HEADING.test(line)) {
      cutSet.add(pos);
      headings++;
    }
    pos += line.length + 1;
  }
  if (headings < 2) {
    cutSet.clear();
    cutSet.add(0);
    const blank = /\n[ \t]*\n+/g;
    let m: RegExpExecArray | null;
    while ((m = blank.exec(text))) cutSet.add(m.index + m[0].length);
  }

  const base = [...cutSet].filter((c) => c < text.length).sort((a, b) => a - b);
  const bounds: number[] = [];
  base.forEach((from, i) => {
    const to = i + 1 < base.length ? base[i + 1] : text.length;
    bounds.push(from, ...splitLong(text, from, to, maxChars));
  });
  bounds.push(text.length);

  const pieces: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end <= start) continue;
    if (!text.slice(start, end).trim() && pieces.length) {
      pieces[pieces.length - 1].end = end; // whitespace-only: attach to the previous clause
    } else {
      pieces.push({ start, end });
    }
  }

  return pieces.map((p, i) => {
    const body = text.slice(p.start, p.end);
    const firstLine = body.split("\n").find((l) => l.trim()) ?? "";
    return {
      id: `C${i + 1}`,
      heading: firstLine.trim().slice(0, 80),
      text: body,
      start: p.start,
      end: p.end,
      tokens: estimateTokens(body),
    };
  });
}
