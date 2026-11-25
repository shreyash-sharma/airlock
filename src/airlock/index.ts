import { installAirlock as installEngine, type InstallOptions as EngineInstallOptions, type InstalledAirlock } from "./install.js";
import { mountInspector } from "./ui/mount.js";

export type { InstalledAirlock } from "./install.js";

export interface InstallOptions extends EngineInstallOptions {
  /** Element to render the AIRLOCK console into. Ignored when `ui` is given. */
  mount?: HTMLElement;
}

/**
 * One call protects every Firebase AI Logic cloud request the page makes, and any other in-scope host a
 * profile covers, over fetch and XMLHttpRequest: held, minimized, masked, checked by code, shown to the
 * user and only then sent. Call it before any SDK request.
 *
 * This is the web-app entry: with `mount` it renders the console beside the page. The engine itself
 * (install.ts) has no UI dependency, so the Chrome extension bundles that instead.
 */
export function installAirlock(opts: InstallOptions = {}): InstalledAirlock {
  const { mount, ...engineOptions } = opts;
  const ui = engineOptions.ui ?? (mount ? (installed: InstalledAirlock) => mountInspector(mount, installed, installed.analyzer, (opts.protectedTerms ?? []).join(", ")) : undefined);
  return installEngine({ ...engineOptions, ui });
}
