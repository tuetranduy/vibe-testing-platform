import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.DEMO_SHOP_TEST_PORT ?? 4100);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: ".",
  testMatch: "demo-shop.test.ts",
  outputDir: "test-results",
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  // Chromium comes from PLAYWRIGHT_BROWSERS_PATH (pre-installed chromium-1194 matches Playwright 1.56).
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node src/server.js",
    url: `${baseURL}/healthz`,
    env: { PORT: String(PORT), HOST: "127.0.0.1", DEMO_SHOP_TEST_ENDPOINTS: "1" },
    reuseExistingServer: false,
    timeout: 15_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
