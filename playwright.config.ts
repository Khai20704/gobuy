import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './frontend/e2e',
  fullyParallel: false,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'npm run dev:backend', url: 'http://127.0.0.1:3001/api/health', reuseExistingServer: !process.env.CI },
    { command: 'npm run dev -w frontend -- --host 127.0.0.1', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI },
  ],
})
