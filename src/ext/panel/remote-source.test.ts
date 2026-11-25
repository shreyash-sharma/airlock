import { describe, expect, it } from "vitest";
import type { RequestView } from "../../airlock/net/store.js";
import type { PageSnapshot, PanelCommand } from "../protocol.js";
import type { CommandResult, FrameState, PanelClient, PanelState } from "./client.js";
import { attachmentOf, createRemoteSource, pickFrame } from "./remote-source.js";
import type { HostsController } from "../../airlock/ui/console/data.js";

const view = (id: string, status: RequestView["status"]): RequestView => ({
  id,
  createdAt: 1,
  url: "http://h/x",
  host: "h",
  status,
  shape: "unknown",
  task: "",
  originalDocument: "",
  clauses: [],
});

function snap(over: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    seq: 1,
    host: "h",
    ready: true,
    requests: [],
    audit: [],
    profiles: [],
    profileErrors: [],
    rules: null,
    defaultRules: { version: 1, destinations: [] },
    inspection: null,
    inspectHosts: [],
    model: { state: "ready" },
    failClosed: { timeoutMs: 120_000, panelUp: true },
    protectedTerms: [],
    ...over,
  };
}
const frame = (frameId: number, snapshot: PageSnapshot | null, up = true, host = "h"): FrameState => ({ frameId, host, up, snapshot });

