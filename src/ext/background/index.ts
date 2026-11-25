import type { ChromeLike } from "../chrome-api.js";
import { clampHoldTimeout, HOSTS_STORAGE_KEY, SETTINGS_STORAGE_KEY } from "../protocol.js";
import { HostList } from "./hosts.js";
import { Router } from "./router.js";

/** Wire the service worker to a Chrome API. Exported for tests; the worker entry below calls it with the real one. */
export function startBackground(chrome: ChromeLike): { router: Router; hosts: HostList } {
  const hosts = new HostList(chrome);
  const router = new Router(chrome, hosts, async () => {
    const stored = (await chrome.storage.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY] as { holdTimeoutMs?: unknown } | undefined;
    return clampHoldTimeout(stored?.holdTimeoutMs);
  });

  const resync = (): void => {
    void hosts.sync().then(() => router.pushHosts()).catch(() => undefined);
  };

  chrome.runtime.onConnect.addListener((port) => router.onConnect(port));
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void router.onRequest(message, sender).then(sendResponse, () => sendResponse({ ok: false, errors: ["AIRLOCK could not do that."] }));
    return true; // the answer is asynchronous
  });
  chrome.runtime.onInstalled.addListener(() => void hosts.seed().then(() => hosts.sync()).catch(() => undefined));
  chrome.runtime.onStartup.addListener(resync);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && HOSTS_STORAGE_KEY in changes) resync();
    if (area === "local" && SETTINGS_STORAGE_KEY in changes) void router.pushSettings();
  });
  chrome.permissions.onAdded.addListener(resync);
  chrome.permissions.onRemoved.addListener(resync);
  return { router, hosts };
}

const real = (globalThis as { chrome?: ChromeLike & { sidePanel?: { setPanelBehavior(o: { openPanelOnActionClick: boolean }): Promise<void> } } }).chrome;
if (real?.runtime?.id) {
  startBackground(real);
  // The toolbar button opens the side panel.
  void real.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
}
