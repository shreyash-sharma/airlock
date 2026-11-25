import type { Profile } from "./types.js";

/** Segment matcher: * matches any run of characters inside one segment (classic wildcard walk). */
function segmentMatches(pattern: string, segment: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < segment.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = s;
    } else if (p < pattern.length && pattern[p] === segment[s]) {
      p++;
      s++;
    } else if (star !== -1) {
      p = star + 1;
      s = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

function segmentsOf(path: string): string[] {
  const q = path.indexOf("?");
  const h = path.indexOf("#");
  const cut = [q, h].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  return (cut === undefined ? path : path.slice(0, cut)).split("/").filter((s) => s !== "");
}

/**
 * Path glob: * within one segment, ** across any number of segments (including none). The query string
 * is ignored. "/a/**" matches "/a", "/a/x" and "/a/x/y".
 */
export function globMatch(pattern: string, path: string): boolean {
  const pat = segmentsOf(pattern);
  const segs = segmentsOf(path);
  const walk = (pi: number, si: number): boolean => {
    if (pi === pat.length) return si === segs.length;
    if (pat[pi] === "**") {
      for (let k = si; k <= segs.length; k++) if (walk(pi + 1, k)) return true;
      return false;
    }
    if (si === segs.length) return false;
    return segmentMatches(pat[pi], segs[si]) && walk(pi + 1, si + 1);
  };
  return walk(0, 0);
}

function hostnameOf(host: string): string {
  const colon = host.lastIndexOf(":");
  return colon !== -1 && !host.endsWith("]") ? host.slice(0, colon) : host;
}

/**
 * One spelling per host: lower case, trailing dots removed (the absolute form crm.example.com. is the same
 * host), and a default port (:80, :443) dropped. Scope and matching compare only this form, so a spelling
 * trick cannot move a request out of scope. URL.host already lower-cases and punycodes; this covers the rest.
 */
export function canonicalHost(host: string): string {
  const lower = host.trim().toLowerCase();
  const colon = lower.lastIndexOf(":");
  const hasPort = colon !== -1 && !lower.endsWith("]") && /^\d*$/.test(lower.slice(colon + 1));
  const name = (hasPort ? lower.slice(0, colon) : lower).replace(/\.+$/, "");
  const port = hasPort ? lower.slice(colon + 1) : "";
  return port === "" || port === "80" || port === "443" ? name : `${name}:${port}`;
}

/** A pattern with a port equals the URL host; one without equals the hostname (any port). */
export function hostMatches(pattern: string, host: string): boolean {
  const p = canonicalHost(pattern);
  const h = canonicalHost(host);
  // "*.example.com" (as in a Chrome match pattern) is example.com and every subdomain of it, on any port.
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    const name = hostnameOf(h);
    return base !== "" && !base.includes("*") && (name === base || name.endsWith(`.${base}`));
  }
  return p.includes(":") && !p.endsWith("]") ? p === h : p === hostnameOf(h);
}

export interface RequestKey {
  /** URL host: hostname plus the port when it is not the default. */
  host: string;
  path: string;
  method: string;
  contentType: string;
}

const isRead = (method: string): boolean => method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";

/**
 * Host, path, method and content type must all fit. One rule is specific to reads: a GET or HEAD has no body and so
 * no content type, and a profile's content-type prefixes (copied from the JSON write it was authored from) would
 * keep it from ever matching one. That prefix check is skipped ONLY when the profile's methods explicitly name the
 * read method. A profile with no methods, or with only write methods and content types, still never covers a read.
 */
export function profileMatches(profile: Profile, req: RequestKey): boolean {
  const m = profile.match;
  if (!m.hosts.some((h) => hostMatches(h, req.host))) return false;
  if (!m.paths.some((p) => globMatch(p, req.path))) return false;
  const named = !!m.methods && m.methods.some((x) => x.toUpperCase() === req.method.toUpperCase());
  if (m.methods && m.methods.length > 0 && !named) return false;
  const exempt = isRead(req.method) && named;
  if (!exempt && m.contentTypes && m.contentTypes.length > 0) {
    const ct = req.contentType.toLowerCase();
    if (!m.contentTypes.some((c) => ct.startsWith(c.toLowerCase()))) return false;
  }
  return true;
}

/** First profile that matches wins. Callers list user and AI-authored profiles before built-ins. */
export function matchProfile(profiles: readonly Profile[], req: RequestKey): Profile | null {
  return profiles.find((p) => profileMatches(p, req)) ?? null;
}

/** A host is in scope when any profile names it or the explicit scope list does. */
export function inScope(host: string, profiles: readonly Profile[], scope: readonly string[] = []): boolean {
  return profiles.some((p) => p.match.hosts.some((h) => hostMatches(h, host))) || scope.some((s) => hostMatches(s, host));
}
