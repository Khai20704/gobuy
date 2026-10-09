import { createApp } from './app.js'
import { env } from './config/env.js'
import { mongoDatabase, storageMode } from './persistence/mongo.js'
import { startPersistentDeliveryWorker } from './services/delivery/DeliveryWorker.js'
try {
  if (storageMode() === 'mongo') await mongoDatabase.get()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Application storage initialization failed')
  console.error('Starting API in degraded mode; MongoDB operations will retry when requests arrive.')
}
const server = createApp().listen(env.PORT, env.HOST, () => {
  console.log(`GoBuy API: http://${env.HOST}:${env.PORT}/api/health (research providers: ${env.SEARCH_PROVIDER_MODE}; authority: Devnet demo)`)
})
server.requestTimeout = 20000
server.headersTimeout = 10000
const stopDeliveryWorker = startPersistentDeliveryWorker()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  server.close(() => { void stopDeliveryWorker().then(() => mongoDatabase.close()) })
  void stopDeliveryWorker()
})
