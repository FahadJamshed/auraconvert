import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { config, ensureStorageDirs } from './config.js'
import { router } from './routes.js'

const app = express()

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({
  origin: config.corsOrigin === '*' ? true : [config.corsOrigin, 'http://localhost:8443', 'http://localhost:5173'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400,
}))

app.use(express.json({ limit: '1mb' }))

const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
})

app.use('/api/', limiter)

// ── Routes ──────────────────────────────────────────────────────────────────

ensureStorageDirs()
app.use(router)

// ── Global error handler ────────────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err.message)
  res.status(500).json({ error: 'An unexpected error occurred.', code: 'INTERNAL_ERROR' })
})

export { app }
export default app
