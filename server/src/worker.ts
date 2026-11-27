import { Worker, type Job } from 'bullmq'
import { getRedis, updateJob, generateDownloadToken } from './job-store.js'
import { config, ensureStorageDirs } from './config.js'
import { CONVERSION_QUEUE, type ConversionJobData } from './queue.js'
import { convertToMp3, verifyMp3Output } from './ffmpeg.js'
import { uploadPath, outputPath, outputFilename, safeDelete } from './storage.js'
import { downloadDirectMedia, RemoteSourceError } from './remote-source.js'

ensureStorageDirs()

console.log('[AuraConvert Worker] Starting...')
console.log(`[AuraConvert Worker] Redis: ${config.redis.url}`)
console.log(`[AuraConvert Worker] Max concurrent: ${config.limits.maxConcurrentJobs}`)

const connection = getRedis()

const worker = new Worker<ConversionJobData>(
  CONVERSION_QUEUE,
  async (job: Job<ConversionJobData>) => {
    const {
      jobId,
      sourceType,
      sourceUrl,
      uploadFilename,
      artworkFilename,
      quality,
      title,
      artist,
      album,
      albumArtist,
      genre,
      year,
      trackNumber,
    } = job.data

    console.log(`[Worker] Processing job ${jobId} (${sourceType}, ${quality}kbps)`)

    try {
      // ── Validating ──────────────────────────────────────────────────────
      await updateJob(jobId, { status: 'validating', progress: 5 })

      let inputFile: string

      if (sourceType === 'url') {
        if (!sourceUrl) {
          await updateJob(jobId, { status: 'failed', error: 'A source URL is required.' })
          return
        }
        try {
          // Download phase maps to 5–15% of overall progress.
          const downloaded = await downloadDirectMedia(sourceUrl, config.storage.uploadDir, `url-${jobId}`, (pct) => {
            void updateJob(jobId, { progress: 5 + Math.round(pct / 10) })
          })
          inputFile = downloaded.filePath
        } catch (err) {
          const message = err instanceof RemoteSourceError ? err.message : 'Could not download the linked file.'
          await updateJob(jobId, { status: 'failed', error: message, progress: 0 })
          if (artworkFilename) safeDelete(uploadPath(artworkFilename))
          return
        }
      } else if (sourceType === 'upload' && uploadFilename) {
        inputFile = uploadPath(uploadFilename)
      } else {
        await updateJob(jobId, { status: 'failed', error: 'Unsupported conversion source.' })
        return
      }

      const { existsSync } = await import('node:fs')
      if (!existsSync(inputFile)) {
        await updateJob(jobId, {
          status: 'failed',
          error: 'Upload file not found. It may have been cleaned up.',
        })
        return
      }

      // ── Preparing ───────────────────────────────────────────────────────
      await updateJob(jobId, { status: 'preparing', progress: 10 })

      const outFile = outputFilename(jobId)
      const outPath = outputPath(outFile)
      const artPath = artworkFilename ? uploadPath(artworkFilename) : undefined

      // ── Processing ──────────────────────────────────────────────────────
      await updateJob(jobId, { status: 'processing', progress: 15 })

      const result = await convertToMp3({
        inputPath: inputFile,
        outputPath: outPath,
        artworkPath: artPath,
        quality,
        metadata: { title, artist, album, albumArtist, genre, year, trackNumber },
        onProgress: async (progress) => {
          // Scale progress: 15–90%
          const scaled = 15 + Math.round(progress.percent * 0.75)
          await updateJob(jobId, { progress: Math.min(scaled, 90) })
        },
      })

      if (!result.success) {
        await updateJob(jobId, {
          status: 'failed',
          error: result.error || 'Conversion failed.',
          progress: 0,
        })
        safeDelete(inputFile)
        if (artPath) safeDelete(artPath)
        return
      }

      // ── Finalizing & Verification ───────────────────────────────────────
      await updateJob(jobId, { status: 'finalizing', progress: 95 })

      const verification = await verifyMp3Output(outPath)
      if (!verification.valid) {
        await updateJob(jobId, {
          status: 'failed',
          error: 'Output verification failed. The generated MP3 could not be validated.',
          progress: 0,
        })
        safeDelete(inputFile)
        if (artPath) safeDelete(artPath)
        safeDelete(outPath)
        return
      }

      const downloadToken = generateDownloadToken()
      const expiresAt = new Date(Date.now() + config.limits.downloadExpirySeconds * 1000).toISOString()

      await updateJob(jobId, {
        status: 'completed',
        progress: 100,
        outputFilename: outFile,
        downloadToken,
        downloadExpiresAt: expiresAt,
        duration: verification.duration,
        bitrate: verification.bitrate || quality,
        fileSize: verification.fileSize,
        hasArtwork: verification.hasArtwork,
      })

      // Clean up temporary upload & artwork files after successful conversion
      safeDelete(inputFile)
      if (artPath) safeDelete(artPath)

      console.log(`[Worker] Job ${jobId} completed in ${result.durationMs}ms`)
    } catch (err) {
      console.error(`[Worker] Job ${jobId} failed:`, err)
      await updateJob(jobId, {
        status: 'failed',
        error: 'An unexpected error occurred during processing.',
        progress: 0,
      })
    }
  },
  {
    connection,
    concurrency: config.limits.maxConcurrentJobs,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 200 },
  },
)

worker.on('completed', (job) => {
  console.log(`[Worker] BullMQ job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  console.error(`[Worker] BullMQ job ${job?.id} failed:`, err.message)
})

worker.on('error', (err) => {
  console.error('[Worker] Worker error:', err)
})

console.log('[AuraConvert Worker] Ready and listening for jobs.')

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`\n[AuraConvert Worker] Received ${signal}, shutting down...`)
  await worker.close()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
