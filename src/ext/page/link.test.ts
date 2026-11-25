import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_STALE_MS, WINDOW_CHANNEL, wrap } from "../protocol.js";
import { FakeWindow, flush } from "../test-support/fakes.js";
import { PageLink } from "./link.js";

const NONCE = "0123456789abcdef0123456789abcdef";
let links: PageLink[] = [];
afterEach(() => {
  links.forEach((l) => l.stop());
  links = [];
  vi.useRealTimers();
});

function setup() {
  const win = new FakeWindow();
  const events: string[] = [];
  const link = new PageLink(
    { win, now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms) },
    {
      onCommand: (id) => events.push(`command:${id}`),
      onHosts: (h) => events.push(`hosts:${h.join(",")}`),
      onSettings: (ms) => events.push(`settings:${ms}`),
      onPanelChange: (up) => events.push(`panel:${up}`),
      onConnect: () => events.push("connect"),
    },
  );
  links.push(link);
  link.start();
  const bridge = new MessageChannel();
  const handshake = { channel: WINDOW_CHANNEL, kind: "handshake", nonce: NONCE };
  return { win, link, events, bridge, handshake };
}

describe("PageLink", () => {
  it("accepts the first handshake from the window itself and nothing else", async () => {
    const { win, link, events, bridge, handshake } = setup();
    const forger = new MessageChannel();
    win.postFrom({ some: "frame" }, handshake, [forger.port2]); // wrong source
    win.postMessage(handshake, "*", [bridge.port2]);
    const second = new MessageChannel();
    win.postMessage({ ...handshake, nonce: "f".repeat(32) }, "*", [second.port2]); // a second handshake after pairing
    await flush();
    expect(events).toEqual(["connect"]);
    expect(link.connected()).toBe(true);
    expect(link.rejected).toBe(2);
    [forger, second, bridge].forEach((c) => (c.port1.close(), c.port2.close()));
  });

  it("drops port messages with a wrong nonce, a wrong version or an unknown shape, and keeps the right ones", async () => {
    const { win, link, events, bridge, handshake } = setup();
    win.postMessage(handshake, "*", [bridge.port2]);
    await flush();
    bridge.port1.postMessage(wrap("e".repeat(32), { type: "hosts", hosts: ["https://a.com/*"] })); // bad nonce
    bridge.port1.postMessage({ v: 2, nonce: NONCE, msg: { type: "hosts", hosts: ["https://a.com/*"] } }); // bad version
    bridge.port1.postMessage(wrap(NONCE, { type: "command", cmdId: "c", command: { kind: "eval", code: "1" } })); // unknown command
    bridge.port1.postMessage(wrap(NONCE, { type: "hosts", hosts: ["https://*/*"] })); // a scope-widening pattern
    bridge.port1.postMessage(wrap(NONCE, { type: "hosts", hosts: ["https://a.com/*"] }));
    bridge.port1.postMessage(wrap(NONCE, { type: "command", cmdId: "c2", command: { kind: "snapshot" } }));
    await flush();
    expect(events).toEqual(["connect", "hosts:https://a.com/*", "command:c2"]);
    expect(link.rejected).toBe(4);
    bridge.port1.close();
  });

  it("reports the panel up only while the bridge reports one, and down when a probe goes unanswered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { win, link, events, bridge, handshake } = setup();
    win.postMessage(handshake, "*", [bridge.port2]);
    await flush();
    expect(link.panelUp()).toBe(false); // connected is not the same as a panel
    bridge.port1.postMessage(wrap(NONCE, { type: "hb", panel: true }));
    await flush();
    expect(link.panelUp()).toBe(true);

    await vi.advanceTimersByTimeAsync(50); // time passes after the last heartbeat
    link.verify(); // nobody answers
    await vi.advanceTimersByTimeAsync(BRIDGE_STALE_MS + 10);
    expect(link.panelUp()).toBe(false);
    expect(events.filter((e) => e.startsWith("panel:"))).toEqual(["panel:true", "panel:false"]);

    bridge.port1.postMessage(wrap(NONCE, { type: "hb", panel: true })); // the bridge is back
    await flush();
    expect(link.panelUp()).toBe(true);
    bridge.port1.close();
  });

  it("a probe that is answered in time keeps the panel up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { win, link, bridge, handshake } = setup();
    win.postMessage(handshake, "*", [bridge.port2]);
    bridge.port1.onmessage = () => bridge.port1.postMessage(wrap(NONCE, { type: "hb", panel: true })); // answer every ping
    await flush();
    bridge.port1.postMessage(wrap(NONCE, { type: "hb", panel: true }));
    await flush();
    link.verify();
    await flush();
    await vi.advanceTimersByTimeAsync(BRIDGE_STALE_MS + 10);
    expect(link.panelUp()).toBe(true);
    bridge.port1.close();
  });
});
