import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { config } from './config.js'
import { createJob, getJob, updateJob } from './job-store.js'
import { enqueueConversion, cancelQueuedJob } from './queue.js'
import {
  validateUrl,
  validateDirectMediaUrl,
  validateUploadedFile,
  validateArtworkFile,
  validateQuality,
  sanitizeMetadata,
  sanitizeYear,
  sanitizeTrackNumber,
  sanitizeFilename,
  MAX_ARTWORK_SIZE_BYTES,
} from './validation.js'
import { safeFilename, uploadPath, outputPath, safeDelete } from './storage.js'
import { fetchVideoMetadata } from './metadata.js'
import { isStreamingPlatform, STREAMING_PLATFORM_MESSAGE, titleFromUrl } from './remote-source.js'
import type { ConversionResponse, ApiError } from './types.js'

const router = Router()

// ── Multer configuration ────────────────────────────────────────────────────

const upload = multer({
  dest: config.storage.uploadDir,
  limits: {
    fileSize: config.limits.maxFileSizeBytes,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const allowedExts = new Set(['.mp4', '.mov', '.webm', '.mp3', '.m4a', '.wav'])
    if (!allowedExts.has(ext)) {
      cb(new Error('Unsupported file type.'))
      return
    }
    cb(null, true)
  },
})

const uploadArtwork = multer({
  dest: config.storage.uploadDir,
  limits: {
    fileSize: MAX_ARTWORK_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.webp'])
    if (!allowedExts.has(ext)) {
      cb(new Error('Unsupported artwork format. Use JPG, PNG, or WebP.'))
      return
    }
    cb(null, true)
  },
})

// ── Helper to format job for API response ───────────────────────────────────

function formatJobResponse(job: NonNullable<Awaited<ReturnType<typeof getJob>>>): ConversionResponse {
  const response: ConversionResponse = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    title: job.title,
    artist: job.artist,
    album: job.album,
    albumArtist: job.albumArtist,
    genre: job.genre,
    year: job.year,
    trackNumber: job.trackNumber,
    duration: job.duration,
    bitrate: job.bitrate,
    fileSize: job.fileSize,
    hasArtwork: job.hasArtwork,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }

  if (job.error) {
    response.error = job.error
  }

  if (job.status === 'completed' && job.downloadToken) {
    response.downloadUrl = `/api/downloads/${job.downloadToken}`
    response.downloadExpiresAt = job.downloadExpiresAt
  }

  return response
}

// ── POST /api/metadata ──────────────────────────────────────────────────────

router.post('/api/metadata', async (req: Request, res: Response): Promise<void> => {
  try {
    const { url } = req.body
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'A media URL is required.', code: 'MISSING_URL' } satisfies ApiError)
      return
    }

    const validation = validateUrl(url)
    if (!validation.valid) {
      res.status(400).json({ error: validation.error!, code: validation.code! } satisfies ApiError)
      return
    }

    const metadata = await fetchVideoMetadata(url)
    res.json(metadata)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg === 'VIDEO_UNAVAILABLE') {
      res.status(404).json({ error: 'This video is unavailable or private.', code: 'VIDEO_UNAVAILABLE' } satisfies ApiError)
      return
    }
    if (msg === 'METADATA_TIMEOUT') {
      res.status(504).json({ error: 'Timed out while fetching video information.', code: 'TIMEOUT' } satisfies ApiError)
      return
    }
    if (msg === 'METADATA_UNAVAILABLE') {
      res.status(502).json({ error: 'Metadata is unavailable for this link.', code: 'METADATA_UNAVAILABLE' } satisfies ApiError)
      return
    }
    res.status(502).json({ error: 'Could not retrieve video information. Please try again.', code: 'METADATA_ERROR' } satisfies ApiError)
  }
})

// ── POST /api/conversions ───────────────────────────────────────────────────

