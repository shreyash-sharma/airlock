import { vi } from "vitest";
import { STRICT_RULES } from "../../airlock/flows/rules.js";
import { installAirlock } from "../../airlock/install.js";
import type { Profile } from "../../airlock/profiles/types.js";
import { SETTINGS_STORAGE_KEY } from "../protocol.js";
import { startBackground } from "../background/index.js";
import { startBridge, type BridgeHandle, type ChannelPair } from "../bridge/bridge.js";
import { PanelClient } from "../panel/client.js";
import { startPageRuntime, type PageRuntime } from "../page/runtime.js";
import { FakeChrome, FakeWindow, flush } from "./fakes.js";

/**
 * The whole extension wired together in memory: a page (engine, link, gate, remote adapter) and its bridge in one
 * FakeWindow, a background on a FakeChrome, and a side-panel client. Unit-test harness only: it runs the real
 * extension code over fakes of the browser API, not inside Chrome.
 */
export const TAB = 7;
export const CRM_HOST = "127.0.0.1:5173";
export const CRM_URL = `http://${CRM_HOST}/mock-crm/api/contacts`;
export const HOST_PATTERN = "http://127.0.0.1:5173/*";
export const RAW_EMAIL = "rohan.mehta@example.com";
export const RAW_PHONE = "9876543210";
export const SAMPLE = JSON.stringify({
  properties: { firstname: "Rohan", lastname: "Mehta", email: RAW_EMAIL, phone: RAW_PHONE, city: "Pune", plan: "Enterprise", salary: "68000", internal_note: "Renewal is at risk." },
});

export const CRM_PROFILE: Profile = {
  version: 1,
  id: "mock-crm-contacts",
  name: "Mock CRM contacts",
  kind: "saas",
  pipeline: "field-protect",
  match: { hosts: [CRM_HOST], paths: ["/mock-crm/api/**"] },
  request: {
    fields: [
      { path: "$.properties.firstname", category: "identifier", flow: { action: "surrogate" } },
      { path: "$.properties.lastname", category: "identifier", flow: { action: "surrogate" } },
      { path: "$.properties.email", category: "contact", flow: { action: "token" } },
      { path: "$.properties.phone", category: "contact", flow: { action: "token" } },
      { path: "$.properties.salary", category: "financial", flow: { action: "token" } },
      { path: "$.properties.internal_note", category: "free_text", flow: { action: "drop" } },
      { path: "$.properties.city", category: "non_sensitive", flow: { action: "allow" } },
      { path: "$.properties.plan", category: "non_sensitive", flow: { action: "allow" } },
    ],
  },
  response: { fields: [{ path: "$.results[*].properties" }, { path: "$.properties" }] },
  author: { by: "user", at: "2026-11-24T00:00:00.000Z" },
};

export interface World {
  chrome: FakeChrome;
  win: FakeWindow;
  page: PageRuntime;
  bridge: BridgeHandle;
  panel: PanelClient | null;
  /** Bodies the fake network received, in order. */
  sent: Array<{ url: string; body: string | null }>;
  background: ReturnType<typeof startBackground>;
  attachPanel(): Promise<PanelClient>;
  teardown(): void;
}

export async function waitFor(cond: () => boolean, what: string, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await flush(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function makeWorld(opts: { holdTimeoutMs?: number; grant?: boolean; storedTimeoutMs?: number } = {}): Promise<World> {
  const chrome = new FakeChrome();
  if (opts.storedTimeoutMs !== undefined) chrome.storageData[SETTINGS_STORAGE_KEY] = { holdTimeoutMs: opts.storedTimeoutMs };
  if (opts.grant !== false) chrome.granted.add(HOST_PATTERN);
  const win = new FakeWindow();
  const sent: World["sent"] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: typeof init?.body === "string" ? init.body : null });
    return new Response(init?.body ?? "{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const background = startBackground(chrome);
  await background.hosts.seed();
  await background.hosts.sync();

  // MAIN world first (document_start), then the ISOLATED bridge, exactly as a tab would.
  const page = startPageRuntime({
    win,
    host: CRM_HOST,
    now: () => Date.now(),
    timers: {
      setTimeout: (f, ms) => setTimeout(f, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (f, ms) => setInterval(f, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
    install: (o) => installAirlock({ ...o, rules: { ...STRICT_RULES, destinations: STRICT_RULES.destinations.map((d) => ({ ...d, approval: "ask" as const })) }, profiles: [CRM_PROFILE] }),
    holdTimeoutMs: opts.holdTimeoutMs,
    publishDelayMs: 0,
    localStatus: async () => "unavailable",
  });
  chrome.nextSender = { id: chrome.extensionId, url: `http://${CRM_HOST}/crm-test.html`, tab: { id: TAB }, frameId: 0 };
  const bridge = startBridge({
    win,
    chrome,
    newChannel: () => new MessageChannel() as unknown as ChannelPair,
    nonce: () => "0123456789abcdef0123456789abcdef",
    setInterval: (f, ms) => setInterval(f, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  await waitFor(() => bridge.paired(), "the page and bridge to pair");

  const world: World = {
    chrome,
    win,
    page,
    bridge,
    panel: null,
    sent,
    background,
    async attachPanel() {
      chrome.nextSender = { id: chrome.extensionId, url: chrome.runtime.getURL("sidepanel.html") };
      const client = new PanelClient(chrome, { commandTimeoutMs: 5_000 });
      world.panel = client;
      client.attach(TAB);
      await waitFor(() => page.link.panelUp(), "the page to see the panel");
      await waitFor(() => (client.getState().frames[0]?.snapshot?.seq ?? 0) > 0, "the first snapshot");
      return client;
    },
    teardown() {
      world.panel?.close();
      bridge.stop();
      page.stop();
      globalThis.fetch = realFetch;
      vi.useRealTimers();
    },
  };
  return world;
}
