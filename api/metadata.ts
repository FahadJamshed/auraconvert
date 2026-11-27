import type { IncomingMessage, ServerResponse } from 'node:http'

const SUPPORTED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'vimeo.com',
  'www.vimeo.com',
  'soundcloud.com',
  'www.soundcloud.com',
])

function detectPlatform(host: string): 'YouTube' | 'Vimeo' | 'SoundCloud' {
  const clean = host.toLowerCase().replace(/^www\./, '')
  if (clean === 'youtu.be' || clean.endsWith('youtube.com')) return 'YouTube'
  if (clean.endsWith('vimeo.com')) return 'Vimeo'
  return 'SoundCloud'
}

function oembedUrl(platform: 'YouTube' | 'Vimeo' | 'SoundCloud', url: string): string {
  const encoded = encodeURIComponent(url)
  if (platform === 'YouTube') return `https://www.youtube.com/oembed?url=${encoded}&format=json`
  if (platform === 'Vimeo') return `https://vimeo.com/api/oembed.json?url=${encoded}`
  return `https://soundcloud.com/oembed?url=${encoded}&format=json`
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' })
  }

  try {
    const body = await readBody(req)
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : ''
    if (!rawUrl) {
      return sendJson(res, 400, { error: 'A media URL is required.', code: 'MISSING_URL' })
    }

    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return sendJson(res, 400, { error: 'Invalid URL format.', code: 'INVALID_URL' })
    }

    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return sendJson(res, 400, { error: 'Only HTTPS and HTTP URLs are supported.', code: 'INVALID_PROTOCOL' })
    }

    const host = parsed.hostname.toLowerCase()
    if (!SUPPORTED_HOSTS.has(host)) {
      return sendJson(res, 400, { error: 'This source is not supported. Use YouTube, Vimeo, or SoundCloud URLs.', code: 'UNSUPPORTED_SOURCE' })
    }

    const platform = detectPlatform(host)
    const endpoint = oembedUrl(platform, rawUrl)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)

    try {
      const upstream = await fetch(endpoint, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })

      if (upstream.status === 404 || upstream.status === 401 || upstream.status === 403) {
        return sendJson(res, 404, { error: 'This video is unavailable or private.', code: 'VIDEO_UNAVAILABLE' })
      }
      if (!upstream.ok) {
        return sendJson(res, 502, { error: 'Metadata is unavailable for this link.', code: 'METADATA_UNAVAILABLE' })
      }

      const data = (await upstream.json()) as {
        title?: string
        author_name?: string
        thumbnail_url?: string
        duration?: number
      }

      const title = typeof data.title === 'string' ? data.title.trim().slice(0, 200) : 'Untitled'
      const artist = typeof data.author_name === 'string' ? data.author_name.trim().slice(0, 200) : platform
      const duration = typeof data.duration === 'number' && Number.isFinite(data.duration) ? Math.round(data.duration) : undefined

      return sendJson(res, 200, {
        title,
        artist,
        thumbnailUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : undefined,
        duration,
        platform,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return sendJson(res, 502, { error: 'Could not retrieve video information. Please try again.', code: 'METADATA_ERROR' })
  }
}
