import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { config } from './config.js'
import { isPathWithin } from './validation.js'
import type { Mp3Metadata } from './types.js'

export interface FFmpegProgress {
  percent: number
  timeMs: number
}

export interface FFmpegResult {
  success: boolean
  outputPath: string
  durationMs: number
  error?: string
}

export interface Mp3Verification {
  valid: boolean
  duration: number
  bitrate: number
  fileSize: number
  hasArtwork: boolean
}

/**
 * Get the duration of a media file in seconds using ffprobe.
 */
export async function getMediaDuration(inputPath: string): Promise<number> {
  const resolvedInput = path.resolve(inputPath)

  const inUpload = isPathWithin(resolvedInput, config.storage.uploadDir)
  const inTemp = isPathWithin(resolvedInput, config.storage.tempDir)
  if (!inUpload && !inTemp) {
    throw new Error('Input file is not in an allowed directory.')
  }

  if (!fs.existsSync(resolvedInput)) {
    throw new Error('Input file does not exist.')
  }

  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      resolvedInput,
    ], {
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    ffprobe.stdout.on('data', (data: Buffer) => { stdout += data.toString() })

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Could not read media duration.'))
        return
      }
      const duration = parseFloat(stdout.trim())
      resolve(Number.isFinite(duration) ? duration : 0)
    })

    ffprobe.on('error', (err) => reject(err))
  })
}

/**
 * Verify the generated MP3 output using ffprobe (duration, bitrate, embedded artwork).
 */
export async function verifyMp3Output(outputPath: string): Promise<Mp3Verification> {
  const resolvedOutput = path.resolve(outputPath)
  if (!isPathWithin(resolvedOutput, config.storage.outputDir) || !fs.existsSync(resolvedOutput)) {
    return { valid: false, duration: 0, bitrate: 0, fileSize: 0, hasArtwork: false }
  }

  const stat = fs.statSync(resolvedOutput)

  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      resolvedOutput,
    ], {
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    ffprobe.stdout.on('data', (data: Buffer) => { stdout += data.toString() })

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        resolve({ valid: false, duration: 0, bitrate: 0, fileSize: stat.size, hasArtwork: false })
        return
      }

      try {
        const info = JSON.parse(stdout) as {
          format?: { duration?: string; bit_rate?: string }
          streams?: Array<{ codec_type?: string; disposition?: { attached_pic?: number } }>
        }
        const duration = Math.round(parseFloat(info.format?.duration || '0'))
        const bitrate = Math.round(parseInt(info.format?.bit_rate || '0', 10) / 1000)
        const hasAudio = Boolean(info.streams?.some((s) => s.codec_type === 'audio'))
        const hasArtwork = Boolean(
          info.streams?.some((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1)
        )

        resolve({
          valid: hasAudio,
          duration: Number.isFinite(duration) ? duration : 0,
          bitrate: Number.isFinite(bitrate) ? bitrate : 0,
          fileSize: stat.size,
          hasArtwork,
        })
      } catch {
        resolve({ valid: false, duration: 0, bitrate: 0, fileSize: stat.size, hasArtwork: false })
      }
    })

    ffprobe.on('error', () => {
      resolve({ valid: false, duration: 0, bitrate: 0, fileSize: stat.size, hasArtwork: false })
    })
  })
}

/**
 * Convert a media file to MP3 using FFmpeg, with ID3v2.3 metadata and optional embedded artwork.
 */
