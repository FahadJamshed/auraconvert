import type { IncomingMessage, ServerResponse } from 'node:http'

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

const STREAMING_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'soundcloud.com', 'spotify.com', 'tiktok.com', 'instagram.com', 'facebook.com', 'dailymotion.com', 'twitch.tv']

function isStreamingPlatform(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return STREAMING_HOSTS.some(h => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' })
  }

  try {
    const body = await readBody(req)
    if (body.sourceType === 'url' && typeof body.sourceUrl === 'string' && isStreamingPlatform(body.sourceUrl)) {
      return sendJson(res, 400, {
        error: 'Streaming platform links (YouTube, Vimeo, SoundCloud, etc.) are not supported. Use a direct link to a media file you own, or upload the file.',
        code: 'UNSUPPORTED_SOURCE',
      })
    }

    return sendJson(res, 503, {
      error: 'The file conversion worker is not connected in this deployment. Please run the backend worker with Redis and FFmpeg.',
      code: 'WORKER_UNAVAILABLE',
    })
  } catch {
    return sendJson(res, 400, { error: 'Invalid request body.', code: 'INVALID_REQUEST' })
  }
}
