// Build the AIRLOCK Chrome extension into a loadable folder.
//   npm run build:ext                         -> dist-ext/   (release shape: no host permissions granted at install)
//   node scripts/build-ext.mjs --out dist-ext-test --test-host "http://127.0.0.1:5173/*"
//                                             -> the AUTOMATED TEST build: the test host is granted at install so no
//                                                permission prompt blocks the real-Chrome check. Never ship this one.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";

const args = process.argv.slice(2);
const flag = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
  return out;
};
const out = resolve(flag("--out")[0] ?? "dist-ext");
const testHosts = flag("--test-host");

rmSync(out, { recursive: true, force: true });
process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = "true";
process.env.AIRLOCK_EXT_OUT = out;
process.env.AIRLOCK_EXT_TEST_HOSTS = testHosts.join(",");

// background last: it writes manifest.json and sidepanel.html once everything else exists.
for (const entry of ["page", "bridge", "sidepanel", "background"]) {
  process.env.AIRLOCK_EXT_ENTRY = entry;
  console.log(`[build:ext] ${entry}`);
  await build({ configFile: resolve("vite.ext.config.ts"), logLevel: "warn" });
}
console.log(`[build:ext] done: ${out}${testHosts.length ? ` (TEST build, host_permissions: ${testHosts.join(", ")})` : ""}`);
