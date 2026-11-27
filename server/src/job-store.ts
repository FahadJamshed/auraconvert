import { Redis } from 'ioredis'
import { v4 as uuidv4 } from 'uuid'
import { nanoid } from 'nanoid'
import type { ConversionJob, JobStatus, SourceType } from './types.js'
import { config } from './config.js'

let redis: Redis | null = null

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    })
  }
  return redis
}

const JOB_PREFIX = 'auraconvert:job:'
const JOB_TTL = 86400 // 24 hours

export async function createJob(params: {
  sourceType: SourceType
  sourceUrl?: string
  uploadFilename?: string
  originalFilename?: string
  artworkFilename?: string
  quality: number
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  genre?: string
  year?: string
  trackNumber?: string
}): Promise<ConversionJob> {
  const r = getRedis()
  const id = uuidv4()
  const now = new Date().toISOString()

  const job: ConversionJob = {
    id,
    status: 'queued',
    sourceType: params.sourceType,
    sourceUrl: params.sourceUrl,
    uploadFilename: params.uploadFilename,
    originalFilename: params.originalFilename,
    artworkFilename: params.artworkFilename,
    quality: params.quality,
    title: params.title,
    artist: params.artist,
    album: params.album,
    albumArtist: params.albumArtist,
    genre: params.genre,
    year: params.year,
    trackNumber: params.trackNumber,
    progress: 0,
    createdAt: now,
    updatedAt: now,
  }

  await r.setex(`${JOB_PREFIX}${id}`, JOB_TTL, JSON.stringify(job))
  return job
}

export async function getJob(id: string): Promise<ConversionJob | null> {
  const r = getRedis()
  const data = await r.get(`${JOB_PREFIX}${id}`)
  if (!data) return null
  return JSON.parse(data) as ConversionJob
}

export async function updateJob(id: string, updates: Partial<ConversionJob>): Promise<ConversionJob | null> {
  const r = getRedis()
  const existing = await getJob(id)
  if (!existing) return null

  const updated: ConversionJob = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  }

  await r.setex(`${JOB_PREFIX}${id}`, JOB_TTL, JSON.stringify(updated))
  return updated
}

export function generateDownloadToken(): string {
  return nanoid(32)
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit()
    redis = null
  }
}
