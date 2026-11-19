import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "app-bootstrap.spec.ts",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 30_000 },
  outputDir: "test-results/app-bootstrap",
  use: {
    baseURL: "http://127.0.0.1:5195",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5195 --strictPort",
    url: "http://127.0.0.1:5195",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
