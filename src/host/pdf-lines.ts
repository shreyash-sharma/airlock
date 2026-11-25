/** A text item as pdf.js reports it: transform[4] is x, transform[5] is y (origin bottom-left). */
export interface PdfItem {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

/**
 * Turn pdf.js text items into readable lines and paragraphs: group items that share a baseline,
 * order them left to right, and put a blank line where the vertical gap is clearly larger than a line.
 * Multi-column layouts are a known limitation: columns are read straight across.
 */
export function itemsToText(items: PdfItem[]): string {
  const real = items.filter((i) => i.str.trim().length > 0 && Array.isArray(i.transform));
  if (!real.length) return "";
  const sorted = [...real].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);

  const lines: Array<{ y: number; parts: PdfItem[] }> = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - item.transform[5]) <= 2.5) last.parts.push(item);
    else lines.push({ y: item.transform[5], parts: [item] });
  }

  const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter((g) => g > 0);
  const typical = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 12;

  let out = "";
  lines.forEach((line, i) => {
    const text = line.parts
      .sort((a, b) => a.transform[4] - b.transform[4])
      .map((p) => p.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (i > 0) out += lines[i - 1].y - line.y > typical * 1.6 ? "\n\n" : "\n";
    out += text;
  });
  return out;
}
