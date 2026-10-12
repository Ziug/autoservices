import {devices, defineConfig} from '@playwright/test';

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {timeout: 5_000},
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: externalBaseURL ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {name: 'desktop-chromium', use: {...devices['Desktop Chrome']}},
    {name: 'phone-chromium', use: {...devices['iPhone 13'], browserName: 'chromium'}},
  ],
  webServer: externalBaseURL ? undefined : {
    command: 'node scripts/tenants.mjs build-assets && ./node_modules/.bin/vite --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
