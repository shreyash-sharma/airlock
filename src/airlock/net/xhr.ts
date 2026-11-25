import { resolveUrl, unsupportedBodyType, type Engine, type NormalizedRequest, type Outcome } from "./engine.js";

/**
 * The XMLHttpRequest adapter: the same engine as fetch, for in-scope URLs only. send() is deferred until
 * the engine resolves. A blocked request never reaches the native send: the instance reports a network
 * error instead. A protected request is sent natively with the protected body, and response and
 * responseText return the restored answer. Synchronous XHR, non-text bodies and response types other than
 * "", "text" and "json" to in-scope hosts are blocked.
 */

type XhrClass = typeof XMLHttpRequest;
type Loose = Record<string, unknown>;

interface XhrState {
  method: string;
  url: string;
  async: boolean;
  headers: Record<string, string>;
}

const ALLOWED_TYPES = ["", "text", "json"];

function nativeAccessor(proto: object, name: string): PropertyDescriptor | undefined {
  for (let p: object | null = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d && (d.get || d.set)) return d;
  }
  return undefined;
}

const makeEvent = (type: string): Event => (typeof ProgressEvent === "function" ? new ProgressEvent(type) : new Event(type));

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function installXhrAdapter(engine: Engine, Xhr: XhrClass | undefined = (globalThis as { XMLHttpRequest?: XhrClass }).XMLHttpRequest): () => void {
  if (!Xhr) return () => undefined;
  const proto = Xhr.prototype as unknown as Loose;
  const origOpen = proto.open as (...a: unknown[]) => unknown;
  const origSetHeader = proto.setRequestHeader as (name: string, value: string) => void;
  const origSend = proto.send as (body?: unknown) => void;
  const states = new WeakMap<object, XhrState>();

  /** Report a network error on an instance whose native send never happens (or never will). */
  function fail(xhr: XMLHttpRequest): void {
    const define = (key: string, value: unknown) => Object.defineProperty(xhr, key, { configurable: true, get: () => value });
    define("readyState", 4);
    define("status", 0);
    define("statusText", "");
    define("responseText", "");
    define("responseURL", "");
    define("response", xhr.responseType === "json" ? null : "");
    for (const type of ["readystatechange", "error", "loadend"]) xhr.dispatchEvent(makeEvent(type));
  }

  function nativeSend(xhr: XMLHttpRequest, body: unknown): boolean {
    try {
      origSend.call(xhr, body);
      return true;
    } catch {
      return false;
    }
  }

  /** Make response and responseText return the restored answer; the page never sees the protected one. */
  function installRestore(xhr: XMLHttpRequest, outcome: Extract<Outcome, { kind: "protect" }>): void {
    const get = (name: string): (() => unknown) => {
      const d = nativeAccessor(proto, name);
      return () => (d?.get ? d.get.call(xhr) : undefined);
    };
    const nativeReadyState = get("readyState");
    const nativeStatus = get("status");
    const nativeText = get("responseText");
    const nativeResponse = get("response");
    const started = Date.now();
    let settled = false;
    let restored: string | null = null;

    const rt = nativeAccessor(proto, "responseType");
    if (rt?.get && rt.set) {
      const { get: g, set: s } = rt;
      Object.defineProperty(xhr, "responseType", {
        configurable: true,
        get: () => g.call(xhr),
        set: (v: string) => {
          if (ALLOWED_TYPES.includes(v)) s.call(xhr, v);
        },
      });
    }

    const settle = (err?: unknown): void => {
      if (settled) return;
      if (err !== undefined) {
        settled = true;
        outcome.onError(err);
        return;
      }
      if (nativeReadyState() !== 4) return;
      settled = true;
      const status = Number(nativeStatus());
      if (status === 0) {
        outcome.onError(new Error("network error"));
        return;
      }
      const isJson = xhr.responseType === "json";
      const raw = isJson ? nativeResponse() : nativeText();
      if (raw === null || raw === undefined) return;
      restored = outcome.onResponse(status, isJson ? JSON.stringify(raw) : String(raw), Date.now() - started);
    };
    const empty = (): boolean => {
      settle();
      return restored === null && nativeReadyState() !== 4;
    };

    Object.defineProperty(xhr, "responseText", {
      configurable: true,
      get: () => (empty() ? "" : restored !== null ? restored : nativeText()),
    });
    Object.defineProperty(xhr, "response", {
      configurable: true,
      get: () => {
        if (empty()) return xhr.responseType === "json" ? null : "";
        if (restored === null) return nativeResponse();
        return xhr.responseType === "json" ? safeParse(restored) : restored;
      },
    });
    xhr.addEventListener("readystatechange", () => settle());
    xhr.addEventListener("loadend", () => settle());
    for (const type of ["error", "abort", "timeout"]) xhr.addEventListener(type, () => settle(new Error(`XMLHttpRequest ${type}`)));
  }

  async function run(xhr: XMLHttpRequest, req: NormalizedRequest, body: unknown): Promise<void> {
    if (!ALLOWED_TYPES.includes(xhr.responseType)) {
      engine.reject(req, `XMLHttpRequest responseType "${xhr.responseType}" cannot be restored, so AIRLOCK blocks it to protected hosts.`);
      fail(xhr);
      return;
    }
    let outcome: Outcome;
    try {
      outcome = await engine.process(req);
    } catch {
      fail(xhr); // The engine already recorded why (denied, cancelled, ...).
      return;
    }
    if (outcome.kind === "block") {
      fail(xhr);
      return;
    }
    if (outcome.kind === "pass") {
      nativeSend(xhr, body);
      return;
    }
    // protect: the response type may have changed while the pipeline ran.
    if (!ALLOWED_TYPES.includes(xhr.responseType) || xhr.readyState !== 1) {
      outcome.onError(new Error("the request was aborted or changed before it was sent"));
      if (xhr.readyState === 1) fail(xhr);
      return;
    }
    installRestore(xhr, outcome);
    if (outcome.url) {
      // Inline mode tokenized something in the URL: reopen with the masked URL and put the headers back before sending.
      const st = states.get(xhr);
      origOpen.call(xhr, req.method, outcome.url, st?.async !== false);
      for (const [name, value] of Object.entries(req.headers)) origSetHeader.call(xhr, name, value);
    }
    if (!nativeSend(xhr, outcome.body)) {
      outcome.onError(new Error("XMLHttpRequest could not send"));
      fail(xhr);
    }
  }

  proto.open = function (this: XMLHttpRequest, ...args: unknown[]): unknown {
    const [method, url, async] = args;
    const where = resolveUrl(String(url));
    states.set(this, { method: String(method).toUpperCase(), url: where?.url ?? String(url), async: async !== false, headers: {} });
    return origOpen.apply(this, args);
  };

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
    const st = states.get(this);
    if (st) {
      const key = String(name).toLowerCase();
      st.headers[key] = key in st.headers ? `${st.headers[key]}, ${value}` : String(value);
    }
    origSetHeader.call(this, name, value);
  };

  proto.send = function (this: XMLHttpRequest, body?: unknown): void {
    const xhr = this;
    const st = states.get(xhr);
    const where = st ? resolveUrl(st.url) : null;
    if (!st || !where) {
      origSend.call(xhr, body);
      return;
    }
    const base = {
      transport: "xhr" as const,
      url: where.url,
      host: where.host,
      path: where.path,
      method: st.method,
      headers: { ...st.headers },
      contentType: st.headers["content-type"] ?? "",
    };
    const syncError = (): never => {
      const reason = "Synchronous XMLHttpRequest to a protected host cannot be inspected, so AIRLOCK blocks it.";
      engine.reject({ ...base, body: null, bodyKind: "none" }, reason);
      throw new DOMException(reason, "NetworkError");
    };

    const start = (): void => {
      if (!engine.isInScope(where.host)) {
        origSend.call(xhr, body);
        return;
      }
      if (!st.async) syncError();
      let req: NormalizedRequest;
      if (body === null || body === undefined) req = { ...base, body: null, bodyKind: "none" };
      else if (typeof body === "string") req = { ...base, body, bodyKind: "text" };
      else req = { ...base, body: null, bodyKind: "unsupported", bodyType: unsupportedBodyType(body) ?? "Document or other non-text value" };
      void run(xhr, req, body);
    };

    if (engine.isReady()) {
      start();
      return;
    }
    // Profiles have not finished loading, so the scope is not known yet. Fail closed for sync XHR; defer the rest.
    if (!st.async) syncError();
    void engine.ready.then(start);
  };

  return () => {
    proto.open = origOpen;
    proto.setRequestHeader = origSetHeader;
    proto.send = origSend;
  };
}
