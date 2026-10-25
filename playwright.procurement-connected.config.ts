import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/connected/procurement",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results/procurement-connected",
  use: {
    serviceWorkers: "block",
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
});
