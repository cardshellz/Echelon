import { defineConfig } from "@playwright/test";

const port = Number(process.env.INVENTORY_PLAYWRIGHT_PORT ?? 5191);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("INVENTORY_PLAYWRIGHT_PORT must be a valid non-privileged TCP port.");
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./test/browser",
  testMatch: [
    "bulk-inventory-tracking.spec.ts",
    "picking-inventory-policy.spec.ts",
    "inventory-availability.spec.ts",
    "inventory-authority-gates.spec.ts",
    "inventory-publication-target-resume.spec.ts",
    "channel-inventory-workspace.spec.ts",
    "walmart-channel-workspace.spec.ts",
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    // Frontend only. All API requests are mocked; no DB or application server starts.
    // Invoke Vite directly so Playwright can terminate it reliably on Windows.
    command: `node node_modules/vite/bin/vite.js --configLoader runner --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
