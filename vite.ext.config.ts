import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildManifest } from "./src/ext/manifest";

/**
 * The extension build: one Vite build per entry, each a single self-contained classic script (IIFE), because content
 * scripts and the service worker cannot load ES module chunks. scripts/build-ext.mjs runs them in turn, selecting the
 * entry and output folder through environment variables:
 *   AIRLOCK_EXT_ENTRY       background | bridge | page | sidepanel
 *   AIRLOCK_EXT_OUT         output folder (default dist-ext)
 *   AIRLOCK_EXT_TEST_HOSTS  comma-separated match patterns written to host_permissions: the AUTOMATED TEST build only
 * Firebase config comes from .env.local at build time, exactly as the web app takes it (the public web config; the
 * built folder stays untracked).
 */
export const ENTRIES = {
  background: "src/ext/background/index.ts",
  bridge: "src/ext/bridge/main.ts",
  page: "src/ext/page/main.ts",
  sidepanel: "src/ext/panel/main.tsx",
} as const;

type EntryName = keyof typeof ENTRIES;

/** Writes manifest.json and copies sidepanel.html next to the bundles. Runs once, with the background entry. */
function staticFiles(outDir: string): Plugin {
  return {
    name: "airlock-ext-static",
    writeBundle() {
      mkdirSync(outDir, { recursive: true });
      const granted = (process.env.AIRLOCK_EXT_TEST_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      writeFileSync(resolve(outDir, "manifest.json"), `${JSON.stringify(buildManifest({ grantedHosts: granted }), null, 2)}\n`);
      copyFileSync(resolve("src/ext/panel/sidepanel.html"), resolve(outDir, "sidepanel.html"));
    },
  };
}

export default defineConfig(() => {
  const entry = (process.env.AIRLOCK_EXT_ENTRY ?? "page") as EntryName;
  const outDir = resolve(process.env.AIRLOCK_EXT_OUT ?? "dist-ext");
  return {
    publicDir: false as const,
    plugins: entry === "background" ? [staticFiles(outDir)] : entry === "sidepanel" ? [react()] : [],
    // React reads process.env.NODE_ENV; an IIFE library build does not replace it on its own.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir,
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      minify: true,
      lib: { entry: resolve(ENTRIES[entry]), name: `airlock_${entry}`, formats: ["iife" as const], fileName: () => `${entry}.js`, cssFileName: entry },
    },
  };
});
