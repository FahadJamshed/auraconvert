import path from 'node:path'
import { config } from './config.js'

/** Allowed MIME types for media upload. */
export const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/mp4a-latm',
  'audio/x-m4a',
])

/** Allowed media file extensions. */
export const ALLOWED_EXTENSIONS = new Set([
  '.mp4', '.mov', '.webm', '.mp3', '.m4a', '.wav',
])

/** Allowed artwork MIME types. */
export const ALLOWED_ARTWORK_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])

/** Allowed artwork extensions. */
export const ALLOWED_ARTWORK_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp',
])

/** Max artwork size: 5 MB. */
export const MAX_ARTWORK_SIZE_BYTES = 5 * 1024 * 1024

/** Valid quality values in kbps. */
export const VALID_QUALITIES = new Set([128, 192, 256, 320])

/** Supported URL hosts for metadata preview. */
export const SUPPORTED_URL_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'vimeo.com',
  'www.vimeo.com',
  'soundcloud.com',
  'www.soundcloud.com',
])

export interface ValidationResult {
  valid: boolean
  error?: string
  code?: string
}

export function validateUrl(urlString: string): ValidationResult {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    return { valid: false, error: 'Invalid URL format.', code: 'INVALID_URL' }
  }

  if (!['https:', 'http:'].includes(url.protocol)) {
    return { valid: false, error: 'Only HTTPS and HTTP URLs are supported.', code: 'INVALID_PROTOCOL' }
  }

  const host = url.hostname.toLowerCase()
  if (!SUPPORTED_URL_HOSTS.has(host)) {
    return { valid: false, error: 'This source is not supported. Use YouTube, Vimeo, or SoundCloud URLs.', code: 'UNSUPPORTED_SOURCE' }
  }

  if (host.includes('youtube.com') || host === 'youtu.be') {
    const hasVideo = url.searchParams.has('v') || (host === 'youtu.be' && url.pathname.length > 1)
    if (!hasVideo && url.pathname === '/') {
      return { valid: false, error: 'Paste a link to a specific video, not the homepage.', code: 'NO_RESOURCE' }
    }
  }

  return { valid: true }
}

/** Validate a direct media file URL (used for URL-based conversion). */
export function validateDirectMediaUrl(urlString: string): ValidationResult {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    return { valid: false, error: 'Invalid URL format.', code: 'INVALID_URL' }
  }

  if (!['https:', 'http:'].includes(url.protocol)) {
    return { valid: false, error: 'Only HTTPS and HTTP URLs are supported.', code: 'INVALID_PROTOCOL' }
  }

  if (url.username || url.password) {
    return { valid: false, error: 'Links with embedded credentials are not supported.', code: 'INVALID_URL' }
  }

  if (urlString.length > 2048) {
    return { valid: false, error: 'This link is too long.', code: 'INVALID_URL' }
  }

  return { valid: true }
}

export function validateUploadedFile(file: {
  mimetype: string
  originalname: string
  size: number
  path: string
}): ValidationResult {
  const ext = path.extname(file.originalname).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { valid: false, error: `Unsupported file type "${ext}". Use MP4, MOV, WebM, MP3, M4A, or WAV.`, code: 'UNSUPPORTED_FILE' }
  }

  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return { valid: false, error: 'The file MIME type is not supported.', code: 'INVALID_MIME' }
  }

  if (file.size > config.limits.maxFileSizeBytes) {
    return { valid: false, error: `File exceeds the ${config.limits.maxFileSizeMB} MB limit.`, code: 'FILE_TOO_LARGE' }
  }

  if (file.size === 0) {
    return { valid: false, error: 'The uploaded file is empty.', code: 'EMPTY_FILE' }
  }

  return { valid: true }
}

export function validateArtworkFile(file: {
  mimetype: string
  originalname: string
  size: number
}): ValidationResult {
  const ext = path.extname(file.originalname).toLowerCase()
  if (!ALLOWED_ARTWORK_EXTENSIONS.has(ext)) {
    return { valid: false, error: 'Unsupported artwork format. Use JPG, PNG, or WebP.', code: 'UNSUPPORTED_ARTWORK' }
  }

  if (!ALLOWED_ARTWORK_MIMES.has(file.mimetype)) {
    return { valid: false, error: 'Invalid artwork MIME type.', code: 'INVALID_ARTWORK_MIME' }
  }

  if (file.size > MAX_ARTWORK_SIZE_BYTES) {
    return { valid: false, error: 'Artwork exceeds the 5 MB limit.', code: 'ARTWORK_TOO_LARGE' }
  }

  if (file.size === 0) {
    return { valid: false, error: 'Artwork file is empty.', code: 'EMPTY_FILE' }
  }

  return { valid: true }
}

export function validateQuality(quality: unknown): number {
  const q = typeof quality === 'number' ? quality : parseInt(String(quality), 10)
  if (!Number.isFinite(q) || !VALID_QUALITIES.has(q)) return 320
  return q
}

export function sanitizeMetadata(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 200).replace(/[<>"]/g, '')
}

export function sanitizeYear(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const str = String(value).trim()
  return /^\d{4}$/.test(str) ? str : ''
}

export function sanitizeTrackNumber(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const str = String(value).trim()
  return /^\d{1,3}(\/\d{1,3})?$/.test(str) ? str : ''
}

/**
 * Sanitize a track title into a safe MP3 download filename.
 * Removes invalid characters, strips common noise like "| Official Video",
 * prevents path traversal, and limits length.
 */
export function sanitizeFilename(rawTitle: string | undefined, fallbackId: string): string {
  if (!rawTitle || !rawTitle.trim()) {
    return `auraconvert-${fallbackId.slice(0, 8)}.mp3`
  }

  let cleaned = rawTitle
    .replace(/\s*\|\s*(official\s*(music\s*)?video|audio|lyrics?|hd|4k)\s*$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/^\.+|\.+$/g, '')

  if (!cleaned) {
    return `auraconvert-${fallbackId.slice(0, 8)}.mp3`
  }

  return `${cleaned}.mp3`
}

/**
 * Validate that a path is within an allowed directory (SSRF / path traversal prevention).
 */
export function isPathWithin(filePath: string, allowedDir: string): boolean {
  const resolved = path.resolve(filePath)
  const dir = path.resolve(allowedDir)
  return resolved.startsWith(dir + path.sep) || resolved === dir
}
