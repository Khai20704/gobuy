import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { solanaConfig } from '@gobuy/shared'
import { apiProxy } from './dev/apiProxy'
const apiTarget = process.env.GOBUY_API_URL || 'http://127.0.0.1:3001'
export default defineConfig(({ mode }) => {
  const config = solanaConfig({ ...loadEnv(mode, '..', ''), ...loadEnv(mode, '.', ''), ...process.env })
  return {
  define: {
    'import.meta.env.VITE_SOLANA_NETWORK': JSON.stringify(config.network),
    'import.meta.env.VITE_SOLANA_RPC_URL': JSON.stringify(config.rpcUrl),
  },
  plugins: [react()],
  server: { proxy: { '/api': apiProxy(apiTarget) } },
  preview: { proxy: { '/api': apiProxy(apiTarget) } },
}})
