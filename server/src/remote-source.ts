import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { config } from './config.js'
import { ALLOWED_EXTENSIONS } from './validation.js'

/**
 * Direct media URL adapter.
 *
 * Fetches a media file the user is authorized to convert from a direct file
 * URL (their own server, S3/R2 bucket, CDN, etc.). Streaming platforms are
 * intentionally not supported — see STREAMING_PLATFORM_HOSTS.
 *
 * Hardened against SSRF: every DNS resolution (including redirects) is checked
 * and private, loopback, link-local and reserved addresses are refused.
 */

const MAX_REDIRECTS = 3
const CONNECT_TIMEOUT_MS = 15_000

const ALLOWED_CONTENT_TYPE = /^(audio|video)\/|^application\/octet-stream$|^binary\/octet-stream$/i

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
}

export class RemoteSourceError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'RemoteSourceError'
    this.code = code
  }
}

/** True for addresses that must never be fetched by the server. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) ||           // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224                              // multicast + reserved
    )
  }
  if (family === 6) {
    const v6 = address.toLowerCase()
    if (v6 === '::' || v6 === '::1') return true
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isBlockedAddress(mapped[1])
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6)
  }
  return true
}

/** DNS lookup that refuses blocked addresses, so the connection is pinned to a vetted IP. */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0)
    const list = addresses as dns.LookupAddress[]
    const safe = list.find(a => !isBlockedAddress(a.address))
    if (!safe || list.some(a => isBlockedAddress(a.address))) {
      return callback(new RemoteSourceError('This link points to a private or internal address.', 'BLOCKED_ADDRESS'), '', 0)
    }
    if ((options as dns.LookupOptions).all) {
      return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, [safe])
    }
    callback(null, safe.address, safe.family)
  })
}

function extFromUrl(url: URL): string {
  return path.extname(decodeURIComponent(url.pathname)).toLowerCase()
}

/** Best-effort track title from the URL's file name. */
export function titleFromUrl(urlString: string): string {
  try {
    const base = path.basename(decodeURIComponent(new URL(urlString).pathname))
    return base.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200)
  } catch {
    return ''
  }
}

function request(url: URL, signal: AbortSignal): Promise<http.IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = client.get(url, {
      lookup: safeLookup,
      signal,
      timeout: CONNECT_TIMEOUT_MS,
      headers: { 'User-Agent': 'AuraConvert/1.0', Accept: 'audio/*, video/*;q=0.9, */*;q=0.1' },
    }, resolve)
    req.on('timeout', () => req.destroy(new RemoteSourceError('The link took too long to respond.', 'SOURCE_TIMEOUT')))
    req.on('error', reject)
  })
}

export interface DownloadResult {
  filePath: string
  size: number
}

/**
 * Download a direct media URL into `destDir`. Returns the saved file path.
 * Enforces protocol, SSRF, content-type, extension and size limits.
 */
