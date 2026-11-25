/**
 * A deliberately tiny JSONPath subset, implemented in-repo: $, .key, ['key'], [n], [*].
 * Recursive descent, filters, slices, unions and script expressions are rejected at parse time, so a
 * locator written by a model can never express anything the engine does not understand.
 */

export type Segment = { t: "key"; key: string } | { t: "index"; index: number } | { t: "wild" };

export class PathError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} (at position ${position})`);
    this.name = "PathError";
    this.position = position;
  }
}

const KEY_CHAR = /[A-Za-z0-9_-]/;
const SIMPLE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Parse a locator into segments. Throws PathError with the position of the first thing outside the subset. */
export function parsePath(path: string): Segment[] {
  if (typeof path !== "string" || path[0] !== "$") throw new PathError("a locator must start with $", 0);
  const out: Segment[] = [];
  let i = 1;
  while (i < path.length) {
    const c = path[i];
    if (c === ".") {
      if (path[i + 1] === ".") throw new PathError("recursive descent (..) is not supported", i);
      let j = i + 1;
      while (j < path.length && KEY_CHAR.test(path[j])) j++;
      if (j === i + 1) throw new PathError(path[i + 1] === "*" ? "use [*] instead of .*" : "expected a key name after .", i + 1);
      out.push({ t: "key", key: path.slice(i + 1, j) });
      i = j;
    } else if (c === "[") {
      const next = path[i + 1];
      if (next === "'" || next === '"') {
        const end = path.indexOf(next, i + 2);
        if (end === -1 || path[end + 1] !== "]") throw new PathError("unterminated ['key']", i);
        out.push({ t: "key", key: path.slice(i + 2, end) });
        i = end + 2;
      } else if (next === "*") {
        if (path[i + 2] !== "]") throw new PathError("expected ] after *", i + 2);
        out.push({ t: "wild" });
        i += 3;
      } else {
        let j = i + 1;
        while (j < path.length && path[j] >= "0" && path[j] <= "9") j++;
        if (j === i + 1 || path[j] !== "]") throw new PathError("only [n], [*] and ['key'] are supported inside brackets", i + 1);
        out.push({ t: "index", index: Number(path.slice(i + 1, j)) });
        i = j + 1;
      }
    } else {
      throw new PathError(`unexpected character "${c}"`, i);
    }
  }
  return out;
}

function formatKey(key: string): string {
  return SIMPLE_KEY.test(key) ? `.${key}` : `['${key}']`;
}

/** The concrete path of a location, for example $.contacts[2].email. */
export function formatPath(segments: readonly Segment[]): string {
  return "$" + segments.map((s) => (s.t === "key" ? formatKey(s.key) : s.t === "index" ? `[${s.index}]` : "[*]")).join("");
}

export interface Located {
  /** Container holding the value; null for the root. */
  parent: Record<string, unknown> | unknown[] | null;
  key: string | number | null;
  /** Concrete path, wildcards resolved. */
  path: string;
  value: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function locate(root: unknown, segments: readonly Segment[]): Located[] {
  let level: Array<{ parent: Located["parent"]; key: Located["key"]; segs: Segment[]; value: unknown }> = [
    { parent: null, key: null, segs: [], value: root },
  ];
  for (const seg of segments) {
    const next: typeof level = [];
    for (const node of level) {
      const v = node.value;
      if (seg.t === "key") {
        if (isObject(v) && own(v, seg.key)) next.push({ parent: v, key: seg.key, segs: [...node.segs, seg], value: v[seg.key] });
      } else if (seg.t === "index") {
        if (Array.isArray(v) && seg.index < v.length) next.push({ parent: v, key: seg.index, segs: [...node.segs, seg], value: v[seg.index] });
      } else if (Array.isArray(v)) {
        v.forEach((item, index) => next.push({ parent: v, key: index, segs: [...node.segs, { t: "index", index }], value: item }));
      }
    }
    level = next;
  }
  return level.map((n) => ({ parent: n.parent, key: n.key, path: formatPath(n.segs), value: n.value }));
}

const compile = (path: string | readonly Segment[]): readonly Segment[] => (typeof path === "string" ? parsePath(path) : path);

/** Every value the locator reaches, with its concrete path. A missing path, or [*] over a non-array, gives []. */
export function getAll(root: unknown, path: string | readonly Segment[]): Array<{ path: string; value: unknown }> {
  return locate(root, compile(path)).map(({ path: p, value }) => ({ path: p, value }));
}

/** Return from a visit callback to remove the property or array element. */
export const DELETE: unique symbol = Symbol("airlock.jsonpath.delete");

/**
 * Visit every location the locator reaches. The callback may return a replacement value, DELETE, or
 * undefined to leave the value alone. Mutates the root in place; callers clone first. Returns the
 * (possibly replaced) root, which only differs when the locator is $ itself.
 */
export function visit(
  root: unknown,
  path: string | readonly Segment[],
  fn: (value: unknown, concretePath: string) => unknown | typeof DELETE | undefined,
): unknown {
  const found = locate(root, compile(path));
  let newRoot = root;
  // Reverse order so splicing a later array element never shifts an earlier target.
  for (let i = found.length - 1; i >= 0; i--) {
    const loc = found[i];
    const result = fn(loc.value, loc.path);
    if (result === undefined) continue;
    if (loc.parent === null) {
      newRoot = result === DELETE ? undefined : result;
    } else if (result === DELETE) {
      if (Array.isArray(loc.parent)) loc.parent.splice(loc.key as number, 1);
      else delete loc.parent[loc.key as string];
    } else if (Array.isArray(loc.parent)) loc.parent[loc.key as number] = result;
    else loc.parent[loc.key as string] = result;
  }
  return newRoot;
}

/**
 * Set a value at every location the locator reaches. A final .key that does not exist yet is created on an
 * existing object, and a final [n] equal to the array length appends. Returns how many locations changed.
 */
export function setAt(root: unknown, path: string | readonly Segment[], value: unknown): number {
  const segs = compile(path);
  if (segs.length === 0) throw new PathError("the root cannot be set in place", 0);
  const found = locate(root, segs);
  if (found.length > 0) {
    visit(root, segs, () => value);
    return found.length;
  }
  const last = segs[segs.length - 1];
  const parents = locate(root, segs.slice(0, -1));
  let n = 0;
  for (const p of parents) {
    if (last.t === "key" && isObject(p.value)) {
      p.value[last.key] = value;
      n++;
    } else if (last.t === "index" && Array.isArray(p.value) && last.index === p.value.length) {
      p.value.push(value);
      n++;
    }
  }
  return n;
}

/** Delete every location the locator reaches, splicing arrays. Returns how many were removed. */
export function deleteAt(root: unknown, path: string | readonly Segment[]): number {
  const segs = compile(path);
  if (segs.length === 0) throw new PathError("the root cannot be deleted in place", 0);
  let n = 0;
  visit(root, segs, () => {
    n++;
    return DELETE;
  });
  return n;
}
