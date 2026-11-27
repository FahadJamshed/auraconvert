import dotenv from 'dotenv'
import path from 'node:path'
import fs from 'node:fs'

dotenv.config()

function envInt(key: string, fallback: number): number {
  const v = process.env[key]
  if (!v) return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

const defaultStorageRoot = process.env.VERCEL ? '/tmp/auraconvert' : './storage'

export const config = {
  port: envInt('PORT', 3001),
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:8443',

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  storage: {
    uploadDir: path.resolve(process.env.UPLOAD_DIR || `${defaultStorageRoot}/uploads`),
    outputDir: path.resolve(process.env.OUTPUT_DIR || `${defaultStorageRoot}/outputs`),
    tempDir: path.resolve(process.env.TEMP_DIR || `${defaultStorageRoot}/temp`),
  },

  limits: {
    maxFileSizeMB: envInt('MAX_FILE_SIZE_MB', 100),
    maxFileSizeBytes: envInt('MAX_FILE_SIZE_MB', 100) * 1024 * 1024,
    maxConcurrentJobs: envInt('MAX_CONCURRENT_JOBS', 5),
    jobTimeoutSeconds: envInt('JOB_TIMEOUT_SECONDS', 300),
    downloadExpirySeconds: envInt('DOWNLOAD_EXPIRY_SECONDS', 3600),
  },

  ffmpeg: {
    path: process.env.FFMPEG_PATH || 'ffmpeg',
  },

  rateLimit: {
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000),
    maxRequests: envInt('RATE_LIMIT_MAX_REQUESTS', 20),
  },
} as const

/** Ensure storage directories exist. */
export function ensureStorageDirs(): void {
  for (const dir of Object.values(config.storage)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
