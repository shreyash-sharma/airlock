import { detect } from "../core/detect.js";
import type { PolicyResult, RuleFailure } from "../core/policy.js";
import { newId, sha256Hex, type EngineContext, type NormalizedRequest, type Outcome } from "../net/engine.js";
import type { RequestView } from "../net/store.js";
import { formatPath, getAll, parsePath, type Segment } from "../profiles/jsonpath.js";
import {
  CATEGORY_OF_ENTITY,
  type Action,
  type Category,
  type Destination,
  type FieldSpec,
  type Profile,
} from "../profiles/types.js";
import { alreadyProtected, applyAction, BlockError, restoreText } from "./actions.js";
import { isInlineDestination, runInlineMask } from "./inline.js";
import { defaultAction, resolveDestination } from "./rules.js";
import type { FlowState } from "./state.js";

/**
 * The field-protect pipeline: every located request field gets its resolved action (profile flow, else
 * destination default, else detected-value fallback), a residual scan over every other leaf decides whether
 * the request may leave at all, the user approves when the destination says ask, and the answer is restored
 * at the profile's response fields. Deterministic code throughout; no model is consulted.
 */

const MAX_WALK_DEPTH = 64;
/** Values this short are not matched as originals: they would collide with ordinary text. */
const MIN_ORIGINAL = 3;

type Container = Record<string, unknown> | unknown[];

interface Node {
  path: string;
  value: unknown;
  parent: Container | null;
  key: string | number | null;
  leaf: boolean;
  children: Node[];
}

interface Index {
  root: Node;
  byPath: Map<string, Node>;
  leaves: Node[];
  keys: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLeafValue = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** Walk a parsed body once. Paths are built, never parsed back, so odd keys cannot break a location. */
function indexTree(root: unknown): Index {
  const byPath = new Map<string, Node>();
  const leaves: Node[] = [];
  const keys: string[] = [];
  const walk = (value: unknown, parent: Container | null, key: string | number | null, segs: Segment[], depth: number): Node => {
    if (depth > MAX_WALK_DEPTH) throw new BlockError("the body is nested too deeply to inspect", "$");
    const node: Node = { path: formatPath(segs), value, parent, key, leaf: isLeafValue(value), children: [] };
    byPath.set(node.path, node);
    if (node.leaf) leaves.push(node);
    else if (Array.isArray(value)) {
      value.forEach((item, index) => node.children.push(walk(item, value, index, [...segs, { t: "index", index }], depth + 1)));
    } else if (isObject(value)) {
      for (const k of Object.keys(value)) {
        keys.push(k);
        node.children.push(walk(value[k], value, k, [...segs, { t: "key", key: k }], depth + 1));
      }
    }
    return node;
  };
  const top = walk(root, null, null, [], 0);
  return { root: top, byPath, leaves, keys };
}

function leavesUnder(node: Node, out: Node[] = []): Node[] {
  if (node.leaf) out.push(node);
  else node.children.forEach((c) => leavesUnder(c, out));
  return out;
}

export interface FieldReport {
  path: string;
  category?: Category;
  action: Action;
  restorable: boolean;
}

export interface FlowFinding {
  path: string;
  failure: RuleFailure;
}

export interface FlowRun {
  /** The exact text that may leave. */
  outbound: string;
  changed: boolean;
  report: FieldReport[];
  counts: Partial<Record<Action, number>>;
  /** Original values the actions removed. Kept in memory for the residual scan, never logged or stored in a view. */
  touched: string[];
  policy: PolicyResult;
  findings: FlowFinding[];
  restorable: number;
}

export interface FlowInput {
  state: FlowState;
  dest: Destination;
  profile: Profile;
  /** Parsed body (or the raw text when it is not JSON). Mutated: pass a copy you can lose. */
  root: unknown;
  /** The body exactly as the page wrote it. Sent unchanged when no action changed anything. */
  original: string;
  json: boolean;
  protectedTerms: readonly string[];
}

const lower = (s: string): string => s.toLowerCase();
const jsonEscaped = (s: string): string => JSON.stringify(s).slice(1, -1);

const DIGIT = /\d/;

/** Substring test; a purely numeric original must not be matched inside a longer number (68000 in 1680001). */
function includesValue(haystack: string, needle: string, numeric: boolean): boolean {
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!numeric) return true;
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    if (!(before !== undefined && DIGIT.test(before)) && !(after !== undefined && DIGIT.test(after))) return true;
  }
  return false;
}

