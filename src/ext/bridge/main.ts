import type { ChromeLike } from "../chrome-api.js";
import { startBridge } from "./bridge.js";

/** ISOLATED-world entry: the page's only route to the extension. */
(function airlockBridgeEntry() {
  const chrome = (globalThis as { chrome?: ChromeLike }).chrome;
  if (!chrome?.runtime) return;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  startBridge({
    win: window as unknown as Parameters<typeof startBridge>[0]["win"],
    chrome,
    newChannel: () => new MessageChannel() as unknown as ReturnType<Parameters<typeof startBridge>[0]["newChannel"]>,
    nonce: () => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  });
})();
