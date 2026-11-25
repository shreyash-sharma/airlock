import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { mockCrm } from "./vite-plugins/mock-crm";

export default defineConfig({
  // mockCrm is a labelled stand-in for Salesforce or HubSpot, served by the dev server only.
  // crm-test.html (the mock CRM test page) is served by the dev server and is not part of the production build.
  plugins: [react(), mockCrm()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  test: { environment: "node", include: ["src/**/*.test.ts", "vite-plugins/**/*.test.ts"] },
});
