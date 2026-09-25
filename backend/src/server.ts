import { createApp } from './app.js'
import { env } from './config/env.js'
const server = createApp().listen(env.PORT, env.HOST, () => {
  console.log(`GoBuy proposal API: http://${env.HOST}:${env.PORT}/api/health (demo adapters)`)
})
server.requestTimeout = 20000
server.headersTimeout = 10000
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close())
