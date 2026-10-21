import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  outputDir: '../../node_modules/.cache/workshop-test-results',
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:5184',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun run workshop:preview',
    cwd: '../..',
    url: 'http://127.0.0.1:5184',
    reuseExistingServer: false,
  },
});
