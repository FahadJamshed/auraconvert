import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { config, ensureStorageDirs } from './config.js'
import { router } from './routes.js'
import { startCleanupSchedule } from './storage.js'
import { closeRedis } from './job-store.js'

const app = express()

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400,
}))

app.use(express.json({ limit: '1mb' }))

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
})

app.use('/api/', limiter)

// ── Routes ──────────────────────────────────────────────────────────────────

app.use(router)

// ── Global error handler ────────────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err.message)
  res.status(500).json({ error: 'An unexpected error occurred.', code: 'INTERNAL_ERROR' })
})

// ── Start ───────────────────────────────────────────────────────────────────

ensureStorageDirs()

const cleanupInterval = startCleanupSchedule()

const server = app.listen(config.port, () => {
  console.log(`[AuraConvert API] Running on port ${config.port}`)
  console.log(`[AuraConvert API] CORS origin: ${config.corsOrigin}`)
  console.log(`[AuraConvert API] Environment: ${config.nodeEnv}`)
})

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`\n[AuraConvert API] Received ${signal}, shutting down...`)
  clearInterval(cleanupInterval)
  server.close()
  await closeRedis()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