function appearsIn(haystackLower: string, original: string): boolean {
  if (original.length < MIN_ORIGINAL) return false;
  const numeric = /^\d+$/.test(original);
  return includesValue(haystackLower, lower(original), numeric) || includesValue(haystackLower, lower(jsonEscaped(original)), numeric);
}

/** Apply every request field's resolved action, then run the residual scan over everything that remains. */
export async function applyFlows(input: FlowInput): Promise<FlowRun> {
  const { state, dest, profile, protectedTerms } = input;
  const index = indexTree(input.root);
  let rootValue = input.root;

  // Each leaf is governed by the most specific locator that reaches it (longest, then first declared).
  const claim = new Map<string, { field: FieldSpec; weight: number }>();
  for (const field of profile.request.fields) {
    const weight = parsePath(field.path).length;
    for (const hit of getAll(input.root, field.path)) {
      const node = index.byPath.get(hit.path);
      if (!node) continue;
      for (const leaf of leavesUnder(node)) {
        const held = claim.get(leaf.path);
        if (!held || weight > held.weight) claim.set(leaf.path, { field, weight });
      }
    }
  }

  const report: FieldReport[] = [];
  const counts: Partial<Record<Action, number>> = {};
  const touched: string[] = [];
  const produced = new Map<string, "whole" | "partial">();
  const dropped = new Set<string>();
  let changed = false;
  let restorable = 0;

  for (const leaf of index.leaves) {
    const held = claim.get(leaf.path);
    if (!held) continue;
    const { field } = held;
    const value = leaf.value as string | number | boolean;
    const text = typeof value === "string" ? value : String(value);
    let action: Action;
    let outcomeRestorable = false;
    let category: Category | undefined = field.category;

    if (typeof value === "string" && alreadyProtected(text)) {
      action = "allow"; // an earlier pass already protected it: unchanged
    } else {
      const hits = detect(text, { protectedTerms });
      category = field.category ?? (hits[0] ? CATEGORY_OF_ENTITY[hits[0].type] : undefined);
      const source = field.category ? "declared" : hits.length > 0 ? "detected" : "none";
      action = field.flow?.action ?? defaultAction(dest, category, source);
      const outcome = await applyAction(state, action, value, { path: leaf.path, category, params: field.flow?.params, protectedTerms });
      if (outcome.kind === "replace") {
        changed = true;
        touched.push(...outcome.touched);
        produced.set(leaf.path, outcome.partial ? "partial" : "whole");
        outcomeRestorable = outcome.restorable;
        if (leaf.parent === null) rootValue = outcome.value;
        else (leaf.parent as Record<string | number, unknown>)[leaf.key as string | number] = outcome.value;
      } else if (outcome.kind === "drop") {
        if (leaf.parent === null) throw new BlockError("the whole body is dropped, so there is nothing to send", leaf.path, category);
        changed = true;
        touched.push(...outcome.touched);
        dropped.add(leaf.path);
      }
    }
    if (outcomeRestorable) restorable++;
    counts[action] = (counts[action] ?? 0) + 1;
    report.push({ path: leaf.path, category, action, restorable: outcomeRestorable });
  }

  // Residual scan: every leaf that is still there must be clean. Nothing a profile forgot may pass.
  const findings: FlowFinding[] = [];
  const addFinding = (path: string, failure: Omit<RuleFailure, "index">): void => {
    findings.push({ path, failure: { ...failure, index: -1 } });
  };
  for (const leaf of index.leaves) {
    if (dropped.has(leaf.path)) continue;
    const mode = produced.get(leaf.path);
    if (mode === "whole") continue;
    const current = leaf.parent === null ? rootValue : (leaf.parent as Record<string | number, unknown>)[leaf.key as string | number];
    const text = typeof current === "string" ? current : String(current);
    const textLower = lower(text);
    for (const original of touched) {
      if (appearsIn(textLower, original)) {
        addFinding(leaf.path, {
          rule: "no-vault-value",
          title: "A protected original value is in the payload",
          explain: `A value that AIRLOCK removed from this request appears verbatim at ${leaf.path}.`,
          found: "protected value",
        });
        break;
      }
    }
    // An explicit allow does not exempt a leaf: a value the detectors still find blocks the request, and the
    // only way to clear it is a flow that actually protects it.
    if (mode === "partial") continue;
    const seen = new Set<Category>();
    for (const hit of detect(text, { protectedTerms })) {
      const category = CATEGORY_OF_ENTITY[hit.type];
      if (seen.has(category)) continue;
      seen.add(category);
      if ((dest.defaults[category] ?? "mask") === "allow") continue;
      addFinding(leaf.path, {
        rule: "no-residual-detection",
        title: "Sensitive value still present",
        explain: `A ${category} value was detected at ${leaf.path} and no field of the profile protects it.`,
        found: category,
      });
    }
  }
  for (const key of index.keys) {
    const keyLower = lower(key);
    if (touched.some((original) => appearsIn(keyLower, original))) {
      addFinding("$", {
        rule: "no-vault-value",
        title: "A protected original value is in the payload",
        explain: "A value that AIRLOCK removed from this request appears verbatim as a property name.",
        found: "protected value",
      });
      break;
    }
  }

  // Drops last, so array indexes stay stable while the scan above reads the tree.
  const doomed = groupDrops(index, dropped);
  for (const [parent, keys] of doomed) {
    if (Array.isArray(parent)) [...(keys as number[])].sort((a, b) => b - a).forEach((k) => parent.splice(k, 1));
    else (keys as string[]).forEach((k) => delete parent[k]);
  }

  const outbound = input.json ? (changed ? JSON.stringify(rootValue) : input.original) : input.original;
  const policy: PolicyResult = findings.length === 0 ? { pass: true } : { pass: false, failures: findings.map((f) => f.failure) };
  return { outbound, changed, report, counts, touched, policy, findings, restorable };
}

