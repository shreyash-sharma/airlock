import { detect } from "../core/detect.js";
import { formatPath, type Segment } from "../profiles/jsonpath.js";

/**
 * A held request (and optionally its response) as the inspector sees it: every leaf with its path, value
 * type, detector hits and a shape-only preview. The real values live only in private fields of the Capture,
 * for classification, the structure-only assertion and the dry-run sample, and clear() empties them. The
 * previews never carry a value: letters become x or X, digits become 9.
 */

export type Side = "request" | "response";
export type ValueType = "string" | "number" | "boolean" | "null";

export interface Leaf {
  side: Side;
  /** Concrete path, for example $.contacts[2].email. */
  path: string;
  valueType: ValueType;
  /** Detector entity types found in the value (EMAIL, PHONE, ...), never the value itself. */
  detectorHits: string[];
  /** Shape only, at most 24 characters then an ellipsis. */
  preview: string;
}

export const MAX_LEAVES = 300;
export const PREVIEW_MAX = 24;
const MAX_WALK_DEPTH = 16;

/** Letters become x or X and digits become 9; punctuation and spaces stay, so the shape is visible but not the value. */
export function shapePreview(text: string): string {
  const shaped = text.replace(/[\p{L}\p{N}]/gu, (ch) => (/\p{N}/u.test(ch) ? "9" : /\p{Lu}/u.test(ch) ? "X" : "x"));
  return shaped.length > PREVIEW_MAX ? `${shaped.slice(0, PREVIEW_MAX)}…` : shaped;
}

/** $.contacts[2].email becomes $.contacts[*].email. */
export function wildcardPath(path: string): string {
  return path.replace(/\[\d+\]/g, "[*]");
}

/** Keys that look like data (an email, a name with a space) rather than field names. */
const FIELD_NAME_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface CaptureInit {
  host: string;
  method: string;
  /** URL path without the query string. */
  path: string;
  contentType?: string;
  request: unknown;
  response?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class Capture {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly contentType: string;
  private requestBody: unknown;
  private responseBody: unknown;
  private values = new Map<string, string>();
  private dataKeys = new Set<string>();
  private list: Leaf[] = [];
  private cleared = false;
  /** True when the request or response had more leaves than MAX_LEAVES or was nested deeper than the walk limit. */
  truncated = false;

  constructor(init: CaptureInit) {
    this.host = init.host.toLowerCase();
    this.method = init.method.toUpperCase();
    this.path = init.path;
    this.contentType = init.contentType ?? "application/json";
    this.requestBody = init.request;
    this.index("request", init.request);
    if (init.response !== undefined) this.attachResponse(init.response);
  }

  /** Add the observed response body (parsed JSON). Replaces an earlier one. */
  attachResponse(body: unknown): void {
    if (this.cleared) return;
    this.list = this.list.filter((l) => l.side !== "response");
    for (const key of [...this.values.keys()]) if (key.startsWith("response ")) this.values.delete(key);
    this.responseBody = body;
    this.index("response", body);
  }

  private index(side: Side, body: unknown): void {
    const walk = (value: unknown, segs: Segment[], depth: number): void => {
      if (this.list.length >= MAX_LEAVES || depth > MAX_WALK_DEPTH) {
        this.truncated = true;
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, [...segs, { t: "index", index }], depth + 1));
      } else if (isObject(value)) {
        for (const key of Object.keys(value)) {
          if (!FIELD_NAME_KEY.test(key)) this.dataKeys.add(key);
          walk(value[key], [...segs, { t: "key", key }], depth + 1);
        }
      } else {
        const path = formatPath(segs);
        const valueType: ValueType = value === null ? "null" : typeof value === "string" ? "string" : typeof value === "number" ? "number" : "boolean";
        const text = value === null ? "" : String(value);
        let hits: string[] = [];
        if (valueType === "string" || valueType === "number") {
          hits = [...new Set(detect(text).map((e) => e.type))];
          if (text !== "") this.values.set(`${side} ${path}`, text);
        }
        this.list.push({ side, path, valueType, detectorHits: hits, preview: shapePreview(text) });
      }
    };
    walk(body, [], 0);
  }

  /** Every leaf, with previews only. Survives clear(): previews hold no value. */
  leaves(): readonly Leaf[] {
    return this.list;
  }

  /** The real string and number values, for local classification, the structure-only assertion and the dry run. Empty after clear(). */
  entries(): Array<{ side: Side; path: string; value: string }> {
    return [...this.values.entries()].map(([key, value]) => {
      const at = key.indexOf(" ");
      return { side: key.slice(0, at) as Side, path: key.slice(at + 1), value };
    });
  }

  /** Object keys that look like data rather than field names. They would appear in a path, so they are checked like values. */
  dataLikeKeys(): string[] {
    return [...this.dataKeys];
  }

  /** A private copy of the parsed request body for the dry run. */
  request(): unknown {
    return this.cleared ? undefined : structuredClone(this.requestBody);
  }

  response(): unknown {
    return this.cleared || this.responseBody === undefined ? undefined : structuredClone(this.responseBody);
  }

  hasResponse(): boolean {
    return !this.cleared && this.responseBody !== undefined;
  }

  get isCleared(): boolean {
    return this.cleared;
  }

  /** Forget every value. Previews stay: they carry no value. */
  clear(): void {
    this.cleared = true;
    this.values.clear();
    this.dataKeys.clear();
    this.requestBody = undefined;
    this.responseBody = undefined;
  }
}
