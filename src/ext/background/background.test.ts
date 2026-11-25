import { describe, expect, it } from "vitest";
import { HOSTS_STORAGE_KEY, DEV_DEFAULT_HOSTS, PAGE_PORT_NAME, PANEL_PORT_NAME } from "../protocol.js";
import { FakeChrome, FakePort, flush } from "../test-support/fakes.js";
import { startBackground } from "./index.js";
import { HostList, planRegistration, scriptsFor } from "./hosts.js";

const A = "https://app.example.com/*";
const B = "http://127.0.0.1:5173/*";

describe("host registration diffing", () => {
  it("registers the MAIN script and the bridge for each wanted host, at document_start", () => {
    const [main, bridge] = scriptsFor(A);
    expect(main).toMatchObject({ world: "MAIN", runAt: "document_start", js: ["page.js"], matches: [A] });
    expect(bridge).toMatchObject({ world: "ISOLATED", runAt: "document_start", js: ["bridge.js"], matches: [A] });
  });

  it("adding a host registers only the new scripts", () => {
    const plan = planRegistration([A, B], scriptsFor(A));
    expect(plan.unregister).toEqual([]);
    expect(plan.register.map((s) => s.id).sort()).toEqual(scriptsFor(B).map((s) => s.id).sort());
  });

  it("narrowing unregisters exactly the removed host and leaves foreign scripts alone", () => {
    const foreign = { id: "someone-elses", matches: ["https://x.test/*"], js: ["x.js"] };
    const plan = planRegistration([A], [...scriptsFor(A), ...scriptsFor(B), foreign]);
    expect(plan.unregister.sort()).toEqual(scriptsFor(B).map((s) => s.id).sort());
    expect(plan.register).toEqual([]);
  });

  it("re-registers a script whose definition changed", () => {
    const stale = { ...scriptsFor(A)[0], runAt: "document_idle" as const };
    const plan = planRegistration([A], [stale, scriptsFor(A)[1]]);
    expect(plan.unregister).toEqual([stale.id]);
    expect(plan.register.map((s) => s.id)).toEqual([stale.id]);
  });
});

describe("HostList against a fake chrome.scripting", () => {
  it("registers for granted hosts only, and narrowing really removes the scripts", async () => {
    const chrome = new FakeChrome();
    const list = new HostList(chrome);
    chrome.granted.add(A);
    expect((await list.set([A, B])).ok).toBe(true);
    let state = await list.sync();
    expect(state.registered).toEqual([A]); // B is configured but the browser has not granted it
    expect([...chrome.registered.keys()].sort()).toEqual(scriptsFor(A).map((s) => s.id).sort());

    chrome.granted.add(B);
    state = await list.sync();
    expect(state.registered.sort()).toEqual([B, A].sort());

    await list.set([A]);
    state = await list.sync();
    expect(state.registered).toEqual([A]);
    expect([...chrome.registered.keys()].some((id) => id.includes("127.0.0.1"))).toBe(false);

    await list.set([]);
    await list.sync();
    expect(chrome.registered.size).toBe(0);
  });

  it("refuses an invalid list and keeps the stored one", async () => {
    const chrome = new FakeChrome();
    const list = new HostList(chrome);
    await list.set([A]);
    const bad = await list.set(["https://*/*"]);
    expect(bad.ok).toBe(false);
    expect(await list.configured()).toEqual([A]);
  });

  it("starts from the dev default, and a damaged stored value falls back to nothing, never to everything", async () => {
    const chrome = new FakeChrome();
    const list = new HostList(chrome);
    expect(await list.configured()).toEqual([...DEV_DEFAULT_HOSTS]);
    await list.seed();
    expect(chrome.storageData[HOSTS_STORAGE_KEY]).toEqual([...DEV_DEFAULT_HOSTS]);
    chrome.storageData[HOSTS_STORAGE_KEY] = "garbage";
    expect(await list.configured()).toEqual([]);
    chrome.storageData[HOSTS_STORAGE_KEY] = ["<all_urls>", A];
    expect(await list.configured()).toEqual([A]);
  });

  it("does not run two syncs at once", async () => {
    const chrome = new FakeChrome();
    chrome.granted.add(A);
    const list = new HostList(chrome);
    await list.set([A]);
    await Promise.all([list.sync(), list.sync(), list.sync()]); // a duplicate-id error would reject here
    expect(chrome.registered.size).toBe(2);
  });
});