function groupDrops(index: Index, dropped: Set<string>): Map<Container, Array<string | number>> {
  const out = new Map<Container, Array<string | number>>();
  for (const path of dropped) {
    const node = index.byPath.get(path);
    if (!node || node.parent === null || node.key === null) continue;
    const list = out.get(node.parent) ?? [];
    list.push(node.key);
    out.set(node.parent, list);
  }
  return out;
}

/** Last check on the exact text that will leave: no removed original may be anywhere in it. */
export function rescanOutbound(outbound: string, touched: readonly string[]): RuleFailure | null {
  const text = lower(outbound);
  for (const original of touched) {
    if (appearsIn(text, original)) {
      return {
        rule: "no-vault-value",
        title: "A protected original value is in the payload",
        explain: "A value that AIRLOCK removed from this request appears verbatim in the exact outbound text.",
        index: -1,
        found: "protected value",
      };
    }
  }
  return null;
}

export interface RestoreResult {
  /** The text the page receives. The original text when nothing changed or the answer is not JSON. */
  text: string;
  parsed: boolean;
  /** How many locations the profile's response fields reached. */
  resolved: number;
  restoredLeaves: number;
}

/** Restore protected values at the profile's response fields. Synchronous, because XHR getters need it. */
export function restoreResponse(state: FlowState, profile: Profile, text: string): RestoreResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { text, parsed: false, resolved: 0, restoredLeaves: 0 };
  }
  const index = indexTree(root);
  let rootValue = root;
  let resolved = 0;
  let restoredLeaves = 0;
  const done = new Set<string>();
  for (const field of profile.response.fields) {
    for (const hit of getAll(root, field.path)) {
      resolved++;
      const node = index.byPath.get(hit.path);
      if (!node) continue;
      for (const leaf of leavesUnder(node)) {
        if (typeof leaf.value !== "string" || done.has(leaf.path)) continue;
        done.add(leaf.path);
        const back = restoreText(state, leaf.value);
        if (back === leaf.value) continue;
        restoredLeaves++;
        if (leaf.parent === null) rootValue = back;
        else (leaf.parent as Record<string | number, unknown>)[leaf.key as string | number] = back;
      }
    }
  }
  return { text: restoredLeaves > 0 ? JSON.stringify(rootValue) : text, parsed: true, resolved, restoredLeaves };
}