router.post('/api/conversions', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      sourceType,
      sourceUrl,
      uploadId,
      artworkId,
      quality,
      title,
      artist,
      album,
      albumArtist,
      genre,
      year,
      trackNumber,
    } = req.body

    if (sourceType === 'url') {
      if (!sourceUrl || typeof sourceUrl !== 'string') {
        res.status(400).json({ error: 'A source URL is required.', code: 'MISSING_URL' } satisfies ApiError)
        return
      }

      const urlValidation = validateDirectMediaUrl(sourceUrl)
      if (!urlValidation.valid) {
        res.status(400).json({ error: urlValidation.error!, code: urlValidation.code! } satisfies ApiError)
        return
      }

      // Streaming platforms require an authorized provider integration and are
      // not downloaded. Direct media file links are fetched by the worker.
      if (isStreamingPlatform(new URL(sourceUrl).hostname)) {
        res.status(400).json({ error: STREAMING_PLATFORM_MESSAGE, code: 'UNSUPPORTED_SOURCE' } satisfies ApiError)
        return
      }

      let validArtworkId: string | undefined
      if (artworkId && typeof artworkId === 'string' && fs.existsSync(uploadPath(artworkId))) {
        validArtworkId = artworkId
      }

      const fields = {
        quality: validateQuality(quality),
        title: sanitizeMetadata(title) || sanitizeMetadata(titleFromUrl(sourceUrl)),
        artist: sanitizeMetadata(artist),
        album: sanitizeMetadata(album),
        albumArtist: sanitizeMetadata(albumArtist),
        genre: sanitizeMetadata(genre),
        year: sanitizeYear(year),
        trackNumber: sanitizeTrackNumber(trackNumber),
      }

      const job = await createJob({ sourceType: 'url', sourceUrl, artworkFilename: validArtworkId, ...fields })
      await enqueueConversion({ jobId: job.id, sourceType: 'url', sourceUrl, artworkFilename: validArtworkId, ...fields })

      res.status(201).json(formatJobResponse(job))
      return
    }

    if (sourceType === 'upload') {
      if (!uploadId || typeof uploadId !== 'string') {
        res.status(400).json({ error: 'An upload ID is required.', code: 'MISSING_UPLOAD' } satisfies ApiError)
        return
      }

      // Verify the upload exists
      const uploadFile = uploadPath(uploadId)
      if (!fs.existsSync(uploadFile)) {
        res.status(400).json({ error: 'Upload not found or expired.', code: 'UPLOAD_NOT_FOUND' } satisfies ApiError)
        return
      }

      // Verify artwork if provided
      let validArtworkId: string | undefined
      if (artworkId && typeof artworkId === 'string') {
        const artFile = uploadPath(artworkId)
        if (fs.existsSync(artFile)) {
          validArtworkId = artworkId
        }
      }

      const cleanQuality = validateQuality(quality)
      const cleanTitle = sanitizeMetadata(title)
      const cleanArtist = sanitizeMetadata(artist)
      const cleanAlbum = sanitizeMetadata(album)
      const cleanAlbumArtist = sanitizeMetadata(albumArtist)
      const cleanGenre = sanitizeMetadata(genre)
      const cleanYear = sanitizeYear(year)
      const cleanTrack = sanitizeTrackNumber(trackNumber)

      const job = await createJob({
        sourceType: 'upload',
        uploadFilename: uploadId,
        artworkFilename: validArtworkId,
        quality: cleanQuality,
        title: cleanTitle,
        artist: cleanArtist,
        album: cleanAlbum,
        albumArtist: cleanAlbumArtist,
        genre: cleanGenre,
        year: cleanYear,
        trackNumber: cleanTrack,
      })

      await enqueueConversion({
        jobId: job.id,
        sourceType: 'upload',
        uploadFilename: uploadId,
        artworkFilename: validArtworkId,
        quality: cleanQuality,
        title: cleanTitle,
        artist: cleanArtist,
        album: cleanAlbum,
        albumArtist: cleanAlbumArtist,
        genre: cleanGenre,
        year: cleanYear,
        trackNumber: cleanTrack,
      })

      res.status(201).json(formatJobResponse(job))
      return
    }

    res.status(400).json({ error: 'Invalid source type. Use "upload" or "url".', code: 'INVALID_SOURCE_TYPE' } satisfies ApiError)
  } catch (err) {
    console.error('POST /api/conversions error:', err)
    res.status(500).json({ error: 'An internal error occurred.', code: 'INTERNAL_ERROR' } satisfies ApiError)
  }
})

