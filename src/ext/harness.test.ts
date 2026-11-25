import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_STALE_MS, DEFAULT_HOLD_TIMEOUT_MS, WINDOW_CHANNEL } from "./protocol.js";
import { REASON_NO_PANEL, REASON_PANEL_CLOSED, reasonTimeout } from "./page/failclosed.js";
import { flush } from "./test-support/fakes.js";
import { CRM_HOST, CRM_URL, HOST_PATTERN, RAW_EMAIL, RAW_PHONE, SAMPLE, TAB, makeWorld, waitFor, type World } from "./test-support/harness.js";

/**
 * The extension's own code (engine in the page, bridge, background, panel client) wired together over a fake Chrome
 * API in memory. This is a unit-test harness, not the real extension in Chrome: scripts/e2e-ext.mjs does that.
 */
let world: World | null = null;
afterEach(() => {
  world?.teardown();
  world = null;
});

const post = (): Promise<Response> => fetch(CRM_URL, { method: "POST", headers: { "content-type": "application/json" }, body: SAMPLE });

/** Start a create, wait until it is held for approval, and return the request id with the pending promise. */
async function holdOne(w: World): Promise<{ id: string; pending: Promise<Response>; outcome: Promise<unknown> }> {
  const pending = post();
  const outcome = pending.then(
    (r) => r,
    (e: unknown) => e,
  );
  await waitFor(() => w.page.installed.store.pendingIds().length === 1, "the request to wait for a decision");
  return { id: w.page.installed.store.pendingIds()[0], pending, outcome };
}

const rawNeverSent = (w: World): void => {
  const everything = JSON.stringify(w.sent);
  expect(everything).not.toContain(RAW_EMAIL);
  expect(everything).not.toContain(RAW_PHONE);
};

describe("extension harness: hold and decide", () => {
  it("holds a fetch, shows it to the panel, and sends protected values only after approval", async () => {
    world = await makeWorld();
    const panel = await world.attachPanel();
    const { id, pending } = await holdOne(world);
    expect(world.sent).toHaveLength(0);

    await waitFor(() => panel.getState().frames[0]?.snapshot?.requests.some((r) => r.id === id && r.status === "awaiting-approval") === true, "the panel to see the held request");
    const res = await panel.command(0, { kind: "decide", id, decision: "approve" });
    expect(res.ok).toBe(true);
    await pending;

    expect(world.sent).toHaveLength(1);
    expect(world.sent[0].url).toBe(CRM_URL);
    rawNeverSent(world);
    expect(world.sent[0].body).toContain("Pune"); // the allowed field survives
  });

  it("deny leaves the network untouched and rejects the page's fetch with the reason", async () => {
    world = await makeWorld();
    const panel = await world.attachPanel();
    const { id, outcome } = await holdOne(world);
    expect((await panel.command(0, { kind: "decide", id, decision: "deny" })).ok).toBe(true);
    const err = await outcome;
    expect(err).toBeInstanceOf(TypeError);
    expect(world.sent).toHaveLength(0);
    expect(world.page.installed.store.get(id)?.status).toBe("denied");
  });

  it("answers a decision for a request that is no longer waiting with a plain error", async () => {
    world = await makeWorld();
    const panel = await world.attachPanel();
    const res = await panel.command(0, { kind: "decide", id: "req-nope", decision: "approve" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not waiting/);
  });
});

describe("extension harness: fail closed (EXT-04)", () => {
  it("blocks at once, with a visible reason, when no side panel is open", async () => {
    world = await makeWorld();
    const out = await post().then(
      () => "sent",
      (e: unknown) => e,
    );
    expect(out).toBeInstanceOf(TypeError);
    expect(String((out as Error).message)).toContain("side panel");
    expect(world.sent).toHaveLength(0);
    const view = world.page.installed.store.getSnapshot()[0];
    expect(view.status).toBe("denied");
    expect(view.message).toBe(REASON_NO_PANEL);
  });

  it("blocks when nobody answers within the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    world = await makeWorld({ holdTimeoutMs: DEFAULT_HOLD_TIMEOUT_MS });
    await world.attachPanel();
    const { id, outcome } = await holdOne(world);
    // Step in seconds with the heartbeat running, so only the unanswered hold can end it.
    for (let s = 0; s < 119; s++) {
      await vi.advanceTimersByTimeAsync(1000);
      await flush(1);
    }
    expect(world.page.installed.store.pendingIds()).toEqual([id]);
    await vi.advanceTimersByTimeAsync(2000);
    await flush(2);
    expect(await outcome).toBeInstanceOf(TypeError);
    expect(world.page.installed.store.get(id)?.message).toBe(reasonTimeout(DEFAULT_HOLD_TIMEOUT_MS));
    expect(world.sent).toHaveLength(0);
  });

  it("uses the hold timeout the extension settings carry (clamped), not just the default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    world = await makeWorld({ storedTimeoutMs: 5000 });
    await world.attachPanel();
    await waitFor(() => world!.page.gate.timeout === 5000, "the settings to reach the page");
    const { id, outcome } = await holdOne(world);
    for (let s = 0; s < 6; s++) {
      await vi.advanceTimersByTimeAsync(1000);
      await flush(1);
    }
    expect(await outcome).toBeInstanceOf(TypeError);
    expect(world.page.installed.store.get(id)?.message).toBe(reasonTimeout(5000));
  });

  it("blocks a held request the moment the side panel closes", async () => {
    world = await makeWorld();
    const panel = await world.attachPanel();
    const { id, outcome } = await holdOne(world);
    panel.close();
    expect(await outcome).toBeInstanceOf(TypeError);
    expect(world.page.installed.store.get(id)?.message).toBe(REASON_PANEL_CLOSED);
    expect(world.sent).toHaveLength(0);
  });

  it("blocks when the page's connection to the background drops while a request is held", async () => {
    world = await makeWorld();
    await world.attachPanel();
    const { id, outcome } = await holdOne(world);
    for (const p of world.chrome.serverPorts.filter((s) => s.name === "airlock-page")) p.disconnect(); // the worker died
    expect(await outcome).toBeInstanceOf(TypeError);
    expect(world.page.installed.store.get(id)?.message).toBe(REASON_PANEL_CLOSED);
    expect(world.sent).toHaveLength(0);
  });

  it("blocks when the bridge goes silent (extension reloaded, bridge gone) and nothing says goodbye", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    world = await makeWorld();
    await world.attachPanel();
    const { id, outcome } = await holdOne(world);
    world.bridge.stop();
    for (let s = 0; s < Math.ceil(BRIDGE_STALE_MS / 1000) + 5; s++) {
      await vi.advanceTimersByTimeAsync(1000);
      await flush(1);
    }
    expect(await outcome).toBeInstanceOf(TypeError);
    expect(world.page.installed.store.get(id)?.status).toBe("denied");
    expect(world.sent).toHaveLength(0);
  });

  it("an approval that arrives after the block changes nothing", async () => {
    world = await makeWorld();
    const panel = await world.attachPanel();
    const { id, outcome } = await holdOne(world);
    panel.close();
    await outcome;
    await world.page.remote.run("late", { kind: "decide", id, decision: "approve" });
    expect(world.sent).toHaveLength(0);
  });
});

