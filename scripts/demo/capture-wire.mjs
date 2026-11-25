// Records the exact bytes Chrome sends to Firebase AI Logic (read from Chrome's own network layer over DevTools), so the film can search
// the real body and compare its SHA-256 with the wire hash AIRLOCK shows. Start it BEFORE pressing Ask Gemini; it exits after one request.
//   node scripts/demo/capture-wire.mjs      -> scripts/out/demo/wire-body.txt and wire-body.sha256.txt
import crypto from "node:crypto";
import fs from "node:fs";
import { connect } from "../cdp.mjs";

const page = await connect("http://127.0.0.1:5173");
await page.send("Network.enable");
console.log("listening for the request to firebasevertexai.googleapis.com ...");
await new Promise((resolve) => {
  page.on("Network.requestWillBeSent", async (e) => {
    if (!e.request.url.includes("firebasevertexai.googleapis.com") || e.request.method !== "POST") return;
    let body = e.request.postData;
    if (body === undefined) body = (await page.send("Network.getRequestPostData", { requestId: e.requestId })).postData;
    const bytes = Buffer.from(body, "utf8");
    fs.mkdirSync("scripts/out/demo", { recursive: true });
    fs.writeFileSync("scripts/out/demo/wire-body.txt", bytes);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync("scripts/out/demo/wire-body.sha256.txt", `SHA-256 of the ${bytes.length} bytes Chrome sent\n${hash}\n`);
    console.log("captured", bytes.length, "bytes, sha256", hash);
    resolve();
  });
});
page.close();
process.exit(0);
