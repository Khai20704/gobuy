import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './frontend/e2e', testMatch: 'genuine.spec.ts', fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5283', channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -w frontend -- --host 127.0.0.1 --port 5283 --strictPort',
    url: 'http://127.0.0.1:5283', reuseExistingServer: false },
})
