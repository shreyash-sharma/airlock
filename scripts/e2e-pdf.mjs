// Real-browser check of PDF input: Chrome prints the sample contract to a PDF, then the app reads it.
//   node scripts/e2e-pdf.mjs
import fs from "node:fs";
import path from "node:path";
import { connect } from "./cdp.mjs";

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const source = fs.readFileSync("src/host/sample-contract.ts", "utf8");
const contract = source.slice(source.indexOf("`") + 1, source.indexOf("`", source.indexOf("`") + 1));

// 1. Print the contract to a PDF from a throwaway tab.
const printer = await connect("about:blank");
await printer.evalJs(
  `document.body.innerHTML='<pre style="white-space:pre-wrap;font:12px/1.5 monospace;margin:24px">'+${JSON.stringify(contract)}.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</pre>'`,
);
const { data } = await printer.send("Page.printToPDF", { printBackground: false });
fs.mkdirSync("scripts/out", { recursive: true });
const pdfPath = path.resolve("scripts/out/sample.pdf");
fs.writeFileSync(pdfPath, Buffer.from(data, "base64"));
printer.close();
check("Chrome produced a PDF", fs.statSync(pdfPath).size > 1000, `${fs.statSync(pdfPath).size} bytes`);

// 2. Feed it to the app through the real file input.
const page = await connect("http://127.0.0.1:5173/");
await page.send("Page.reload");
await new Promise((r) => setTimeout(r, 2500));
await page.send("DOM.enable");
const { root } = await page.send("DOM.getDocument");
const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"]' });
await page.send("DOM.setFileInputFiles", { files: [pdfPath], nodeId });
await new Promise((r) => setTimeout(r, 3000));
const text = await page.evalJs(`document.querySelector('textarea[aria-label="Document text"]')?.value ?? ''`);
const note = await page.evalJs(`document.querySelector('.h-note')?.innerText ?? ''`);
await page.screenshot("scripts/out/e2e-pdf.png");
page.close();

check("app read text out of the PDF", text.length > 800, `${text.length} chars; note: ${note}`);
check("PDF text keeps the clauses", /Salary and bonus/.test(text) && /Non-compete/.test(text));
check("PDF text keeps the sensitive values (so AIRLOCK can mask them)", text.includes("GB82") || /GB82/.test(text.replace(/\s+/g, "")));
const numbered = (text.match(/^\s*\d+\.\s+\S/gm) ?? []).length;
check("numbered headings survive extraction", numbered >= 12, `${numbered} headings`);
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