describe("router", () => {
  const ext = (c: FakeChrome) => ({ id: c.extensionId, url: c.runtime.getURL("sidepanel.html") });
  const page = (c: FakeChrome, tab = 3, frameId = 0) => ({ id: c.extensionId, url: "https://app.example.com/x", tab: { id: tab }, frameId });

  it("refuses a panel port that is not one of the extension's own pages", async () => {
    const chrome = new FakeChrome();
    startBackground(chrome);
    chrome.nextSender = page(chrome);
    const port = chrome.runtime.connect({ name: PANEL_PORT_NAME }) as FakePort;
    await flush();
    expect(port.closed).toBe(true);
  });

  it("refuses a page port without a tab, and unknown port names", async () => {
    const chrome = new FakeChrome();
    startBackground(chrome);
    chrome.nextSender = { id: chrome.extensionId, url: "https://x.test/" };
    const noTab = chrome.runtime.connect({ name: PAGE_PORT_NAME }) as FakePort;
    chrome.nextSender = ext(chrome);
    const unknown = chrome.runtime.connect({ name: "anything" }) as FakePort;
    await flush();
    expect(noTab.closed).toBe(true);
    expect(unknown.closed).toBe(true);
  });

  it("tells a tab's pages 'panel up' on attach and 'panel down' when the panel port closes", async () => {
    const chrome = new FakeChrome();
    startBackground(chrome);
    chrome.nextSender = page(chrome);
    const pagePort = chrome.runtime.connect({ name: PAGE_PORT_NAME });
    const seen: unknown[] = [];
    pagePort.onMessage.addListener((m) => seen.push(m));
    await flush();
    expect(seen).toContainEqual({ type: "panel", up: false });

    chrome.nextSender = ext(chrome);
    const panel = chrome.runtime.connect({ name: PANEL_PORT_NAME });
    panel.postMessage({ type: "attach", tabId: 3 });
    await flush();
    expect(seen).toContainEqual({ type: "panel", up: true });

    panel.disconnect();
    await flush();
    expect(seen.filter((m) => (m as { type: string }).type === "panel").pop()).toEqual({ type: "panel", up: false });
  });

  it("does not let a panel command reach a tab it is not attached to", async () => {
    const chrome = new FakeChrome();
    startBackground(chrome);
    chrome.nextSender = page(chrome, 3);
    const pagePort = chrome.runtime.connect({ name: PAGE_PORT_NAME });
    const seen: Array<{ type: string }> = [];
    pagePort.onMessage.addListener((m) => seen.push(m as { type: string }));
    chrome.nextSender = ext(chrome);
    const panel = chrome.runtime.connect({ name: PANEL_PORT_NAME });
    panel.postMessage({ type: "attach", tabId: 9 }); // a different tab
    panel.postMessage({ type: "command", tabId: 3, frameId: 0, cmdId: "c1", command: { kind: "decide", id: "req-1", decision: "approve" } });
    await flush();
    expect(seen.filter((m) => m.type === "command")).toEqual([]);
  });

  it("only extension pages may read or change the host list", async () => {
    const chrome = new FakeChrome();
    startBackground(chrome);
    const fromPage = (await chrome.sendMessage({ type: "hosts:set", hosts: [A] }, page(chrome))) as { ok: boolean };
    expect(fromPage.ok).toBe(false);
    expect(chrome.storageData[HOSTS_STORAGE_KEY]).toBeUndefined();
    const fromPanel = (await chrome.sendMessage({ type: "hosts:get" }, ext(chrome))) as { ok: boolean; state: { hosts: string[] } };
    expect(fromPanel.ok).toBe(true);
  });
});
