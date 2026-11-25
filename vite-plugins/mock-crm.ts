import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/**
 * STAND-IN for Salesforce or HubSpot. This is a labelled mock CRM served by the Vite dev server so AIRLOCK has
 * a deterministic SaaS to protect and a database view to check (/_raw). It is not a real CRM, it keeps its
 * data in memory only, and it exists in the dev server only (never in a production build).
 *
 * Routes under /mock-crm/api, HubSpot-style bodies ({properties: {...}}):
 *   POST  /contacts        create, returns the stored record (201)
 *   GET   /contacts        list, returns {results: [...]}
 *   PATCH /contacts/:id    merge properties, 404 when the id is unknown
 *   GET   /_raw            exactly what is stored (the "SaaS database" view and the test oracle)
 *   POST  /_reset          forget everything (204)
 * Invalid JSON gives 400, a body over 64 KB gives 413. Every response carries X-Mock-CRM: stand-in.
 */

export const MOCK_CRM_BASE = "/mock-crm/api";
export const MAX_BODY_BYTES = 64 * 1024;

export interface MockCrmRequest {
  method: string;
  /** Path with or without the /mock-crm/api prefix; the query string is ignored. */
  url: string;
  body?: string | null;
}

export interface MockCrmResponse {
  status: number;
  headers: Record<string, string>;
  /** Absent for 204. */
  body?: string;
}

interface Contact {
  id: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const HEADERS = { "Content-Type": "application/json", "X-Mock-CRM": "stand-in", "Cache-Control": "no-store" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function reply(status: number, value?: unknown): MockCrmResponse {
  if (value === undefined) return { status, headers: { ...HEADERS } };
  return { status, headers: { ...HEADERS }, body: JSON.stringify(value) };
}

const error = (status: number, message: string): MockCrmResponse => reply(status, { error: message, standIn: true });

/** The pure core: {method, url, body} in, {status, headers, body} out. State lives in the closure. */
export function createMockCrmHandler(): (req: MockCrmRequest) => MockCrmResponse {
  let contacts: Contact[] = [];
  let next = 1;

  return (req) => {
    const method = req.method.toUpperCase();
    let path = req.url.split("?")[0].split("#")[0];
    if (path.startsWith(MOCK_CRM_BASE)) path = path.slice(MOCK_CRM_BASE.length);
    path = path.replace(/\/+$/, "") || "/";

    if (path === "/_reset") return method === "POST" ? ((contacts = []), (next = 1), reply(204)) : error(405, "Use POST.");
    if (path === "/_raw") return method === "GET" ? reply(200, { contacts }) : error(405, "Use GET.");

    const readBody = (): { ok: true; value: Record<string, unknown> } | { ok: false; res: MockCrmResponse } => {
      const text = req.body ?? "";
      if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false, res: error(413, "The body is larger than 64 KB.") };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, res: error(400, "The body is not valid JSON.") };
      }
      if (!isObject(parsed) || !isObject(parsed.properties)) return { ok: false, res: error(400, 'The body must be {"properties": {...}}.') };
      return { ok: true, value: parsed.properties };
    };

    if (path === "/contacts") {
      if (method === "GET") return reply(200, { results: contacts });
      if (method === "POST") {
        const body = readBody();
        if (!body.ok) return body.res;
        const now = new Date().toISOString();
        const contact: Contact = { id: String(next++), properties: { ...body.value }, createdAt: now, updatedAt: now };
        contacts = [...contacts, contact];
        return reply(201, contact);
      }
      return error(405, "Use GET or POST.");
    }

    const one = /^\/contacts\/([^/]+)$/.exec(path);
    if (one) {
      if (method !== "PATCH") return error(405, "Use PATCH.");
      const body = readBody();
      if (!body.ok) return body.res;
      const at = contacts.findIndex((c) => c.id === one[1]);
      if (at === -1) return error(404, `No contact with id ${one[1].slice(0, 40)}.`);
      const merged: Contact = { ...contacts[at], properties: { ...contacts[at].properties, ...body.value }, updatedAt: new Date().toISOString() };
      contacts = contacts.map((c, i) => (i === at ? merged : c));
      return reply(200, merged);
    }
    return error(404, "Unknown mock CRM route.");
  };
}

/** Read the request body, giving up once it is clearly over the cap (plus a little, so the handler still answers 413). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY_BYTES + 1024) chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Vite plugin: serves the mock CRM from the dev server. Needs a dev-server restart when added or changed. */
export function mockCrm(): Plugin {
  return {
    name: "airlock-mock-crm",
    apply: "serve",
    configureServer(server) {
      const handle = createMockCrmHandler();
      server.middlewares.use(MOCK_CRM_BASE, (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          try {
            const body = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
            const out = handle({ method: req.method ?? "GET", url: req.url ?? "/", body });
            res.statusCode = out.status;
            for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
            res.end(out.body);
          } catch {
            res.statusCode = 500;
            res.setHeader("X-Mock-CRM", "stand-in");
            res.end();
          }
        })();
      });
    },
  };
}
