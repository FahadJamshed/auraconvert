import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { config } from './config.js'

/**
 * Generate a safe random filename preserving the extension.
 */
export function safeFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase()
  const allowed = new Set(['.mp4', '.mov', '.webm', '.mp3', '.m4a', '.wav'])
  const safeExt = allowed.has(ext) ? ext : ''
  return `${nanoid(24)}${safeExt}`
}

/**
 * Generate a safe output filename.
 */
export function outputFilename(jobId: string): string {
  return `${jobId}.mp3`
}

/**
 * Get the full path for an uploaded file.
 */
export function uploadPath(filename: string): string {
  return path.join(config.storage.uploadDir, path.basename(filename))
}

/**
 * Get the full path for an output file.
 */
export function outputPath(filename: string): string {
  return path.join(config.storage.outputDir, path.basename(filename))
}

/**
 * Get the full path for a temp file.
 */
export function tempPath(filename: string): string {
  return path.join(config.storage.tempDir, path.basename(filename))
}

/**
 * Delete a file safely (no error if missing).
 */
export function safeDelete(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // Swallow errors — cleanup is best-effort.
  }
}

/**
 * Clean up expired output files older than the configured download expiry.
 */
export function cleanupExpiredFiles(): void {
  const dirs = [config.storage.outputDir, config.storage.tempDir, config.storage.uploadDir]
  const maxAge = config.limits.downloadExpirySeconds * 1000

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    try {
      const files = fs.readdirSync(dir)
      for (const file of files) {
        const filePath = path.join(dir, file)
        try {
          const stat = fs.statSync(filePath)
          if (Date.now() - stat.mtimeMs > maxAge) {
            fs.unlinkSync(filePath)
          }
        } catch {
          // Skip files we can't stat.
        }
      }
    } catch {
      // Skip dirs we can't read.
    }
  }
}

/**
 * Schedule periodic cleanup.
 */
export function startCleanupSchedule(): NodeJS.Timeout {
  // Run cleanup every 10 minutes
  return setInterval(cleanupExpiredFiles, 10 * 60 * 1000)
}
