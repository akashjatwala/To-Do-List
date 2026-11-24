import { defineConfig } from '@playwright/test'

/**
 * Browser checks run against the built app and an isolated SQLite file. The
 * installed Chrome channel is used so Playwright never downloads a browser.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3101',
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --import tsx server/start.ts',
    url: 'http://127.0.0.1:3101/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: '3101',
      DUIT_DB_PATH: './server/data/todo.e2e.db',
      NODE_ENV: 'development',
      ML_DISABLE_SCHEDULER: '1',
    },
  },
})
