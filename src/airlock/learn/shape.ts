/**
 * Value-free answer shapes. When the engine handles a 2xx JSON answer from an in-scope host it keeps the SHAPE of the
 * answer (object keys and the JSON type of every leaf, never a value) in memory so that code can propose response
 * locators for a profile. A key that looks like data rather than a field name (an email used as a key) is withheld.
 */

export const SHAPE_TAGS = ["$string", "$number", "$boolean", "$null"] as const;
export type ShapeTag = (typeof SHAPE_TAGS)[number];
export const WITHHELD_KEY = "[withheld key]";

export type ShapeNode = ShapeTag | ShapeNode[] | { [key: string]: ShapeNode };

const FIELD_NAME_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const MAX_LEAVES = 300;
const MAX_DEPTH = 16;
/** Array elements kept per array: enough to see the record shape, bounded so a long list costs nothing. */
const MAX_ELEMENTS = 3;

export interface Shape {
  tree: ShapeNode;
  leaves: number;
  truncated: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function shapeOf(value: unknown): Shape {
  let leaves = 0;
  let truncated = false;
  const walk = (v: unknown, depth: number): ShapeNode => {
    if (depth > MAX_DEPTH || leaves >= MAX_LEAVES) {
      truncated = true;
      return "$null";
    }
    if (Array.isArray(v)) {
      if (v.length > MAX_ELEMENTS) truncated = true;
      return v.slice(0, MAX_ELEMENTS).map((item) => walk(item, depth + 1));
    }
    if (isObject(v)) {
      const out: { [key: string]: ShapeNode } = {};
      for (const key of Object.keys(v)) {
        const safe = FIELD_NAME_KEY.test(key) ? key : WITHHELD_KEY;
        out[safe] = walk(v[key], depth + 1);
      }
      return out;
    }
    leaves++;
    return v === null ? "$null" : typeof v === "string" ? "$string" : typeof v === "number" ? "$number" : "$boolean";
  };
  const tree = walk(value, 0);
  return { tree, leaves, truncated };
}

export interface Observation {
  id: string;
  at: number;
  host: string;
  method: string;
  path: string;
  status: number;
  shape: Shape;
}

const PER_HOST = 20;
const TOTAL = 100;

/** Memory-only log of observed answer shapes. The newest wins; an identical shape for the same request kind is not stored twice. */
export class ShapeLog {
  private items: Observation[] = [];
  private listeners = new Set<() => void>();
  private n = 0;

  /** Record a 2xx JSON answer. Anything else (an error status, text that is not JSON) is ignored. Never throws. */
  record(input: { host: string; method: string; path: string; status: number; text: string }): void {
    try {
      if (input.status < 200 || input.status > 299 || input.text.trim() === "") return;
      const shape = shapeOf(JSON.parse(input.text));
      const key = JSON.stringify(shape.tree);
      const host = input.host.toLowerCase();
      const method = input.method.toUpperCase();
      if (this.items.some((o) => o.host === host && o.method === method && o.path === input.path && JSON.stringify(o.shape.tree) === key)) return;
      this.items = [...this.items, { id: `obs-${Date.now().toString(36)}-${++this.n}`, at: Date.now(), host, method, path: input.path, status: input.status, shape }];
      const sameHost = this.items.filter((o) => o.host === host);
      if (sameHost.length > PER_HOST) this.items = this.items.filter((o) => o !== sameHost[0]);
      if (this.items.length > TOTAL) this.items = this.items.slice(this.items.length - TOTAL);
      this.listeners.forEach((l) => l());
    } catch {
      // Not JSON or too odd to shape: nothing is recorded and the answer is unaffected.
    }
  }

  list = (): readonly Observation[] => this.items;

  forHost(host: string): readonly Observation[] {
    const h = host.toLowerCase();
    return this.items.filter((o) => o.host === h);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear(): void {
    this.items = [];
    this.listeners.forEach((l) => l());
  }
}
