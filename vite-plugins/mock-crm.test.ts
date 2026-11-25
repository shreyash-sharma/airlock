import { describe, expect, it } from "vitest";
import { createMockCrmHandler, MAX_BODY_BYTES, type MockCrmRequest } from "./mock-crm";

const BASE = "/mock-crm/api";
const props = { firstname: "Rohan", lastname: "Mehta", email: "rohan.mehta@example.com", city: "Pune" };
const post = (body: unknown): MockCrmRequest => ({ method: "POST", url: `${BASE}/contacts`, body: typeof body === "string" ? body : JSON.stringify(body) });
const parse = (r: { body?: string }) => JSON.parse(r.body ?? "null") as Record<string, unknown>;

describe("mock CRM handler (a stand-in for Salesforce or HubSpot)", () => {
  it("creates a contact with a HubSpot-style body and returns the stored record", () => {
    const crm = createMockCrmHandler();
    const res = crm(post({ properties: props }));
    expect(res.status).toBe(201);
    const record = parse(res) as { id: string; properties: typeof props };
    expect(record.id).toBe("1");
    expect(record.properties).toEqual(props);
  });

  it("lists what was created as {results}", () => {
    const crm = createMockCrmHandler();
    crm(post({ properties: props }));
    crm(post({ properties: { ...props, city: "Delhi" } }));
    const res = crm({ method: "GET", url: `${BASE}/contacts` });
    expect(res.status).toBe(200);
    const list = parse(res) as { results: Array<{ properties: { city: string } }> };
    expect(list.results.map((r) => r.properties.city)).toEqual(["Pune", "Delhi"]);
  });

  it("patches by merging properties and answers 404 for an unknown id", () => {
    const crm = createMockCrmHandler();
    crm(post({ properties: props }));
    const patched = crm({ method: "PATCH", url: `${BASE}/contacts/1`, body: JSON.stringify({ properties: { city: "Mumbai", plan: "Pro" } }) });
    expect(patched.status).toBe(200);
    expect((parse(patched) as { properties: Record<string, string> }).properties).toEqual({ ...props, city: "Mumbai", plan: "Pro" });
    const missing = crm({ method: "PATCH", url: `${BASE}/contacts/99`, body: JSON.stringify({ properties: { city: "x" } }) });
    expect(missing.status).toBe(404);
  });

  it("/_raw shows exactly what is stored, and nothing that was never sent", () => {
    const crm = createMockCrmHandler();
    const stored = { firstname: "tok_abc", email: "tok_def" };
    crm(post({ properties: stored }));
    const raw = parse(crm({ method: "GET", url: `${BASE}/_raw` })) as { contacts: Array<{ properties: unknown }> };
    expect(raw.contacts).toHaveLength(1);
    expect(raw.contacts[0].properties).toEqual(stored);
    expect(JSON.stringify(raw)).not.toContain("Rohan");
  });

  it("/_reset forgets everything, answers 204 with no body, and restarts the ids", () => {
    const crm = createMockCrmHandler();
    crm(post({ properties: props }));
    const reset = crm({ method: "POST", url: `${BASE}/_reset` });
    expect(reset.status).toBe(204);
    expect(reset.body).toBeUndefined();
    expect((parse(crm({ method: "GET", url: `${BASE}/_raw` })) as { contacts: unknown[] }).contacts).toEqual([]);
    expect((parse(crm(post({ properties: props }))) as { id: string }).id).toBe("1");
  });

  it("answers 400 for invalid JSON and for a body that is not {properties: {...}}", () => {
    const crm = createMockCrmHandler();
    expect(crm(post("{not json")).status).toBe(400);
    expect(crm(post({ nothing: true })).status).toBe(400);
    expect(crm(post([1, 2])).status).toBe(400);
    expect(crm({ method: "PATCH", url: `${BASE}/contacts/1`, body: "{" }).status).toBe(400);
    expect((parse(crm({ method: "GET", url: `${BASE}/_raw` })) as { contacts: unknown[] }).contacts).toEqual([]);
  });

  it("answers 413 for a body over 64 KB and stores nothing", () => {
    const crm = createMockCrmHandler();
    const big = JSON.stringify({ properties: { note: "x".repeat(MAX_BODY_BYTES) } });
    expect(crm(post(big)).status).toBe(413);
    expect((parse(crm({ method: "GET", url: `${BASE}/_raw` })) as { contacts: unknown[] }).contacts).toEqual([]);
  });

  it("labels every response a stand-in with a JSON content type, including errors", () => {
    const crm = createMockCrmHandler();
    const responses = [
      crm(post({ properties: props })),
      crm({ method: "GET", url: `${BASE}/contacts` }),
      crm({ method: "GET", url: `${BASE}/_raw` }),
      crm({ method: "POST", url: `${BASE}/_reset` }),
      crm(post("{")),
      crm({ method: "GET", url: `${BASE}/nowhere` }),
      crm({ method: "DELETE", url: `${BASE}/contacts` }),
    ];
    for (const r of responses) {
      expect(r.headers["X-Mock-CRM"]).toBe("stand-in");
      expect(r.headers["Content-Type"]).toBe("application/json");
    }
    expect(responses[5].status).toBe(404);
    expect(responses[6].status).toBe(405);
  });

  it("ignores a query string and accepts the path with or without the /mock-crm/api prefix", () => {
    const crm = createMockCrmHandler();
    expect(crm({ method: "POST", url: "/contacts?x=1", body: JSON.stringify({ properties: props }) }).status).toBe(201);
    expect(crm({ method: "GET", url: `${BASE}/contacts/?limit=5` }).status).toBe(200);
  });
});
