import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Keep browser tests opt-in, separate from Bun's *.test.ts discovery.
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  outputDir: "../../node_modules/.cache/playwright-results",
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:5183",
    viewport: { width: 1400, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run dev --port 5183 --strictPort",
    cwd: "../..",
    url: "http://127.0.0.1:5183",
    reuseExistingServer: false,
  },
});
