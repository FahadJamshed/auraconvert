import { Queue } from 'bullmq'
import { getRedis } from './job-store.js'

export const CONVERSION_QUEUE = 'auraconvert:conversions'

let queue: Queue | null = null

export function getQueue(): Queue {
  if (!queue) {
    const connection = getRedis()
    queue = new Queue(CONVERSION_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400, count: 500 },
      },
    })
  }
  return queue
}

export interface ConversionJobData {
  jobId: string
  sourceType: 'upload' | 'url'
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
}

export async function enqueueConversion(data: ConversionJobData): Promise<void> {
  const q = getQueue()
  await q.add('convert', data, {
    jobId: data.jobId,
  })
}

export async function cancelQueuedJob(jobId: string): Promise<boolean> {
  const q = getQueue()
  const job = await q.getJob(jobId)
  if (!job) return false

  const state = await job.getState()
  if (state === 'waiting' || state === 'delayed') {
    await job.remove()
    return true
  }
  return false
}
