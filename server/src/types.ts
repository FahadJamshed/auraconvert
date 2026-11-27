export type JobStatus =
  | 'queued'
  | 'validating'
  | 'preparing'
  | 'processing'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type SourceType = 'upload' | 'url'

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
  sourceType: SourceType
  sourceUrl?: string
  uploadFilename?: string
  originalFilename?: string
  artworkFilename?: string
  quality: number
  progress: number
  error?: string
  outputFilename?: string
  downloadToken?: string
  downloadExpiresAt?: string
  duration?: number
  bitrate?: number
  fileSize?: number
  hasArtwork?: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateConversionRequest extends Mp3Metadata {
  sourceType: SourceType
  sourceUrl?: string
  uploadId?: string
  artworkId?: string
  quality?: number
}

export interface ConversionResponse extends Mp3Metadata {
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

export interface UploadResponse {
  uploadId: string
  filename: string
  size: number
  mimeType: string
}

export interface ApiError {
  error: string
  code: string
  details?: string
}
