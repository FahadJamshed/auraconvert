import { config } from './config.js'
import { app } from './app.js'
import { startCleanupSchedule } from './storage.js'
import { closeRedis } from './job-store.js'

const cleanupInterval = startCleanupSchedule()

const server = app.listen(config.port, () => {
  console.log(`[AuraConvert API] Running on port ${config.port}`)
  console.log(`[AuraConvert API] CORS origin: ${config.corsOrigin}`)
  console.log(`[AuraConvert API] Environment: ${config.nodeEnv}`)
})

async function shutdown(signal: string) {
  console.log(`\n[AuraConvert API] Received ${signal}, shutting down...`)
  clearInterval(cleanupInterval)
  server.close()
  await closeRedis()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