/** A PanelClient stand-in: a settable state, a subscriber list, and a recorder for the commands it is asked to send. */
function fakeClient(frames: FrameState[], connected = true) {
  let state: PanelState = { tabId: 3, connected, frames };
  const listeners = new Set<() => void>();
  const sent: Array<{ frameId: number; command: PanelCommand; timeoutMs?: number }> = [];
  let answer: CommandResult = { ok: true };
  const client = {
    getState: () => state,
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    command: async (frameId: number, command: PanelCommand, timeoutMs?: number) => {
      sent.push({ frameId, command, timeoutMs });
      return answer;
    },
  } as unknown as PanelClient;
  return {
    client,
    sent,
    set(next: Partial<PanelState>) {
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    answer(r: CommandResult) {
      answer = r;
    },
  };
}

const hosts = {} as HostsController;
const make = (f: ReturnType<typeof fakeClient>) => createRemoteSource(f.client, { hosts, following: true, modelRefreshMs: 0 });

describe("pickFrame", () => {
  it("is null while no frame is up with a state", () => {
    expect(pickFrame([])).toBeNull();
    expect(pickFrame([frame(0, null), frame(1, snap(), false)])).toBeNull();
  });
  it("prefers the top frame, and a frame that holds a request waiting on the user", () => {
    expect(pickFrame([frame(2, snap()), frame(0, snap())])?.frameId).toBe(0);
    const waiting = frame(5, snap({ requests: [view("r1", "awaiting-approval")] }));
    expect(pickFrame([frame(0, snap()), waiting])?.frameId).toBe(5);
    const held = frame(6, snap({ inspection: [{ id: "i", createdAt: 1, host: "h", method: "POST", path: "/", status: "held", leaves: [], truncated: false, errors: [] }] }));
    expect(pickFrame([frame(0, snap()), held])?.frameId).toBe(6);
  });
});

describe("attachmentOf", () => {
  it("reports hosts, the timeout and whether a protected page is attached", () => {
    const a = attachmentOf({ tabId: 9, connected: true, frames: [frame(0, snap(), true, "a.test"), frame(1, snap(), true, "a.test"), frame(2, null, true, "b.test")] }, true);
    expect(a).toMatchObject({ connected: true, tabId: 9, hosts: ["a.test"], attached: true, following: true, timeoutMs: 120_000 });
  });
  it("is not attached with no live frame", () => {
    expect(attachmentOf({ tabId: 9, connected: true, frames: [] }, false)).toMatchObject({ attached: false, following: false, hosts: [], timeoutMs: null });
    expect(attachmentOf({ tabId: null, connected: false, frames: [] }, true).connected).toBe(false);
  });
});

describe("RemoteSource", () => {
  it("reads the shown frame's snapshot and keeps references stable between snapshots", () => {
    const requests = [view("r1", "awaiting-approval")];
    const f = fakeClient([frame(0, snap({ requests }))]);
    const { source } = make(f);
    expect(source.store.getSnapshot()).toBe(requests);
    expect(source.store.getSnapshot()).toBe(source.store.getSnapshot());
    expect(source.isReady()).toBe(true);
    expect(source.extension?.model.state()).toBe("ready");
    expect(source.inspection).toBeNull();
    const a = source.extension?.attachment();
    expect(source.extension?.attachment()).toBe(a);
  });

  it("is empty and not ready with no page, and says so by refusing commands visibly", async () => {
    const f = fakeClient([]);
    const r = make(f);
    expect(r.source.store.getSnapshot()).toEqual([]);
    expect(r.source.isReady()).toBe(false);
    r.source.store.approve("r1");
    await Promise.resolve();
    expect(f.sent).toHaveLength(0);
    expect(r.notice.get()?.text).toMatch(/No protected page/);
  });

  it("turns the console's actions into validated commands for the shown frame", async () => {
    const f = fakeClient([frame(4, snap({ requests: [view("r1", "awaiting-approval")] }))]);
    const { source } = make(f);
    source.store.approve("r1");
    source.store.deny("r1");
    source.store.useFallback("r1");
    source.setProtectedTerms(["Ada"]);
    await Promise.resolve();
    expect(f.sent.map((s) => [s.frameId, s.command])).toEqual([
      [4, { kind: "decide", id: "r1", decision: "approve" }],
      [4, { kind: "decide", id: "r1", decision: "deny" }],
      [4, { kind: "decide", id: "r1", decision: "fallback" }],
      [4, { kind: "terms", terms: ["Ada"] }],
    ]);
    expect(source.store.injectLeak).toBeUndefined();
  });

  it("shows a refused command as a notice instead of staying silent", async () => {
    const f = fakeClient([frame(0, snap())]);
    f.answer({ ok: false, error: "That request is not waiting for a decision." });
    const r = make(f);
    r.source.store.approve("gone");
    await new Promise((res) => setTimeout(res, 0));
    expect(r.notice.get()?.text).toBe("That request is not waiting for a decision.");
    r.notice.clear();
    expect(r.notice.get()).toBeNull();
  });

  it("validates a profile before sending it and sends only what validates", async () => {
    const f = fakeClient([frame(0, snap())]);
    const { source } = make(f);
    const bad = await source.registry.save({ id: "x" });
    expect(bad.ok).toBe(false);
    expect(f.sent).toHaveLength(0);
    const good = await source.registry.save({
      version: 1,
      id: "p1",
      name: "P1",
      kind: "saas",
      pipeline: "field-protect",
      match: { hosts: ["h"], paths: ["/**"] },
      request: { fields: [{ path: "$.a", category: "contact", flow: { action: "token" } }] },
      response: { fields: [] },
      author: { by: "user", at: "2026-01-01T00:00:00.000Z" },
    });
    expect(good.ok).toBe(true);
    expect(f.sent[0].command.kind).toBe("profile-save");
    const rules = await source.registry.saveRules({ nope: true });
    expect(rules.ok).toBe(false);
    expect(f.sent).toHaveLength(1);
  });

  it("versions the registry only when profiles or rules change, not on every snapshot", () => {
    const f = fakeClient([frame(0, snap({ seq: 1 }))]);
    const { source } = make(f);
    const v1 = source.registry.version();
    f.set({ frames: [frame(0, snap({ seq: 2, requests: [view("r2", "done")] }))] });
    expect(source.registry.version()).toBe(v1);
    f.set({ frames: [frame(0, snap({ seq: 3, rules: { version: 1, destinations: [] } }))] });
    expect(source.registry.version()).toBeGreaterThan(v1);
  });

  it("exposes inspection only when the page has it on, and long-running inspection commands get a long timeout", async () => {
    const items = [{ id: "i1", createdAt: 1, host: "h", method: "POST", path: "/", status: "held" as const, leaves: [], truncated: false, errors: [] }];
    const f = fakeClient([frame(0, snap({ inspection: items, inspectHosts: ["h"] }))]);
    const { source } = make(f);
    expect(source.inspection?.getSnapshot()).toBe(items);
    expect(source.inspectHosts).toEqual(["h"]);
    await source.inspection?.classify("i1");
    await source.inspection?.author("i1");
    await source.inspection?.approve("i1");
    source.inspection?.discard("i1");
    source.inspection?.passThrough("i1");
    await Promise.resolve();
    expect(f.sent.map((s) => s.command)).toEqual([
      { kind: "inspect", id: "i1", op: "classify" },
      { kind: "inspect", id: "i1", op: "author" },
      { kind: "inspect", id: "i1", op: "approve" },
      { kind: "inspect", id: "i1", op: "discard" },
      { kind: "inspect", id: "i1", op: "passThrough" },
    ]);
    expect(f.sent.slice(0, 3).every((s) => (s.timeoutMs ?? 0) >= 120_000)).toBe(true);
  });

  it("splits an approval's error list the way the console shows it", async () => {
    const f = fakeClient([frame(0, snap({ inspection: [] }))]);
    f.answer({ ok: false, error: "first problem; second problem" });
    const { source } = make(f);
    const r = await source.inspection?.approve("i1");
    expect(r).toEqual({ ok: false, errors: ["first problem", "second problem"] });
  });
});
