import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Console } from "../../airlock/ui/console/Console.js";
import type { ChromeLike } from "../chrome-api.js";
import { PanelClient } from "./client.js";
import { createHostsController, type HostsChrome } from "./hosts-controller.js";
import { createRemoteSource } from "./remote-source.js";
import "./panel.css";

type TabsApi = {
  query(q: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number }>>;
  onActivated?: { addListener(l: (info: { tabId: number; windowId: number }) => void): void };
};
type WindowsApi = { getCurrent(): Promise<{ id?: number }> };
type PanelChrome = ChromeLike & HostsChrome & { tabs?: TabsApi; windows?: WindowsApi };

/**
 * The side panel: the same React console the web app has, in its narrow layout, driven by a RemoteSource over the
 * PanelClient. The page does the work (it holds the engine); the panel shows what the page publishes and sends the
 * user's decisions back. A panel opened with ?tab=ID is pinned to that tab (the automated check does this); the
 * real side panel follows the active tab.
 */
function App({ client, chrome, following }: { client: PanelClient; chrome: PanelChrome; following: boolean }) {
  const remote = useMemo(() => {
    const hosts = createHostsController(chrome);
    void hosts.refresh();
    return createRemoteSource(client, { hosts, following });
  }, [client, chrome, following]);
  useEffect(() => () => remote.dispose(), [remote]);
  const notice = useSyncExternalStore(remote.notice.subscribe, remote.notice.get);
  return (
    <div className="ext-root" data-testid="ext-root">
      <Console source={remote.source} analyzer={null} environment="Chrome extension" />
      {notice && (
        <div className="ext-notice" role="alert" data-testid="ext-notice">
          <span>{notice.text}</span>
          <button type="button" className="ac-btn ac-btn-ghost ac-btn-sm" onClick={remote.notice.clear}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

async function main(): Promise<void> {
  const root = document.getElementById("root") as HTMLElement;
  const chrome = (globalThis as { chrome?: PanelChrome }).chrome;
  if (!chrome?.runtime?.id) {
    root.textContent = "AIRLOCK side panel: the extension API is not available here.";
    return;
  }
  const client = new PanelClient(chrome);
  const fromQuery = Number(new URLSearchParams(location.search).get("tab"));
  const pinned = Number.isInteger(fromQuery) && fromQuery > 0 ? fromQuery : null;
  const tabId = pinned ?? (await chrome.tabs?.query({ active: true, currentWindow: true }))?.[0]?.id;
  if (typeof tabId === "number") client.attach(tabId);
  if (pinned === null && chrome.tabs?.onActivated) {
    const windowId = (await chrome.windows?.getCurrent().catch(() => undefined))?.id;
    chrome.tabs.onActivated.addListener((info) => {
      if (windowId === undefined || info.windowId === windowId) client.attach(info.tabId);
    });
  }
  createRoot(root).render(<App client={client} chrome={chrome} following={pinned === null} />);
}

void main();