describe("extension harness: the window is hostile", () => {
  it("never lets page code see the handshake, and a forged handshake cannot take over", async () => {
    world = await makeWorld();
    const panel = await world.attachPanel();
    const channel = new MessageChannel();
    const seenBefore = world.win.seenByPage.length;
    // A page script posts its own handshake, with its own port and nonce, after the real one.
    world.win.postFrom(world.win, { channel: WINDOW_CHANNEL, kind: "handshake", nonce: "f".repeat(32) }, [channel.port2]);
    await flush();
    expect(world.page.link.rejected).toBeGreaterThan(0);
    expect(world.win.seenByPage.length).toBe(seenBefore); // swallowed: page listeners never saw it

    const { id } = await holdOne(world);
    // The forger's port is not connected to anything: it cannot approve. The real panel still can.
    channel.port1.postMessage({ v: 1, nonce: "f".repeat(32), msg: { type: "command", cmdId: "x", command: { kind: "decide", id, decision: "approve" } } });
    await flush();
    expect(world.page.installed.store.pendingIds()).toEqual([id]);
    await panel.command(0, { kind: "decide", id, decision: "deny" });
    channel.port1.close();
  });

  it("rejects a handshake whose source is not the window itself", async () => {
    world = await makeWorld({});
    const other = new MessageChannel();
    world.win.postFrom({ not: "window" }, { channel: WINDOW_CHANNEL, kind: "handshake", nonce: "e".repeat(32) }, [other.port2]);
    await flush();
    expect(world.page.link.rejected).toBeGreaterThan(0);
    other.port1.close();
  });
});

describe("extension harness: the host list", () => {
  it("narrowing the list stops interception on the removed host and unregisters its scripts", async () => {
    world = await makeWorld();
    const panel = await world.attachPanel();
    expect([...world.chrome.registered.keys()].sort()).toEqual([`airlock-bridge:${HOST_PATTERN}`, `airlock-main:${HOST_PATTERN}`]);
    expect(world.page.scope).toContain(CRM_HOST);

    const extSender = { id: world.chrome.extensionId, url: world.chrome.runtime.getURL("sidepanel.html") };
    const answer = (await world.chrome.sendMessage({ type: "hosts:set", hosts: [] }, extSender)) as { ok: boolean };
    expect(answer.ok).toBe(true);
    expect(world.chrome.registered.size).toBe(0);
    await waitFor(() => world!.page.scope.length === 0, "the open page to drop the host");

    // The removed host is untouched now: the request goes straight to the network, unprotected, because the user removed it.
    await post();
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0].body).toContain(RAW_EMAIL);
    expect(world.page.installed.store.getSnapshot()).toHaveLength(0);
    void panel;
  });

  it("requests to a host that was never configured are not touched", async () => {
    world = await makeWorld();
    await world.attachPanel();
    await fetch("http://other.example.test/api", { method: "POST", body: JSON.stringify({ email: RAW_EMAIL }) });
    expect(world.sent).toHaveLength(1);
    expect(world.page.installed.store.getSnapshot()).toHaveLength(0);
  });

  it("keeps the panel state per tab: the panel only talks to the tab it attached to", async () => {
    world = await makeWorld();
    const panel = await world.attachPanel();
    expect(panel.getState().tabId).toBe(TAB);
    expect(panel.getState().frames[0].host).toBe(CRM_HOST);
  });
});
