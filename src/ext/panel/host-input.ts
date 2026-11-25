import { canonicalHost } from "../../airlock/profiles/match.js";
import { isValidHostPattern, scopeHostOf } from "../protocol.js";

export type HostInput = { ok: true; pattern: string; name: string } | { ok: false; error: string };

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Turn what the user typed into the Chrome match pattern AIRLOCK stores. The input is a host name only:
 *   crm.example.com        -> https://crm.example.com/*
 *   *.example.com          -> https://*.example.com/*   (the domain and its subdomains)
 *   localhost:3000         -> http://localhost:3000/*   (local addresses are not served over HTTPS)
 * Everything that could widen the grant is refused with a plain-words reason: a scheme, a path, a bare wildcard,
 * a wildcard over a whole suffix such as *.com, spaces, credentials and anything the engine's host check rejects.
 * The match is the engine's own (canonicalHost, isValidHostPattern), so what the user sees is what is enforced.
 */
export function patternFromInput(raw: string): HostInput {
  const typed = raw.trim();
  if (typed === "") return { ok: false, error: "Enter a host name, for example crm.example.com." };
  if (typed.length > 200) return { ok: false, error: "That host name is too long." };
  if (/\s/.test(typed)) return { ok: false, error: "A host name has no spaces." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) || typed.includes("://")) {
    return { ok: false, error: "Enter the host name only, without http:// or https://. AIRLOCK chooses the scheme." };
  }
  if (/[/?#\\]/.test(typed)) return { ok: false, error: "Enter the host name only. A path, query or fragment is not part of a host." };
  if (typed.includes("@")) return { ok: false, error: "A host name has no user name or password." };
  if (typed === "*" || /^\*+\.?\**$/.test(typed)) return { ok: false, error: "A wildcard for every site is not allowed. Name the host, or use *.domain.com for one domain." };

  const lowered = typed.toLowerCase();
  const wildcard = lowered.startsWith("*.");
  const rest = wildcard ? lowered.slice(2) : lowered;
  if (rest.includes("*")) return { ok: false, error: "A wildcard is allowed only at the start, as in *.example.com." };
  const canonical = canonicalHost(rest);
  const hostname = canonical.replace(/:\d+$/, "");
  if (wildcard && (!hostname.includes(".") || /^\d+(?:\.\d+)*$/.test(hostname))) {
    return { ok: false, error: "A wildcard needs a full domain, such as *.example.com. A whole suffix such as *.com is not allowed." };
  }
  if (wildcard && canonical.includes(":")) return { ok: false, error: "A wildcard host cannot name a port." };
  if (/^\d+(?:\.\d+)*$/.test(hostname) && !IPV4.test(hostname)) return { ok: false, error: `"${typed.slice(0, 60)}" is not a host name.` };

  const scheme = LOOPBACK.test(canonical) ? "http" : "https";
  const pattern = `${scheme}://${wildcard ? "*." : ""}${canonical}/*`;
  if (!isValidHostPattern(pattern)) return { ok: false, error: `"${typed.slice(0, 60)}" is not a valid host name (letters, digits, dots, hyphens and an optional :port).` };
  return { ok: true, pattern, name: scopeHostOf(pattern) };
}

/** Hold-timeout input in seconds to milliseconds, or the reason it is refused. Clamping happens in the protocol. */
export function timeoutFromInput(seconds: number, min: number, max: number): { ok: true; ms: number } | { ok: false; error: string } {
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) return { ok: false, error: "Enter a whole number of seconds." };
  const lo = Math.ceil(min / 1000);
  const hi = Math.floor(max / 1000);
  if (seconds < lo || seconds > hi) return { ok: false, error: `Enter between ${lo} and ${hi} seconds.` };
  return { ok: true, ms: seconds * 1000 };
}
