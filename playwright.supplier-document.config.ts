import { defineConfig } from "@playwright/test";

// The real pure projection/renderer are exercised in Chromium without starting
// the application, loading environment files, a database or external resources.
export default defineConfig({
  testDir: "./test/browser",
  testMatch: "procurement-supplier-document.spec.ts",
  workers: 1,
  timeout: 30_000,
  use: {
    serviceWorkers: "block",
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
});
