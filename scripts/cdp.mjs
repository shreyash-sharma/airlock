// Minimal Chrome DevTools Protocol helper for browser checks (Node 22 global fetch and WebSocket).
// Start Chrome first with scripts/chrome-nano.ps1 (remote debugging on port 9222).
//   node scripts/cdp.mjs eval  <urlPrefix> "<js expression>"
//   node scripts/cdp.mjs shot  <urlPrefix> <out.png>
//   node scripts/cdp.mjs reload <urlPrefix>
import fs from "node:fs";

const PORT = process.env.CDP_PORT ?? "9222";

export async function connect(urlPrefix) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  let target = targets.find((t) => t.type === "page" && t.url.startsWith(urlPrefix));
  if (!target) {
    target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${urlPrefix}`, { method: "PUT" })).json();
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      (listeners.get(m.method) ?? []).forEach((cb) => cb(m.params));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  if (process.env.CDP_VIEWPORT) {
    // e.g. CDP_VIEWPORT=1920x1080 to check the layout at recording resolution
    const [width, height] = process.env.CDP_VIEWPORT.split("x").map(Number);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }
  return {
    send,
    on: (method, cb) => listeners.set(method, [...(listeners.get(method) ?? []), cb]),
    /** Evaluate in the page. userGesture:true so clicks count as user activation (Nano needs it). */
    async evalJs(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async screenshot(file) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(file.replace(/[\\/][^\\/]*$/, "") || ".", { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, "base64"));
    },
    close: () => ws.close(),
  };
}

if (process.argv[1] && process.argv[1].endsWith("cdp.mjs")) {
  const [cmd, prefix, arg] = process.argv.slice(2);
  const page = await connect(prefix);
  try {
    if (cmd === "eval") console.log(JSON.stringify(await page.evalJs(arg)));
    else if (cmd === "shot") await page.screenshot(arg);
    else if (cmd === "reload") await page.send("Page.reload");
    else console.log("usage: cdp.mjs eval|shot|reload <urlPrefix> [arg]");
  } finally {
    page.close();
  }
}
