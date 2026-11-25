import { pageModels } from "./models.js";
import { startPageRuntime } from "./runtime.js";

/**
 * The MAIN-world entry, injected at document_start on the configured hosts. It runs in the page's own JavaScript
 * world so it can wrap that page's fetch and XMLHttpRequest before any page script runs. It talks only to the
 * ISOLATED bridge, over a private MessagePort (see link.ts).
 */
(function airlockPageEntry() {
  const marker = Symbol.for("airlock.ext.page");
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (g[marker]) return; // already injected into this document
  Object.defineProperty(globalThis, marker, { value: true, enumerable: false });

  // Capture the timers now: page code that runs later cannot swap them out from under the gate.
  const timers = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };

  startPageRuntime({
    win: window as unknown as Parameters<typeof startPageRuntime>[0]["win"],
    host: location.host,
    now: Date.now.bind(Date),
    timers,
    models: pageModels,
  });
})();