// ── GET /api/conversions/:id ────────────────────────────────────────────────

router.get('/api/conversions/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id)

    // Validate UUID format to prevent injection
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      res.status(400).json({ error: 'Invalid job ID format.', code: 'INVALID_ID' } satisfies ApiError)
      return
    }

    const job = await getJob(id)
    if (!job) {
      res.status(404).json({ error: 'Conversion not found.', code: 'NOT_FOUND' } satisfies ApiError)
      return
    }

    res.json(formatJobResponse(job))
  } catch (err) {
    console.error('GET /api/conversions/:id error:', err)
    res.status(500).json({ error: 'An internal error occurred.', code: 'INTERNAL_ERROR' } satisfies ApiError)
  }
})

// ── POST /api/conversions/:id/cancel ────────────────────────────────────────

router.post('/api/conversions/:id/cancel', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id)

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      res.status(400).json({ error: 'Invalid job ID format.', code: 'INVALID_ID' } satisfies ApiError)
      return
    }

    const job = await getJob(id)
    if (!job) {
      res.status(404).json({ error: 'Conversion not found.', code: 'NOT_FOUND' } satisfies ApiError)
      return
    }

    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      res.status(409).json({ error: `Cannot cancel a job that is ${job.status}.`, code: 'INVALID_STATE' } satisfies ApiError)
      return
    }

    await cancelQueuedJob(id)

    await updateJob(id, {
      status: 'cancelled',
      error: 'Conversion was cancelled.',
    })

    // Clean up any uploaded file
    if (job.uploadFilename) {
      safeDelete(uploadPath(job.uploadFilename))
    }

    const updated = await getJob(id)
    res.json(formatJobResponse(updated!))
  } catch (err) {
    console.error('POST /api/conversions/:id/cancel error:', err)
    res.status(500).json({ error: 'An internal error occurred.', code: 'INTERNAL_ERROR' } satisfies ApiError)
  }
})

// ── POST /api/uploads ───────────────────────────────────────────────────────

router.post('/api/uploads', (req: Request, res: Response): void => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: `File exceeds the ${config.limits.maxFileSizeMB} MB limit.`, code: 'FILE_TOO_LARGE' } satisfies ApiError)
          return
        }
        res.status(400).json({ error: 'Upload error.', code: 'UPLOAD_ERROR' } satisfies ApiError)
        return
      }
      res.status(400).json({ error: err.message || 'Upload failed.', code: 'UPLOAD_FAILED' } satisfies ApiError)
      return
    }

    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'No file was uploaded.', code: 'NO_FILE' } satisfies ApiError)
      return
    }

    try {
      const validation = validateUploadedFile({
        mimetype: file.mimetype,
        originalname: file.originalname,
        size: file.size,
        path: file.path,
      })

      if (!validation.valid) {
        safeDelete(file.path)
        res.status(400).json({ error: validation.error!, code: validation.code! } satisfies ApiError)
        return
      }

      // Rename to a safe filename
      const safe = safeFilename(file.originalname)
      const dest = uploadPath(safe)
      fs.renameSync(file.path, dest)

      res.status(201).json({
        uploadId: safe,
        filename: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
      })
    } catch (uploadErr) {
      safeDelete(file.path)
      console.error('POST /api/uploads error:', uploadErr)
      res.status(500).json({ error: 'Upload processing failed.', code: 'INTERNAL_ERROR' } satisfies ApiError)
    }
  })
})

// ── POST /api/artwork ───────────────────────────────────────────────────────

