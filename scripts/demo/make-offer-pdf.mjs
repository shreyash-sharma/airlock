// Prints the synthetic sample contract as a designed, believable PDF (letterhead, headings, signature block) with Chrome itself.
// Same invented text and values as the plain sample (src/host/sample-contract.ts), so AIRLOCK's detectors and clause splitter behave the same.
//   node scripts/demo/make-offer-pdf.mjs      (Chrome from scripts/chrome-nano.ps1 must be running)  ->  scripts/out/offer-letter.pdf
import fs from "node:fs";
import path from "node:path";
import { connect } from "../cdp.mjs";

const src = fs.readFileSync("src/host/sample-contract.ts", "utf8");
const body = src.match(/SAMPLE_CONTRACT = `([\s\S]*?)`;/)?.[1];
if (!body) throw new Error("could not read the sample contract");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const blocks = body.split(/\n\n/).map((b) => b.trim()).filter(Boolean);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Employment Agreement</title><style>
@page { size: A4; margin: 18mm 20mm; }
body { font: 11pt/1.5 Georgia, 'Times New Roman', serif; color: #1b2433; }
.band { background: #16305a; color: #fff; padding: 14px 22px; margin: -2px 0 22px; }
.band b { font: 700 17pt 'Segoe UI', Arial, sans-serif; }
.band div { font: 9pt 'Segoe UI', Arial, sans-serif; opacity: .85; margin-top: 2px; }
h1 { font: 700 18pt 'Segoe UI', Arial, sans-serif; margin: 0 0 14px; letter-spacing: 1px; }
h3 { font: 700 11.5pt 'Segoe UI', Arial, sans-serif; margin: 15px 0 2px; color: #16305a; }
p { margin: 0 0 6px; }
.sig { margin-top: 34px; display: flex; gap: 70px; font: 10pt 'Segoe UI', Arial, sans-serif; }
.sig div { border-top: 1px solid #1b2433; padding-top: 4px; width: 240px; }
</style></head><body>
<div class="band"><b>NORTHWIND ROBOTICS LTD</b><div>12 Canal Street, Manchester M1 4BT &nbsp;·&nbsp; Confidential: employment agreement</div></div>
${blocks
  .map((b, i) => {
    if (i === 0) return `<h1>${esc(b)}</h1>`;
    const [first, ...rest] = b.split("\n");
    if (/^\d+\.\s/.test(first)) return `<h3>${esc(first)}</h3><p>${esc(rest.join(" "))}</p>`;
    return `<p>${esc(b.replace(/\n/g, " "))}</p>`;
  })
  .join("\n")}
<div class="sig"><div>For the Company</div><div>The Employee</div></div>
</body></html>`;
const htmlPath = path.resolve("scripts/out/offer-letter.html");
fs.writeFileSync(htmlPath, html);
const page = await connect("file:///" + htmlPath.replace(/\\/g, "/"));
await page.send("Page.enable");
await new Promise((r) => setTimeout(r, 1200));
const { data } = await page.send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
const out = path.resolve("scripts/out/offer-letter.pdf");
fs.writeFileSync(out, Buffer.from(data, "base64"));
console.log("wrote", out, fs.statSync(out).size, "bytes");
page.close();
const tabs = await (await fetch("http://127.0.0.1:9222/json")).json();
for (const t of tabs) if (t.type === "page" && t.url.includes("offer-letter.html")) await fetch(`http://127.0.0.1:9222/json/close/${t.id}`);
