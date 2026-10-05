import { defineConfig, devices } from '@playwright/test'
// Start the official emulator separately: npx firebase-tools emulators:start --only auth --project demo-na
export default defineConfig({
  testDir: './frontend/e2e', testMatch: ['account.spec.ts', 'devnet.spec.ts'], timeout: 60000,
  fullyParallel: false, workers: 1,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5375', channel: 'chrome', trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run dev:backend', url: 'http://127.0.0.1:3105/api/health', reuseExistingServer: false,
      env: { APP_STORAGE: 'file', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3105', APP_ORIGINS: 'http://127.0.0.1:5375', FIREBASE_PROJECT_ID: 'demo-na',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', ACCOUNT_DATA_DIR: '.data/auth-e2e',
        OPENAI_API_KEY: '', GEMINI_API_KEY: '', GROQ_API_KEY: '', OLLAMA_MODEL: '', SEARCH_PROVIDER_MODE: 'mock' } },
    { command: 'npm run dev -w frontend -- --host 127.0.0.1 --port 5375 --strictPort', url: 'http://127.0.0.1:5375', reuseExistingServer: false,
      env: { GOBUY_API_URL: 'http://127.0.0.1:3105', VITE_FIREBASE_API_KEY: 'demo-api-key', VITE_FIREBASE_PROJECT_ID: 'demo-na',
        VITE_FIREBASE_AUTH_DOMAIN: 'demo-na.firebaseapp.com', VITE_FIREBASE_APP_ID: 'demo-na-web', VITE_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9099' } },
  ],
})
