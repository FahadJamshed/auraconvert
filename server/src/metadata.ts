import { sanitizeMetadata, validateUrl } from './validation.js'

export interface VideoMetadata {
  title: string
  artist: string
  thumbnailUrl?: string
  duration?: number
  platform: 'YouTube' | 'Vimeo' | 'SoundCloud'
}

function detectPlatform(url: URL): 'YouTube' | 'Vimeo' | 'SoundCloud' {
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'youtu.be' || host.endsWith('youtube.com')) return 'YouTube'
  if (host.endsWith('vimeo.com')) return 'Vimeo'
  return 'SoundCloud'
}

function oembedEndpoint(platform: 'YouTube' | 'Vimeo' | 'SoundCloud', targetUrl: string): string {
  const encoded = encodeURIComponent(targetUrl)
  switch (platform) {
    case 'YouTube':
      return `https://www.youtube.com/oembed?url=${encoded}&format=json`
    case 'Vimeo':
      return `https://vimeo.com/api/oembed.json?url=${encoded}`
    case 'SoundCloud':
      return `https://soundcloud.com/oembed?url=${encoded}&format=json`
  }
}

/**
 * Fetch permitted public metadata via official oEmbed endpoints.
 * Does not bypass DRM, authentication, or platform protections.
 */
export async function fetchVideoMetadata(rawUrl: string): Promise<VideoMetadata> {
  const check = validateUrl(rawUrl)
  if (!check.valid) {
    throw new Error(check.error || 'Invalid URL.')
  }

  const parsed = new URL(rawUrl)
  const platform = detectPlatform(parsed)
  const endpoint = oembedEndpoint(platform, rawUrl)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })

    if (res.status === 404 || res.status === 401 || res.status === 403) {
      throw new Error('VIDEO_UNAVAILABLE')
    }
    if (!res.ok) {
      throw new Error('METADATA_UNAVAILABLE')
    }

    const data = (await res.json()) as {
      title?: string
      author_name?: string
      thumbnail_url?: string
      duration?: number
    }

    const title = sanitizeMetadata(data.title)
    const artist = sanitizeMetadata(data.author_name)

    if (!title && !artist) {
      throw new Error('METADATA_UNAVAILABLE')
    }

    let thumbnailUrl: string | undefined
    if (typeof data.thumbnail_url === 'string') {
      try {
        const thumb = new URL(data.thumbnail_url)
        if (thumb.protocol === 'https:' || thumb.protocol === 'http:') {
          thumbnailUrl = thumb.toString()
        }
      } catch {
        // Ignore invalid thumbnail URL
      }
    }

    const duration = typeof data.duration === 'number' && Number.isFinite(data.duration)
      ? Math.round(data.duration)
      : undefined

    return {
      title: title || 'Untitled',
      artist: artist || platform,
      thumbnailUrl,
      duration,
      platform,
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('METADATA_TIMEOUT')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
