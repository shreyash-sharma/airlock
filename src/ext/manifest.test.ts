import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildManifest, EXTENSION_ID, EXTENSION_PUBLIC_KEY } from "./manifest.js";

type Manifest = Record<string, unknown> & { permissions: string[]; content_security_policy: { extension_pages: string } };

function checkRelease(m: Manifest): void {
  expect(m.manifest_version).toBe(3);
  expect([...m.permissions].sort()).toEqual(["scripting", "sidePanel", "storage"]);
  expect(m.host_permissions).toBeUndefined();
  expect(m.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
  expect(m.content_scripts).toBeUndefined(); // content scripts are registered dynamically for the configured hosts only
  expect((m.background as { service_worker: string }).service_worker).toBe("background.js");
  expect((m.side_panel as { default_path: string }).default_path).toBe("sidepanel.html");
  const csp = m.content_security_policy.extension_pages;
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toMatch(/https?:/); // no remote code
  expect(csp).toContain("script-src 'self'");
}

describe("manifest", () => {
  it("is MV3 with the minimal permission set and a strict CSP", () => {
    checkRelease(buildManifest() as Manifest);
  });

  it("grants host access only in the explicit test build", () => {
    expect(buildManifest({ grantedHosts: ["http://127.0.0.1:5173/*"] }).host_permissions).toEqual(["http://127.0.0.1:5173/*"]);
  });

  it("pins the extension ID that follows from its public key", () => {
    const der = Buffer.from(EXTENSION_PUBLIC_KEY, "base64");
    const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
    const id = [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
    expect(id).toBe(EXTENSION_ID);
    expect(buildManifest().key).toBe(EXTENSION_PUBLIC_KEY);
  });

  it("holds no private key material", () => {
    expect(JSON.stringify(buildManifest())).not.toMatch(/PRIVATE KEY/);
  });

  // The built folder (npm run build:ext) is checked when it exists; the real-Chrome script builds and loads it.
  it.skipIf(!existsSync("dist-ext/manifest.json"))("the built dist-ext/manifest.json passes the same checks and its files exist", () => {
    const m = JSON.parse(readFileSync("dist-ext/manifest.json", "utf8")) as Manifest;
    checkRelease(m);
    for (const f of ["background.js", "bridge.js", "page.js", "sidepanel.js", "sidepanel.html"]) expect(existsSync(`dist-ext/${f}`), f).toBe(true);
    for (const f of ["background.js", "bridge.js", "page.js", "sidepanel.js"]) {
      const code = readFileSync(`dist-ext/${f}`, "utf8");
      expect(code, f).not.toMatch(/\beval\s*\(/);
      expect(code, f).not.toMatch(/new Function\s*\(/);
    }
  });
});
