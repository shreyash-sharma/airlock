import type { ChromeLike, RegisteredScript } from "../chrome-api.js";
import { DEV_DEFAULT_HOSTS, HOSTS_STORAGE_KEY, normalizeHosts, type HostsState } from "../protocol.js";

export const MAIN_PREFIX = "airlock-main:";
export const BRIDGE_PREFIX = "airlock-bridge:";
/** The built files, relative to the extension root. */
export const MAIN_FILE = "page.js";
export const BRIDGE_FILE = "bridge.js";

export const mainId = (pattern: string): string => `${MAIN_PREFIX}${pattern}`;
export const bridgeId = (pattern: string): string => `${BRIDGE_PREFIX}${pattern}`;

const isOurs = (id: string): boolean => id.startsWith(MAIN_PREFIX) || id.startsWith(BRIDGE_PREFIX);

/** The two content scripts for one host pattern: the engine in the page's world, the bridge in the isolated world. */
export function scriptsFor(pattern: string): RegisteredScript[] {
  return [
    { id: mainId(pattern), matches: [pattern], js: [MAIN_FILE], runAt: "document_start", world: "MAIN", allFrames: true, persistAcrossSessions: true },
    { id: bridgeId(pattern), matches: [pattern], js: [BRIDGE_FILE], runAt: "document_start", world: "ISOLATED", allFrames: true, persistAcrossSessions: true },
  ];
}

export interface RegistrationPlan {
  register: RegisteredScript[];
  unregister: string[];
}

/**
 * The difference between what is registered and what must be: register the missing scripts, unregister every AIRLOCK
 * script whose host is no longer wanted (or whose definition changed). Scripts that are not AIRLOCK's are never touched.
 */
export function planRegistration(wanted: readonly string[], registered: readonly RegisteredScript[]): RegistrationPlan {
  const want = new Map(wanted.flatMap((p) => scriptsFor(p)).map((s) => [s.id, s]));
  const have = new Map(registered.filter((s) => isOurs(s.id)).map((s) => [s.id, s]));
  const sameDefinition = (a: RegisteredScript, b: RegisteredScript): boolean =>
    JSON.stringify([a.matches, a.js, a.runAt, a.world, a.allFrames ?? false]) === JSON.stringify([b.matches, b.js, b.runAt, b.world, b.allFrames ?? false]);
  const unregister: string[] = [];
  const register: RegisteredScript[] = [];
  for (const [id, script] of have) {
    const w = want.get(id);
    if (!w || !sameDefinition(w, script)) unregister.push(id);
  }
  for (const [id, script] of want) {
    const h = have.get(id);
    if (!h || unregister.includes(id)) register.push(script);
  }
  return { register, unregister };
}

type Api = Pick<ChromeLike, "storage" | "scripting" | "permissions">;

/** The configured host list (chrome.storage.local) and the script registration that follows it. */
export class HostList {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly api: Api) {}

  /** The stored list. A missing or damaged value falls back to the default, never to "everything". */
  async configured(): Promise<string[]> {
    const stored = (await this.api.storage.local.get(HOSTS_STORAGE_KEY))[HOSTS_STORAGE_KEY];
    if (stored === undefined) return [...DEV_DEFAULT_HOSTS];
    return normalizeHosts(stored).hosts;
  }

  /** Seed the default list on first install. Never overwrites an existing list. */
  async seed(): Promise<void> {
    const stored = (await this.api.storage.local.get(HOSTS_STORAGE_KEY))[HOSTS_STORAGE_KEY];
    if (stored === undefined) await this.api.storage.local.set({ [HOSTS_STORAGE_KEY]: [...DEV_DEFAULT_HOSTS] });
  }

  async set(input: unknown): Promise<{ ok: true; hosts: string[] } | { ok: false; errors: string[] }> {
    const n = normalizeHosts(input);
    if (n.errors.length > 0) return { ok: false, errors: n.errors };
    await this.api.storage.local.set({ [HOSTS_STORAGE_KEY]: n.hosts });
    return { ok: true, hosts: n.hosts };
  }

  /** Configured hosts the browser has granted access to. Scripts exist only for these. */
  async granted(): Promise<string[]> {
    const hosts = await this.configured();
    const out: string[] = [];
    for (const h of hosts) {
      try {
        if (await this.api.permissions.contains({ origins: [h] })) out.push(h);
      } catch {
        /* a pattern the browser rejects is simply not granted */
      }
    }
    return out;
  }

  /** Bring the registered scripts in line with the configured and granted hosts. Calls are serialized. */
  sync(): Promise<HostsState> {
    const run = async (): Promise<HostsState> => {
      const hosts = await this.configured();
      const granted = await this.granted();
      const registered = await this.api.scripting.getRegisteredContentScripts();
      const plan = planRegistration(granted, registered);
      if (plan.unregister.length > 0) await this.api.scripting.unregisterContentScripts({ ids: plan.unregister });
      if (plan.register.length > 0) await this.api.scripting.registerContentScripts(plan.register);
      const now = await this.api.scripting.getRegisteredContentScripts();
      const patterns = now.filter((s) => s.id.startsWith(MAIN_PREFIX)).map((s) => s.id.slice(MAIN_PREFIX.length));
      return { hosts, granted, registered: patterns };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
