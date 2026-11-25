import { describe, expect, it } from "vitest";
import {
  isHandshake,
  isValidHostPattern,
  normalizeHosts,
  parseBackgroundToBridge,
  parseBackgroundToPanel,
  parseBridgeMessage,
  parseExtensionRequest,
  parsePageMessage,
  parsePanelCommand,
  parsePanelToBackground,
  scopeHostOf,
  unwrap,
  WINDOW_CHANNEL,
  wrap,
} from "./protocol.js";

describe("protocol: host patterns", () => {
  it("accepts http(s) hosts with an optional *. and port, path /*", () => {
    for (const p of ["http://127.0.0.1:5173/*", "https://app.hubspot.com/*", "https://*.hubspot.com/*", "http://localhost:8080/*"]) expect(isValidHostPattern(p), p).toBe(true);
  });

  it("rejects everything that could widen the scope", () => {
    for (const p of ["<all_urls>", "*://*/*", "https://*/*", "http://*/*", "https://a.com/path/*", "https://a.com/", "file:///*", "https://*.*.com/*", "https://a..com/*", "https://a.com:99999999/*", "ftp://a.com/*", "https://exa mple.com/*", 7, null, ""]) {
      expect(isValidHostPattern(p), String(p)).toBe(false);
    }
  });

  it("derives the engine scope entry and normalizes a list", () => {
    expect(scopeHostOf("http://127.0.0.1:5173/*")).toBe("127.0.0.1:5173");
    expect(scopeHostOf("https://*.hubspot.com/*")).toBe("*.hubspot.com");
    const n = normalizeHosts(["https://A.com/*", "https://a.com/*", "nope"]);
    expect(n.hosts).toEqual(["https://a.com/*"]);
    expect(n.errors).toHaveLength(1);
    expect(normalizeHosts("x").errors).toHaveLength(1);
  });
});

describe("protocol: window handshake and wire messages", () => {
  it("recognizes only a well-formed handshake with a long enough nonce", () => {
    expect(isHandshake({ channel: WINDOW_CHANNEL, kind: "handshake", nonce: "a".repeat(32) })).toBe(true);
    expect(isHandshake({ channel: WINDOW_CHANNEL, kind: "handshake", nonce: "short" })).toBe(false);
    expect(isHandshake({ channel: "other", kind: "handshake", nonce: "a".repeat(32) })).toBe(false);
    expect(isHandshake(null)).toBe(false);
  });

  it("rejects a message with the wrong nonce, the wrong version or no payload", () => {
    const nonce = "n".repeat(32);
    expect(unwrap(wrap(nonce, { type: "hb" }), nonce)).toEqual({ type: "hb" });
    expect(unwrap(wrap("x".repeat(32), { type: "hb" }), nonce)).toBeNull();
    expect(unwrap({ v: 2, nonce, msg: {} }, nonce)).toBeNull();
    expect(unwrap({ v: 1, nonce }, nonce)).toBeNull();
    expect(unwrap("string", nonce)).toBeNull();
  });
});

describe("protocol: commands are validated before the engine runs them", () => {
  it("accepts every known command shape", () => {
    expect(parsePanelCommand({ kind: "decide", id: "req-1", decision: "approve" })).toEqual({ kind: "decide", id: "req-1", decision: "approve" });
    expect(parsePanelCommand({ kind: "inspect", id: "ins-1", op: "author" })).toEqual({ kind: "inspect", id: "ins-1", op: "author" });
    expect(parsePanelCommand({ kind: "inspect-edit", id: "i", path: "$.a", action: "mask", category: "contact" })).toBeTruthy();
    expect(parsePanelCommand({ kind: "terms", terms: ["Acme"] })).toEqual({ kind: "terms", terms: ["Acme"] });
    expect(parsePanelCommand({ kind: "inspect-locator", id: "i", locator: "$.list[*]", accepted: false })).toEqual({ kind: "inspect-locator", id: "i", locator: "$.list[*]", accepted: false });
    expect(parsePanelCommand({ kind: "inspect-locator", id: "i", locator: "$.a", accepted: "no" })).toBeNull();
    expect(parsePanelCommand({ kind: "inspect-add-locator", id: "i", locator: "x".repeat(201) })).toBeNull();
    expect(parsePanelCommand({ kind: "inspect-add-get", id: "i" })).toEqual({ kind: "inspect-add-get", id: "i" });
    expect(parsePanelCommand({ kind: "inspect-add-get" })).toBeNull();
    expect(parsePanelCommand({ kind: "snapshot" })).toEqual({ kind: "snapshot" });
  });

  it("rejects unknown kinds, bad fields and extra power", () => {
    for (const bad of [
      null,
      "decide",
      { kind: "decide", id: "", decision: "approve" },
      { kind: "decide", id: "x", decision: "inject" },
      { kind: "decide", id: 5, decision: "approve" },
      { kind: "inspect", id: "x", op: "eval" },
      { kind: "inspect-edit", id: "x", path: "$.a", action: "launder" },
      { kind: "profile-save", profile: "string" },
      { kind: "terms", terms: [1] },
      { kind: "eval", code: "1" },
    ]) {
      expect(parsePanelCommand(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("validates every hop's messages", () => {
    expect(parseBridgeMessage({ type: "hb", panel: true })).toEqual({ type: "hb", panel: true });
    expect(parseBridgeMessage({ type: "hb", panel: "yes" })).toBeNull();
    expect(parseBridgeMessage({ type: "hosts", hosts: ["https://*/*"] })).toBeNull();
    expect(parseBridgeMessage({ type: "command", cmdId: "c", command: { kind: "snapshot" } })).toBeTruthy();
    expect(parseBackgroundToBridge({ type: "panel", up: false })).toEqual({ type: "panel", up: false });
    expect(parseBackgroundToBridge({ type: "panel" })).toBeNull();
    expect(parsePageMessage({ type: "hello", host: "a.com" })).toBeTruthy();
    expect(parsePageMessage({ type: "state", snapshot: { seq: "1", requests: [] } })).toBeNull();
    expect(parsePageMessage({ type: "result", cmdId: "c", ok: true })).toBeTruthy();
    expect(parsePanelToBackground({ type: "attach", tabId: 3 })).toEqual({ type: "attach", tabId: 3 });
    expect(parsePanelToBackground({ type: "attach", tabId: -1 })).toBeNull();
    expect(parsePanelToBackground({ type: "command", tabId: 3, frameId: 0, cmdId: "c", command: { kind: "nope" } })).toBeNull();
    expect(parseBackgroundToPanel({ type: "page", tabId: 1, frameId: 0, host: "a", up: true })).toBeTruthy();
    expect(parseBackgroundToPanel({ type: "page", frameId: 0, host: "a", up: true })).toBeNull();
    expect(parseExtensionRequest({ type: "hosts:get" })).toEqual({ type: "hosts:get" });
    expect(parseExtensionRequest({ type: "hosts:set", hosts: "x" })).toBeNull();
  });
});
