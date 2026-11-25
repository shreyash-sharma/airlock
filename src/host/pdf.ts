import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { itemsToText, type PdfItem } from "./pdf-lines.js";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface ExtractedDocument {
  text: string;
  pages: number;
  /** Plain-words warning when the result may be unusable (for example a scanned PDF). */
  warning?: string;
}

/** Read a .txt or text-based .pdf entirely on this device. */
export async function readDocumentFile(file: File): Promise<ExtractedDocument> {
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") return extractPdfText(file);
  const text = (await file.text()).replace(/\r\n?/g, "\n");
  return { text, pages: 1 };
}

export async function extractPdfText(file: File): Promise<ExtractedDocument> {
  const buffer = await file.arrayBuffer();
  const head = new TextDecoder().decode(new Uint8Array(buffer.slice(0, 5)));
  if (head !== "%PDF-") throw new Error("This file does not look like a PDF.");

  // pdf.js transfers the buffer to its worker, so give it a copy.
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push(itemsToText(content.items as unknown as PdfItem[]));
  }
  const text = pages.join("\n\n").trim();
  const warning =
    text.length < 25 * pdf.numPages
      ? "Almost no text was found. This may be a scanned PDF, which AIRLOCK cannot read yet. Paste the text instead."
      : undefined;
  return { text, pages: pdf.numPages, warning };
}
