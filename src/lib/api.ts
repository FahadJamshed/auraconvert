/**
 * AuraConvert API Client
 *
 * Communicates with the AuraConvert backend for file uploads,
 * conversion jobs, and status polling.
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export type JobStatus =
  | 'queued'
  | 'validating'
  | 'preparing'
  | 'processing'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface Mp3Metadata {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  genre?: string
  year?: string
  trackNumber?: string
}

export interface ConversionJob extends Mp3Metadata {
  id: string
  status: JobStatus
  progress: number
  error?: string
  downloadUrl?: string
  downloadExpiresAt?: string
  duration?: number
  bitrate?: number
  fileSize?: number
  hasArtwork?: boolean
  createdAt: string
  updatedAt: string
}

export interface ArtworkUploadResult {
  artworkId: string
  filename: string
  size: number
  mimeType: string
}

export interface UploadResult {
  uploadId: string
  filename: string
  size: number
  mimeType: string
}

export interface ApiError {
  error: string
  code: string
}

class AuraConvertApiError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'AuraConvertApiError'
    this.code = code
    this.status = status
  }
}

async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        ...options?.headers,
      },
    })
  } catch {
    throw new AuraConvertApiError(
      'Could not reach the conversion server. Please check your connection and try again.',
      'NETWORK_ERROR',
      0
    )
  }

  if (!res.ok) {
    let body: ApiError | undefined
    try {
      body = await res.json() as ApiError
    } catch {
      // Response is not JSON
    }

    throw new AuraConvertApiError(
      body?.error || `Request failed (${res.status}).`,
      body?.code || 'UNKNOWN_ERROR',
      res.status
    )
  }

  return res.json() as Promise<T>
}

/** Upload an authorized media file. */
export async function uploadFile(
  file: File,
  onProgress?: (percent: number) => void
): Promise<UploadResult> {
  const formData = new FormData()
  formData.append('file', file)

  // Use XMLHttpRequest for upload progress
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/api/uploads`)

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress?.(Math.round((e.loaded / e.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult)
        } catch {
          reject(new AuraConvertApiError('Invalid response from server.', 'PARSE_ERROR', xhr.status))
        }
      } else {
        let body: ApiError | undefined
        try { body = JSON.parse(xhr.responseText) } catch { /* ignore */ }
        reject(new AuraConvertApiError(
          body?.error || `Upload failed (${xhr.status}).`,
          body?.code || 'UPLOAD_FAILED',
          xhr.status
        ))
      }
    })

    xhr.addEventListener('error', () => {
      reject(new AuraConvertApiError(
        'Could not reach the conversion server. Please check your connection.',
        'NETWORK_ERROR',
        0
      ))
    })

    xhr.addEventListener('abort', () => {
      reject(new AuraConvertApiError('Upload was cancelled.', 'UPLOAD_CANCELLED', 0))
    })

    xhr.send(formData)
  })
}

/** Upload cover artwork (JPG, PNG, WebP, max 5 MB). */
export async function uploadArtwork(file: File): Promise<ArtworkUploadResult> {
  const formData = new FormData()
  formData.append('artwork', file)
  return request<ArtworkUploadResult>('/api/artwork', {
    method: 'POST',
    body: formData,
  })
}

/** Create a conversion job from an uploaded file. */
export async function createConversion(params: {
  sourceType: 'upload' | 'url'
  uploadId?: string
  artworkId?: string
  sourceUrl?: string
  quality: number
} & Mp3Metadata): Promise<ConversionJob> {
  return request<ConversionJob>('/api/conversions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
}

/** Get the current status of a conversion job. */
export async function getConversionStatus(id: string): Promise<ConversionJob> {
  return request<ConversionJob>(`/api/conversions/${id}`)
}

/** Cancel a conversion job. */
export async function cancelConversion(id: string): Promise<ConversionJob> {
  return request<ConversionJob>(`/api/conversions/${id}/cancel`, {
    method: 'POST',
  })
}

/** Get the download URL for a completed conversion. */
export function getDownloadUrl(downloadPath: string): string {
  return `${API_BASE}${downloadPath}`
}

export interface VideoMetadataResult {
  title: string
  artist: string
  thumbnailUrl?: string
  duration?: number
  platform: 'YouTube' | 'Vimeo' | 'SoundCloud'
}

/** Fetch permitted metadata for a supported video URL. */
export async function fetchVideoMetadata(url: string): Promise<VideoMetadataResult> {
  return request<VideoMetadataResult>('/api/metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
}

/** Check API health status. */
export async function checkHealth(): Promise<{ status: string; redis: string }> {
  return request('/api/health')
}

export { AuraConvertApiError }