const countsDetail = (counts: Partial<Record<Action, number>>): Record<string, number> =>
  Object.fromEntries(Object.entries(counts).filter(([, n]) => (n ?? 0) > 0)) as Record<string, number>;

/** The text itself, then what one and two rounds of percent-decoding (and + as space) make of it. */
function decodedVariants(raw: string): string[] {
  const out = [raw];
  let current = raw;
  for (let i = 0; i < 2; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current.replace(/\+/g, " "));
    } catch {
      break;
    }
    if (next === current) break;
    out.push(next);
    current = next;
  }
  return out;
}

const SAFE_LABEL = /^[A-Za-z0-9_.\-[\]]{1,40}$/;

const CACHE_BUSTER_KEYS = new Set(["t", "_", "_t", "ts", "timestamp", "cb", "nocache", "cachebust", "cachebuster"]);

/**
 * A cache-busting query parameter such as ?t=1795534565 (EspoCRM adds its cache timestamp to many of its own reads) is
 * a plain epoch number, and the phone detector reads it as a phone number. It is exempt only when the key is a
 * well-known cache-buster name AND the value is an epoch that is plausible today: exactly 13 digits as milliseconds
 * (2017 to 2039) or exactly 10 digits as seconds (2017 to 2033). A phone number under any other key, or a number of
 * another length or range under "t", is still found. The residual risk (a 10-digit number that starts with 15 to 19
 * sent under a key named t) is stated in the README.
 */
export function isCacheBuster(key: string, value: string): boolean {
  if (!CACHE_BUSTER_KEYS.has(key.toLowerCase())) return false;
  const n = Number(value);
  if (/^[0-9]{13}$/.test(value)) return n >= 1_483_228_800_000 && n <= 2_208_988_800_000;
  if (/^[0-9]{10}$/.test(value)) return n >= 1_483_228_800 && n <= 1_999_999_999;
  return false;
}

/**
 * The URL query string and path leave with the request, and a profile locator reaches only the JSON body, so
 * nothing there can be tokenized or masked. The residual detectors run over every query key, query value and
 * path segment (raw and percent-decoded) and any removed original; a hit blocks. The finding names the part
 * ("query parameter "email"", "path segment 3") and never the value; a key that looks like data is numbered.
 */
export function scanUrl(req: NormalizedRequest, dest: Destination, protectedTerms: readonly string[], touched: readonly string[]): FlowFinding[] {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return [];
  }
  const findings: FlowFinding[] = [];
  const hitIn = (raw: string): Category | "protected value" | null => {
    for (const text of decodedVariants(raw)) {
      const lowered = lower(text);
      if (touched.some((original) => appearsIn(lowered, original))) return "protected value";
      for (const hit of detect(text, { protectedTerms })) {
        const category = CATEGORY_OF_ENTITY[hit.type];
        if ((dest.defaults[category] ?? "mask") !== "allow") return category;
      }
    }
    return null;
  };
  const add = (where: string, part: string, found: Category | "protected value"): void => {
    findings.push({
      path: where,
      failure: {
        rule: "no-residual-detection",
        title: "Sensitive value in the URL",
        explain: `A ${found} value was detected in the URL ${part}. A profile can only protect the JSON body, so the request was blocked. Move the value into the body.`,
        index: -1,
        found,
      },
    });
  };

  url.pathname
    .split("/")
    .filter((s) => s !== "")
    .forEach((segment, i) => {
      const found = hitIn(segment);
      if (found) add(`path segment ${i + 1}`, "path", found);
    });

  const pairs = url.search.length > 1 ? url.search.slice(1).split("&") : [];
  pairs.forEach((pair, i) => {
    if (pair === "") return;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    const plainKey = decodedVariants(key).at(-1) ?? key;
    const keyFound = hitIn(key);
    const valueFound = isCacheBuster(plainKey, value) ? null : hitIn(value);
    const found = keyFound ?? valueFound;
    if (!found) return;
    const label = keyFound === null && SAFE_LABEL.test(plainKey) ? `query parameter "${plainKey}"` : `query parameter #${i + 1}`;
    add(label, "query string", found);
  });
  return findings;
}

