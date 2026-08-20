import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8099',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npx http-server -p 8099 -s .',
    port: 8099,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