export async function convertToMp3(params: {
  inputPath: string
  outputPath: string
  artworkPath?: string
  quality: number
  metadata?: Mp3Metadata
  onProgress?: (progress: FFmpegProgress) => void
  signal?: AbortSignal
}): Promise<FFmpegResult> {
  const resolvedInput = path.resolve(params.inputPath)
  const resolvedOutput = path.resolve(params.outputPath)

  const inUpload = isPathWithin(resolvedInput, config.storage.uploadDir)
  const inTemp = isPathWithin(resolvedInput, config.storage.tempDir)
  if (!inUpload && !inTemp) {
    throw new Error('Input file is not in an allowed directory.')
  }

  if (!isPathWithin(resolvedOutput, config.storage.outputDir)) {
    throw new Error('Output path is not in the allowed output directory.')
  }

  if (!fs.existsSync(resolvedInput)) {
    throw new Error('Input file does not exist.')
  }

  let resolvedArtwork: string | undefined
  if (params.artworkPath) {
    const art = path.resolve(params.artworkPath)
    if (isPathWithin(art, config.storage.uploadDir) && fs.existsSync(art)) {
      resolvedArtwork = art
    }
  }

  let totalDuration = 0
  try {
    totalDuration = await getMediaDuration(resolvedInput)
  } catch {
    // Duration unknown
  }

  const startTime = Date.now()
  const args: string[] = ['-i', resolvedInput]

  if (resolvedArtwork) {
    args.push('-i', resolvedArtwork)
    args.push('-map', '0:a', '-map', '1:v')
    args.push('-c:v', 'mjpeg')
    args.push('-vf', 'scale=600:600:force_original_aspect_ratio=decrease')
    args.push('-metadata:s:v', 'title=Album cover')
    args.push('-metadata:s:v', 'comment=Cover (front)')
  } else {
    args.push('-vn')
  }

  args.push(
    '-acodec', 'libmp3lame',
    '-ab', `${params.quality}k`,
    '-ar', '44100',
    '-ac', '2',
    '-id3v2_version', '3',
  )

  const meta = params.metadata
  if (meta?.title) args.push('-metadata', `title=${meta.title}`)
  if (meta?.artist) args.push('-metadata', `artist=${meta.artist}`)
  if (meta?.album) args.push('-metadata', `album=${meta.album}`)
  if (meta?.albumArtist) args.push('-metadata', `album_artist=${meta.albumArtist}`)
  if (meta?.genre) args.push('-metadata', `genre=${meta.genre}`)
  if (meta?.year) args.push('-metadata', `date=${meta.year}`)
  if (meta?.trackNumber) args.push('-metadata', `track=${meta.trackNumber}`)

  args.push('-progress', 'pipe:1', '-y', resolvedOutput)

  return new Promise((resolve) => {
    const ffmpeg = spawn(config.ffmpeg.path, args, {
      timeout: config.limits.jobTimeoutSeconds * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (params.signal) {
      params.signal.addEventListener('abort', () => {
        ffmpeg.kill('SIGTERM')
      }, { once: true })
    }

    let stderr = ''

    ffmpeg.stdout.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n')
      for (const line of lines) {
        const match = line.match(/^out_time_us=(\d+)/)
        if (match) {
          const timeUs = parseInt(match[1], 10)
          const timeMs = timeUs / 1000
          let percent = 0
          if (totalDuration > 0) {
            percent = Math.min(99, Math.round((timeMs / 1000 / totalDuration) * 100))
          }
          params.onProgress?.({ percent, timeMs })
        }
      }
    })

    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
      if (stderr.length > 10240) {
        stderr = stderr.slice(-5120)
      }
    })

    ffmpeg.on('close', (code) => {
      const durationMs = Date.now() - startTime
      if (code === 0 && fs.existsSync(resolvedOutput)) {
        resolve({ success: true, outputPath: resolvedOutput, durationMs })
      } else {
        try { fs.unlinkSync(resolvedOutput) } catch { /* ignore */ }
        resolve({
          success: false,
          outputPath: resolvedOutput,
          durationMs,
          error: code === null
            ? 'Processing timed out.'
            : 'Processing failed. The file may be corrupted or unsupported.',
        })
      }
    })

    ffmpeg.on('error', (err) => {
      const durationMs = Date.now() - startTime
      resolve({
        success: false,
        outputPath: resolvedOutput,
        durationMs,
        error: err.message.includes('ENOENT')
          ? 'FFmpeg is not installed or not found.'
          : 'Processing failed unexpectedly.',
      })
    })
  })
}