export async function downloadDirectMedia(
  sourceUrl: string,
  destDir: string,
  baseName: string,
  onProgress?: (percent: number) => void,
): Promise<DownloadResult> {
  const maxBytes = config.limits.maxFileSizeBytes
  const controller = new AbortController()
  const overall = setTimeout(() => controller.abort(), config.limits.jobTimeoutSeconds * 1000)

  try {
    let current = new URL(sourceUrl)
    let res: http.IncomingMessage | null = null

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!['http:', 'https:'].includes(current.protocol)) {
        throw new RemoteSourceError('Only HTTP and HTTPS links are supported.', 'INVALID_PROTOCOL')
      }
      if (isStreamingPlatform(current.hostname)) {
        throw new RemoteSourceError(STREAMING_PLATFORM_MESSAGE, 'UNSUPPORTED_SOURCE')
      }
      // Node skips the custom lookup for IP literals, so vet them here.
      const literal = current.hostname.replace(/^\[|\]$/g, '')
      if (net.isIP(literal) && isBlockedAddress(literal)) {
        throw new RemoteSourceError('This link points to a private or internal address.', 'BLOCKED_ADDRESS')
      }

      try {
        res = await request(current, controller.signal)
      } catch (err) {
        if (err instanceof RemoteSourceError) throw err
        throw new RemoteSourceError('Could not reach this link. Check that it is public and try again.', 'SOURCE_UNREACHABLE')
      }

      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        current = new URL(res.headers.location, current)
        res = null
        continue
      }
      break
    }

    if (!res) throw new RemoteSourceError('Too many redirects.', 'TOO_MANY_REDIRECTS')

    const status = res.statusCode ?? 0
    if (status === 401 || status === 403) {
      res.resume()
      throw new RemoteSourceError('This link is private. Make the file publicly accessible or upload it instead.', 'SOURCE_FORBIDDEN')
    }
    if (status === 404) {
      res.resume()
      throw new RemoteSourceError('No file was found at this link.', 'SOURCE_NOT_FOUND')
    }
    if (status < 200 || status >= 300) {
      res.resume()
      throw new RemoteSourceError(`The link responded with an error (${status}).`, 'SOURCE_ERROR')
    }

    const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (contentType && !ALLOWED_CONTENT_TYPE.test(contentType)) {
      res.resume()
      throw new RemoteSourceError(
        contentType.startsWith('text/html')
          ? 'This link opens a web page, not a media file. Use a direct link to an MP4, MOV, WebM, MP3, M4A or WAV file.'
          : 'This link does not point to an audio or video file.',
        'NOT_MEDIA',
      )
    }

    let ext = extFromUrl(current)
    if (!ALLOWED_EXTENSIONS.has(ext)) ext = EXT_BY_CONTENT_TYPE[contentType] || ''
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      res.resume()
      throw new RemoteSourceError('Unsupported file type. Use a link to an MP4, MOV, WebM, MP3, M4A or WAV file.', 'UNSUPPORTED_FILE')
    }

    const declared = Number(res.headers['content-length'] || 0)
    if (declared > maxBytes) {
      res.resume()
      throw new RemoteSourceError(`The file exceeds the ${config.limits.maxFileSizeMB} MB limit.`, 'FILE_TOO_LARGE')
    }

    const filePath = path.join(destDir, `${path.basename(baseName)}${ext}`)
    let received = 0
    let lastReported = -1

    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length
        if (received > maxBytes) {
          cb(new RemoteSourceError(`The file exceeds the ${config.limits.maxFileSizeMB} MB limit.`, 'FILE_TOO_LARGE'))
          return
        }
        if (declared && onProgress) {
          const pct = Math.floor((received / declared) * 100)
          if (pct >= lastReported + 5) { lastReported = pct; onProgress(pct) }
        }
        cb(null, chunk)
      },
    })

    try {
      await pipeline(res, limiter, fs.createWriteStream(filePath, { flags: 'wx' }))
    } catch (err) {
      fs.rmSync(filePath, { force: true })
      if (err instanceof RemoteSourceError) throw err
      if (controller.signal.aborted) throw new RemoteSourceError('Downloading the file took too long.', 'SOURCE_TIMEOUT')
      throw new RemoteSourceError('The download was interrupted. Please try again.', 'DOWNLOAD_INTERRUPTED')
    }

    if (received === 0) {
      fs.rmSync(filePath, { force: true })
      throw new RemoteSourceError('The linked file is empty.', 'EMPTY_FILE')
    }

    return { filePath, size: received }
  } finally {
    clearTimeout(overall)
  }
}

/** Streaming platforms whose content cannot be downloaded without their authorization. */
export const STREAMING_PLATFORM_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com',
  'vimeo.com', 'soundcloud.com', 'spotify.com', 'music.apple.com',
  'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com',
  'dailymotion.com', 'twitch.tv',
]

export const STREAMING_PLATFORM_MESSAGE =
  'Streaming platform links (YouTube, Vimeo, SoundCloud, etc.) are not supported. Use a direct link to a media file you own, or upload the file.'

export function isStreamingPlatform(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return STREAMING_PLATFORM_HOSTS.some(h => host === h || host.endsWith(`.${h}`))
}
