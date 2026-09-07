import { defineConfig } from "playwright/test";
export default defineConfig({
  testDir: "./test/browser", testMatch: ["dropship-pricing-*.spec.ts", "dropship-content-*.spec.ts"], fullyParallel: false, workers: 1,
  timeout: 45_000, expect: { timeout: 15_000 },
  use: { baseURL: "http://127.0.0.1:5187", serviceWorkers: "block", trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {} },
  projects: [{ name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } }],
  webServer: { command: "npx vite --host 127.0.0.1 --port 5187 --strictPort", url: "http://127.0.0.1:5187",
    reuseExistingServer: false, timeout: 60_000 },
});
