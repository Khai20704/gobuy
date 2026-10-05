import { defineConfig, devices } from '@playwright/test'
const apiPort = process.env.PLAYWRIGHT_API_PORT || '3101'
const webPort = process.env.PLAYWRIGHT_WEB_PORT || '5273'
const apiUrl = `http://127.0.0.1:${apiPort}`
const webUrl = `http://127.0.0.1:${webPort}`
export default defineConfig({
  testDir: './frontend/e2e',
  fullyParallel: false,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: webUrl,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'npm run dev:backend', url: `${apiUrl}/api/health`, reuseExistingServer: false,
      env: { APP_STORAGE: 'file', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: apiPort, APP_ORIGINS: webUrl, RANKING_WEIGHTS_JSON: '', SEARCH_PROVIDER_MODE: 'mock',
        OPENAI_API_KEY: '', GEMINI_API_KEY: '', GROQ_API_KEY: '', OLLAMA_MODEL: '', TWIN_DATA_DIR: '.data/e2e-commerce-twins' } },
    { command: `npm run dev -w frontend -- --host 127.0.0.1 --port ${webPort} --strictPort`, url: webUrl, reuseExistingServer: false,
      env: { GOBUY_API_URL: apiUrl } },
  ],
})
