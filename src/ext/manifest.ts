/**
 * The extension manifest. The `key` is the PUBLIC half of a throwaway RSA key pair whose private half was deleted:
 * it pins the extension ID so the Firebase App Check and AI Logic restrictions can name it, and it signs nothing.
 */
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApM5L7TZ4OMYS77P6huAr7mmdCiF5rMDrD1T3z3C1lPW3BIm1MVHBIEYi3CXBSNm81EWdzkBpWHcUlSLhQBuSJNNBYpwwf4Lh7+sYfThVKwBTLUlq8ibxxYMIYId7X6XWP4zQyCv55fzeqof50QAVk7SsE/g66ukLD8vr9MlMqmL6SYt9KE8L4zV9h/MV7PHxOOSAJ80yZMfoKM6otHsT6H71mdLPHOYpMeJKLfdo3ONl+S9NjfJPl7O2f6UdEtsp4jLsjbMrE4mJSuhpqv6/shY0hpZiAOA3cUkAncoDhtmBJv8cWHogd7dfLEoCCsV/LVXDE4S4es1nrj3HxLnYpQIDAQAB";

/** The extension ID that follows from EXTENSION_PUBLIC_KEY (first 16 bytes of its SHA-256, hex digits mapped to a-p). */
export const EXTENSION_ID = "ombmjhkmnofdcbfafhjcnppjdkalekan";

export interface ManifestOptions {
  /**
   * Hosts granted at install (host_permissions). Release builds pass none: access is requested per host, from a
   * user gesture in the side panel. Only the automated test build passes a host, so no permission prompt blocks it.
   */
  grantedHosts?: string[];
}

export function buildManifest(opts: ManifestOptions = {}): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: "AIRLOCK",
    version: "0.1.0",
    description: "Holds what your browser would send to the sites you choose, lets on-device AI and fixed rules protect it, and sends only what you approve.",
    key: EXTENSION_PUBLIC_KEY,
    minimum_chrome_version: "138",
    permissions: ["sidePanel", "storage", "scripting"],
    ...(opts.grantedHosts && opts.grantedHosts.length > 0 ? { host_permissions: opts.grantedHosts } : {}),
    optional_host_permissions: ["http://*/*", "https://*/*"],
    background: { service_worker: "background.js" },
    side_panel: { default_path: "sidepanel.html" },
    action: { default_title: "AIRLOCK" },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" },
  };
}