/** The field-protect pipeline behind the engine. */
export async function runFieldProtect(ctx: EngineContext, req: NormalizedRequest, profile: Profile): Promise<Outcome> {
  const { store, audit } = ctx;
  const id = newId();
  store.create({
    id,
    createdAt: Date.now(),
    url: req.url,
    host: req.host,
    status: "analyzing",
    shape: "unknown",
    task: "",
    originalDocument: "",
    clauses: [],
    pipeline: "field-protect",
    profileId: profile.id,
    authoredBy: profile.author.by,
    method: req.method,
    path: req.path,
    startedAt: Date.now(),
    // The page's exact body, a local copy for the console's diff pane. Memory only, capped by the store.
    ...(req.body !== null && req.body.trim() !== "" ? { originalBody: req.body } : {}),
  });
  // Set once the destination is known. On an inline (CRM) destination a would-be block becomes mask-and-send.
  let inlineDest: Destination | null = null;
  const block = (message: string): Outcome | Promise<Outcome> => {
    if (inlineDest) return runInlineMask(ctx, req, inlineDest, id, `Profile "${profile.id}" could not be applied as written (${message.replace(/ Nothing was sent\.?$/, "")}), so the generic detectors masked the request.`);
    store.update(id, { status: "blocked", message, endedAt: Date.now() });
    audit.add({ kind: "blocked", requestId: id, where: "code", detail: { reason: message, profileId: profile.id } });
    return { kind: "block", reason: message };
  };

  const state = ctx.flow;
  if (!state || !ctx.rules) return block("The field-protect pipeline has no vault or destination rules, so nothing was sent.");
  audit.add({ kind: "request-held", requestId: id, where: "code", detail: { host: req.host, method: req.method, profileId: profile.id } });

  let dest: Destination;
  try {
    dest = resolveDestination(await ctx.rules(), req.host, profile.kind);
  } catch {
    return block("The destination rules could not be read, so nothing was sent.");
  }
  store.update(id, { destinationId: dest.id });
  if (isInlineDestination(dest)) inlineDest = dest;
  const terms = ctx.getProtectedTerms();
  const body = req.body;
  const hasBody = body !== null && body.trim() !== "";

  let run: FlowRun | null = null;
  if (hasBody) {
    let root: unknown;
    let json = true;
    try {
      root = JSON.parse(body);
    } catch {
      json = false;
      root = body;
    }
    if (!json && profile.request.fields.length > 0) {
      return block(`The request body is not JSON, so the ${profile.request.fields.length} field(s) of profile "${profile.id}" cannot be located. Nothing was sent.`);
    }
    try {
      run = await applyFlows({ state, dest, profile, root, original: body, json, protectedTerms: terms });
    } catch (err) {
      if (err instanceof BlockError) return block(`Blocked: ${err.message}.`);
      const name = err instanceof Error ? err.name : "error";
      return block(`The profile could not be applied (${name}), so nothing was sent.`);
    }
  }

  // The URL leaves with the request and no profile locator reaches it, so a sensitive value there blocks.
  const urlFindings = scanUrl(req, dest, terms, run?.touched ?? []);
  const findings = [...(run?.findings ?? []), ...urlFindings];
  const policy: PolicyResult = findings.length === 0 ? { pass: true } : { pass: false, failures: findings.map((f) => f.failure) };

  const fieldSummary = (run?.report ?? []).map((r) => ({ path: r.path, category: r.category, action: r.action, restorable: r.restorable }));
  store.update(id, {
    fieldSummary,
    actionCounts: run ? countsDetail(run.counts) : {},
    policy: run || urlFindings.length > 0 ? policy : undefined,
    // Only a body that passed the policy is shown: a failing one may still hold a value that must not be displayed.
    outboundBody: run && policy.pass ? run.outbound : undefined,
    notes: hasBody ? [] : ["The request has no body, so there was nothing to protect before sending."],
  });
  if (run || urlFindings.length > 0) {
    audit.add({
      kind: "policy",
      requestId: id,
      where: "code",
      detail: {
        pass: policy.pass,
        failures: policy.pass ? 0 : policy.failures.length,
        rules: policy.pass ? "" : [...new Set(policy.failures.map((f) => f.rule))].join(","),
        profileId: profile.id,
      },
    });
    if (!policy.pass) {
      // A blocked request keeps no copy of the value it was blocked for, in the URL either.
      if (urlFindings.length > 0) store.update(id, { url: `${req.host} (URL withheld: it held a sensitive value)`, path: "(withheld)" });
      const first = findings[0];
      return block(`policy rule "${first.failure.rule}" failed at ${first.path}: ${first.failure.explain}`);
    }
  }
  if (run) {
    audit.add({
      kind: "protected",
      requestId: id,
      where: "code",
      detail: { profileId: profile.id, author: profile.author.by, destination: dest.id, ...countsDetail(run.counts) },
    });
  }

  if (hasBody) {
    // Approval: the destination says ask or auto. A body-less request has nothing to approve.
    let approvedBy = "destination rule (auto)";
    if (dest.approval === "ask" && !ctx.autoApprove && !inlineDest) {
      store.update(id, { status: "awaiting-approval" });
      const decision = await store.waitForDecision(id);
      if (decision.kind !== "approve") {
        const reason = decision.kind === "deny" ? decision.reason : undefined;
        audit.add({ kind: "denied", requestId: id, where: "code", ...(reason ? { detail: { reason } } : {}) });
        store.update(id, { status: "denied", message: reason ?? "You denied this request. Nothing was sent.", endedAt: Date.now() });
        throw new TypeError(`AIRLOCK: ${reason ?? "denied by the user"}. Nothing was sent.`);
      }
      approvedBy = "user";
    }
    store.update(id, { approvedBy: approvedBy === "user" ? "user" : "auto" });
    audit.add({ kind: "approved", requestId: id, where: "code", detail: { by: approvedBy, destination: dest.id } });
  }

  // Persist what restore needs before the request leaves, so a reload after the send still restores.
  if (run && run.restorable > 0) {
    try {
      await state.save();
    } catch {
      return block("The protected values could not be saved in this browser, so they could not be restored later. Nothing was sent.");
    }
  }

  const outbound = run ? run.outbound : null;
  if (run) {
    const rescan = rescanOutbound(run.outbound, run.touched);
    if (rescan) return block(`pre-send re-scan failed: ${rescan.explain}`);
  }
  const wireHash = await sha256Hex(outbound ?? "");
  const bytes = new TextEncoder().encode(outbound ?? "").length;
  store.update(id, { status: "sending", wireHash, bytesSent: bytes });
  const withheld = run ? (run.counts.mask ?? 0) + (run.counts.surrogate ?? 0) + (run.counts.token ?? 0) + (run.counts.drop ?? 0) : 0;
  audit.add({ kind: "sent", requestId: id, where: "in_cloud", detail: { host: req.host, bytes, wireHash, withheld, profileId: profile.id } });

  return {
    kind: "protect",
    body: outbound,
    onError(err) {
      const message = err instanceof Error ? err.message : String(err);
      store.update(id, { status: "failed", message: `The request failed after it was sent: ${message}`, endedAt: Date.now() });
      audit.add({ kind: "error", requestId: id, where: "in_cloud", detail: { reason: message } });
    },
    onResponse(status, raw, latency) {
      if (status < 200 || status > 299) {
        store.update(id, { status: "failed", cloudLatencyMs: latency, message: `The server returned HTTP ${status}.`, endedAt: Date.now() });
        audit.add({ kind: "error", requestId: id, where: "in_cloud", latencyMs: latency, detail: { status } });
        return raw;
      }
      const restored = restoreResponse(state, profile, raw);
      const notes = [...(store.get(id)?.notes ?? [])];
      if (!restored.parsed) notes.push("The answer was not JSON, so it was returned unchanged.");
      else if (profile.response.fields.length === 0) notes.push("The profile declares no response fields, so nothing was restored.");
      else if (restored.resolved === 0) notes.push("None of the profile's response fields were found in the answer, so nothing was restored.");
      store.update(id, { status: "done", cloudLatencyMs: latency, notes, endedAt: Date.now(), restoredCount: restored.restoredLeaves });
      audit.add({
        kind: "response",
        requestId: id,
        where: "in_cloud",
        latencyMs: latency,
        detail: { restored: restored.restoredLeaves, fields: restored.resolved, profileId: profile.id },
      });
      return restored.text;
    },
  };
}