router.post('/api/artwork', (req: Request, res: Response): void => {
  uploadArtwork.single('artwork')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'Artwork exceeds the 5 MB limit.', code: 'ARTWORK_TOO_LARGE' } satisfies ApiError)
        return
      }
      res.status(400).json({ error: err.message || 'Artwork upload failed.', code: 'ARTWORK_UPLOAD_FAILED' } satisfies ApiError)
      return
    }

    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'No artwork file was uploaded.', code: 'NO_FILE' } satisfies ApiError)
      return
    }

    try {
      const validation = validateArtworkFile({
        mimetype: file.mimetype,
        originalname: file.originalname,
        size: file.size,
      })

      if (!validation.valid) {
        safeDelete(file.path)
        res.status(400).json({ error: validation.error!, code: validation.code! } satisfies ApiError)
        return
      }

      const ext = path.extname(file.originalname).toLowerCase()
      const safe = `${path.basename(file.path)}${ext}`
      const dest = uploadPath(safe)
      fs.renameSync(file.path, dest)

      res.status(201).json({
        artworkId: safe,
        filename: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
      })
    } catch (artErr) {
      safeDelete(file.path)
      console.error('POST /api/artwork error:', artErr)
      res.status(500).json({ error: 'Artwork processing failed.', code: 'INTERNAL_ERROR' } satisfies ApiError)
    }
  })
})

// ── GET /api/downloads/:token ───────────────────────────────────────────────

router.get('/api/downloads/:token', async (req: Request, res: Response): Promise<void> => {
  try {
    const token = String(req.params.token)

    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) {
      res.status(400).json({ error: 'Invalid download token.', code: 'INVALID_TOKEN' } satisfies ApiError)
      return
    }

    // Search for the job with this download token via Redis scan
    const { getRedis } = await import('./job-store.js')
    const r = getRedis()
    let cursor = '0'

    do {
      const [nextCursor, keys] = await r.scan(cursor, 'MATCH', 'auraconvert:job:*', 'COUNT', 100)
      cursor = nextCursor

      for (const key of keys) {
        const data = await r.get(key)
        if (!data) continue
        const job = JSON.parse(data)

        if (job.downloadToken === token) {
          if (job.downloadExpiresAt && new Date(job.downloadExpiresAt) < new Date()) {
            res.status(410).json({ error: 'Download link has expired.', code: 'DOWNLOAD_EXPIRED' } satisfies ApiError)
            return
          }

          if (!job.outputFilename) {
            res.status(404).json({ error: 'Output file not found.', code: 'FILE_NOT_FOUND' } satisfies ApiError)
            return
          }

          const filePath = outputPath(job.outputFilename)
          if (!fs.existsSync(filePath)) {
            res.status(404).json({ error: 'Output file not found.', code: 'FILE_NOT_FOUND' } satisfies ApiError)
            return
          }

          // Sanitize download filename
          const downloadName = sanitizeFilename(job.title, job.id)

          res.setHeader('Content-Type', 'audio/mpeg')
          res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`)
          res.setHeader('Cache-Control', 'private, no-cache')

          const stream = fs.createReadStream(filePath)
          stream.pipe(res)
          return
        }
      }
    } while (cursor !== '0')

    res.status(404).json({ error: 'Download not found.', code: 'NOT_FOUND' } satisfies ApiError)
  } catch (err) {
    console.error('GET /api/downloads/:token error:', err)
    res.status(500).json({ error: 'Download failed.', code: 'INTERNAL_ERROR' } satisfies ApiError)
  }
})

// ── GET /api/health ─────────────────────────────────────────────────────────

router.get('/api/health', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { getRedis } = await import('./job-store.js')
    const r = getRedis()
    await r.ping()
    res.json({ status: 'ok', redis: 'connected', timestamp: new Date().toISOString() })
  } catch {
    res.status(503).json({ status: 'degraded', redis: 'disconnected', timestamp: new Date().toISOString() })
  }
})

export { router }
