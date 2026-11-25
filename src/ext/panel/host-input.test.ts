import { describe, expect, it } from "vitest";
import { patternFromInput, timeoutFromInput } from "./host-input.js";
import { isValidHostPattern } from "../protocol.js";

const ok = (s: string) => {
  const r = patternFromInput(s);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("patternFromInput", () => {
  it("makes an https pattern from a plain host name and keeps what the engine validates", () => {
    expect(ok("crm.example.com").pattern).toBe("https://crm.example.com/*");
    expect(ok("  CRM.Example.COM  ").pattern).toBe("https://crm.example.com/*");
    expect(ok("crm.example.com.").pattern).toBe("https://crm.example.com/*");
    expect(isValidHostPattern(ok("app.example.org").pattern)).toBe(true);
  });
  it("uses http only for local addresses and keeps the port", () => {
    expect(ok("localhost:3000").pattern).toBe("http://localhost:3000/*");
    expect(ok("127.0.0.1:5173").pattern).toBe("http://127.0.0.1:5173/*");
    expect(ok("example.com:8443").pattern).toBe("https://example.com:8443/*");
  });
  it("drops a default port the way the engine does", () => {
    expect(ok("example.com:443").pattern).toBe("https://example.com/*");
  });
  it("accepts a domain wildcard only as *.domain", () => {
    expect(ok("*.example.com").pattern).toBe("https://*.example.com/*");
    expect(ok("*.example.com").name).toBe("*.example.com");
  });
  it("refuses a scheme, a path, credentials and spaces", () => {
    for (const bad of ["https://crm.example.com", "http://localhost", "crm.example.com/api", "crm.example.com?x=1", "user@crm.example.com", "crm example.com", "javascript://x"]) {
      expect(patternFromInput(bad).ok, bad).toBe(false);
    }
    expect((patternFromInput("https://crm.example.com") as { error: string }).error).toMatch(/without http/);
  });
  it("refuses every wildcard that would cover more than one named domain", () => {
    for (const bad of ["*", "**", "*.", "*.*", "*.com", "*.localhost", "*.example.*", "exa*mple.com", "*.1.2", "*.example.com:8080"]) {
      expect(patternFromInput(bad).ok, bad).toBe(false);
    }
  });
  it("refuses empty input, bad names and over-long input", () => {
    for (const bad of ["", "   ", "exa_mple.com", "-bad.com", "bad..com", "a".repeat(250), "12345", "999"]) {
      expect(patternFromInput(bad).ok, JSON.stringify(bad.slice(0, 12))).toBe(false);
    }
  });
  it("never produces a pattern the protocol would reject", () => {
    for (const s of ["a.b", "x-y.example.co.uk", "localhost", "10.0.0.5", "*.a.b"]) {
      const r = patternFromInput(s);
      if (r.ok) expect(isValidHostPattern(r.pattern), s).toBe(true);
    }
  });
});

describe("timeoutFromInput", () => {
  it("converts whole seconds inside the range", () => {
    expect(timeoutFromInput(120, 1000, 600_000)).toEqual({ ok: true, ms: 120_000 });
    expect(timeoutFromInput(1, 1000, 600_000)).toEqual({ ok: true, ms: 1000 });
    expect(timeoutFromInput(600, 1000, 600_000)).toEqual({ ok: true, ms: 600_000 });
  });
  it("refuses fractions, NaN and out-of-range values with the allowed range in the message", () => {
    expect(timeoutFromInput(1.5, 1000, 600_000).ok).toBe(false);
    expect(timeoutFromInput(Number.NaN, 1000, 600_000).ok).toBe(false);
    const r = timeoutFromInput(0, 1000, 600_000);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/1 and 600/);
    expect(timeoutFromInput(601, 1000, 600_000).ok).toBe(false);
  });
});
