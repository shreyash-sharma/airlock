import { useEffect, useState } from "react";

export type Page = "overview" | "traffic" | "profiles" | "policies" | "inspection" | "audit" | "hosts";
/** Every page. "hosts" exists only in the Chrome extension (the console hides it from the nav elsewhere). */
export const PAGES: readonly Page[] = ["overview", "traffic", "profiles", "policies", "inspection", "audit", "hosts"];

export interface Route {
  page: Page;
  /** Request id for #/traffic/{id}, or profile id for #/profiles/{id}. */
  id?: string;
  /** "full" for the full request page (?view=full). */
  view?: "full";
  query: Record<string, string>;
}

/** Parse a hash such as "#/traffic/r1?view=full" into a route. Unknown pages fall back to overview. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path, search = ""] = raw.split("?");
  const [first, second] = path.split("/");
  const page = (PAGES as readonly string[]).includes(first) ? (first as Page) : "overview";
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search)) query[k] = v;
  const route: Route = { page, query };
  if ((page === "traffic" || page === "profiles") && second) {
    route.id = decodeURIComponent(second);
    if (query.view === "full") route.view = "full";
  }
  return route;
}

export function hrefFor(page: Page, id?: string, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  return `#/${page}${id ? `/${encodeURIComponent(id)}` : ""}${search ? `?${search}` : ""}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(typeof location === "undefined" ? "" : location.hash));
  useEffect(() => {
    const on = (): void => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(href: string): void {
  location.hash = href;
}
