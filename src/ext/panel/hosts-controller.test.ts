import { describe, expect, it } from "vitest";
import { HOSTS_STORAGE_KEY, SETTINGS_STORAGE_KEY, type ExtensionResponse, type HostsState } from "../protocol.js";
import { createHostsController, type HostsChrome } from "./hosts-controller.js";

function fake(opts: { grant?: boolean; requestError?: string; removeResult?: boolean | Error } = {}) {
  let hosts = ["http://127.0.0.1:5173/*"];
  const calls: string[] = [];
  const storage: Record<string, unknown> = {};
  const state = (): HostsState => ({ hosts, granted: hosts, registered: hosts });
  const chrome: HostsChrome = {
    runtime: {
      sendMessage: async (m) => {
        const msg = m as { type: string; hosts?: string[] };
        calls.push(`msg:${msg.type}`);
        if (msg.type === "hosts:set") hosts = msg.hosts ?? [];
        return { ok: true, state: state() } satisfies ExtensionResponse;
      },
    },
    permissions: {
      request: async (q) => {
        calls.push(`request:${q.origins[0]}`);
        if (opts.requestError) throw new Error(opts.requestError);
        return opts.grant ?? true;
      },
      remove: async (q) => {
        calls.push(`remove:${q.origins[0]}`);
        if (opts.removeResult instanceof Error) throw opts.removeResult;
        return opts.removeResult ?? true;
      },
    },
    storage: {
      local: {
        get: async (k) => ({ [k]: storage[k] }),
        set: async (items) => void Object.assign(storage, items),
      },
    },
  };
  return { chrome, calls, storage, hosts: () => hosts };
}

describe("hosts controller", () => {
  it("loads the list and the timeout", async () => {
    const f = fake();
    f.storage[SETTINGS_STORAGE_KEY] = { holdTimeoutMs: 30_000 };
    const c = createHostsController(f.chrome);
    expect(c.getSnapshot().loaded).toBe(false);
    await c.refresh();
    expect(c.getSnapshot()).toMatchObject({ loaded: true, holdTimeoutMs: 30_000, problem: null });
    expect(c.getSnapshot().rows).toEqual([{ pattern: "http://127.0.0.1:5173/*", name: "127.0.0.1:5173", granted: true, registered: true }]);
  });

  it("validates before it asks the browser for anything", async () => {
    const f = fake();
    const c = createHostsController(f.chrome);
    expect(await c.add("https://x.com")).toMatchObject({ ok: false });
    expect(await c.add("*")).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
  });

  it("asks for the permission first and stores the host only when it is granted", async () => {
    const f = fake();
    const c = createHostsController(f.chrome);
    await c.refresh();
    f.calls.length = 0;
    expect(await c.add("crm.example.com")).toEqual({ ok: true });
    expect(f.calls).toEqual(["request:https://crm.example.com/*", "msg:hosts:set"]);
    expect(f.hosts()).toEqual(["http://127.0.0.1:5173/*", "https://crm.example.com/*"]);
    expect(c.getSnapshot().rows.map((r) => r.name)).toEqual(["127.0.0.1:5173", "crm.example.com"]);
  });

  it("does not store a host the user declined, and says so", async () => {
    const f = fake({ grant: false });
    const c = createHostsController(f.chrome);
    await c.refresh();
    const r = await c.add("crm.example.com");
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/did not grant/);
    expect(f.hosts()).toEqual(["http://127.0.0.1:5173/*"]);
  });

  it("reports a refused permission request (for example no user gesture) without storing anything", async () => {
    const f = fake({ requestError: "This function must be called during a user gesture" });
    const c = createHostsController(f.chrome);
    await c.refresh();
    const r = await c.add("crm.example.com");
    expect((r as { error: string }).error).toMatch(/user gesture/);
    expect(f.hosts()).toEqual(["http://127.0.0.1:5173/*"]);
  });

  it("removes from the list first, then gives the access back, and notes when Chrome keeps it", async () => {
    const f = fake({ removeResult: new Error("You cannot remove required permissions.") });
    const c = createHostsController(f.chrome);
    await c.refresh();
    f.calls.length = 0;
    const r = await c.remove("http://127.0.0.1:5173/*");
    expect(f.calls.slice(0, 2)).toEqual(["msg:hosts:set", "remove:http://127.0.0.1:5173/*"]);
    expect(f.hosts()).toEqual([]);
    expect(r).toMatchObject({ ok: true });
    expect((r as { note?: string }).note).toMatch(/no longer protects/);
    const clean = fake({ removeResult: true });
    const c2 = createHostsController(clean.chrome);
    await c2.refresh();
    expect(await c2.remove("http://127.0.0.1:5173/*")).toEqual({ ok: true });
  });

  it("clamps the hold timeout to whole seconds between 1 and 600 and stores milliseconds", async () => {
    const f = fake();
    const c = createHostsController(f.chrome);
    expect(await c.setHoldTimeout(0)).toMatchObject({ ok: false });
    expect(await c.setHoldTimeout(601)).toMatchObject({ ok: false });
    expect(await c.setHoldTimeout(2.5)).toMatchObject({ ok: false });
    expect(f.storage[SETTINGS_STORAGE_KEY]).toBeUndefined();
    expect(await c.setHoldTimeout(45)).toEqual({ ok: true, seconds: 45 });
    expect(f.storage[SETTINGS_STORAGE_KEY]).toEqual({ holdTimeoutMs: 45_000 });
    expect(c.getSnapshot().holdTimeoutMs).toBe(45_000);
  });

  it("shows the background's refusal instead of an empty list", async () => {
    const f = fake();
    f.chrome.runtime.sendMessage = async () => ({ ok: false, errors: ["Only AIRLOCK's own pages may use this."] }) satisfies ExtensionResponse;
    const c = createHostsController(f.chrome);
    await c.refresh();
    expect(c.getSnapshot().problem).toMatch(/own pages/);
    expect(HOSTS_STORAGE_KEY).toBeTruthy();
  });
});
