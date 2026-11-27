import { useState, useCallback, useRef, useEffect } from 'react'
import {
  uploadFile,
  uploadArtwork,
  createConversion,
  getConversionStatus,
  cancelConversion,
  getDownloadUrl,
  AuraConvertApiError,
  type JobStatus,
  type Mp3Metadata,
} from './api'

export type ConversionPhase =
  | 'idle'
  | 'uploading'
  | 'queued'
  | 'validating'
  | 'preparing'
  | 'processing'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ConversionState {
  phase: ConversionPhase
  progress: number
  uploadProgress: number
  error: string | null
  jobId: string | null
  downloadUrl: string | null
  downloadExpiresAt: string | null
  duration?: number
  bitrate?: number
  fileSize?: number
  hasArtwork?: boolean
  title?: string
  artist?: string
}

const POLL_INTERVAL_MS = 1500
const TERMINAL_STATES: Set<JobStatus> = new Set(['completed', 'failed', 'cancelled'])

export function useConversion() {
  const [state, setState] = useState<ConversionState>({
    phase: 'idle',
    progress: 0,
    uploadProgress: 0,
    error: null,
    jobId: null,
    downloadUrl: null,
    downloadExpiresAt: null,
  })

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef(false)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Clean up on unmount
  useEffect(() => () => stopPolling(), [stopPolling])

  const startPolling = useCallback((jobId: string) => {
    stopPolling()

    pollRef.current = setInterval(async () => {
      try {
        const job = await getConversionStatus(jobId)

        setState((prev) => {
          if (prev.jobId !== jobId) return prev

          const next: ConversionState = {
            ...prev,
            phase: job.status as ConversionPhase,
            progress: job.progress,
            error: job.error || null,
          }

          if (job.status === 'completed' && job.downloadUrl) {
            next.downloadUrl = getDownloadUrl(job.downloadUrl)
            next.downloadExpiresAt = job.downloadExpiresAt || null
            next.duration = job.duration
            next.bitrate = job.bitrate
            next.fileSize = job.fileSize
            next.hasArtwork = job.hasArtwork
            next.title = job.title
            next.artist = job.artist
          }

          return next
        })

        if (TERMINAL_STATES.has(job.status)) {
          stopPolling()
        }
      } catch (err) {
        // Don't stop polling on transient network errors
        console.warn('Polling error:', err)
      }
    }, POLL_INTERVAL_MS)
  }, [stopPolling])

  const reset = useCallback(() => {
    stopPolling()
    abortRef.current = true
    setState({
      phase: 'idle',
      progress: 0,
      uploadProgress: 0,
      error: null,
      jobId: null,
      downloadUrl: null,
      downloadExpiresAt: null,
    })
    // Allow new conversions after reset
    setTimeout(() => { abortRef.current = false }, 0)
  }, [stopPolling])

  /** Convert an uploaded file. */
  const convertFile = useCallback(async (
    file: File,
    options: { quality: number; artworkFile?: File | null } & Mp3Metadata
  ) => {
    abortRef.current = false
    stopPolling()

    setState({
      phase: 'uploading',
      progress: 0,
      uploadProgress: 0,
      error: null,
      jobId: null,
      downloadUrl: null,
      downloadExpiresAt: null,
    })

    try {
      // 1. Upload the media file (and optional artwork in parallel)
      const [upload, artwork] = await Promise.all([
        uploadFile(file, (percent) => {
          if (abortRef.current) return
          setState((prev) => ({ ...prev, uploadProgress: percent }))
        }),
        options.artworkFile ? uploadArtwork(options.artworkFile) : Promise.resolve(null),
      ])

      if (abortRef.current) return

      // 2. Create the conversion job
      const job = await createConversion({
        sourceType: 'upload',
        uploadId: upload.uploadId,
        artworkId: artwork?.artworkId,
        quality: options.quality,
        title: options.title,
        artist: options.artist,
        album: options.album,
        albumArtist: options.albumArtist,
        genre: options.genre,
        year: options.year,
        trackNumber: options.trackNumber,
      })

      if (abortRef.current) return

      setState((prev) => ({
        ...prev,
        phase: job.status as ConversionPhase,
        progress: job.progress,
        jobId: job.id,
        error: job.error || null,
      }))

      // 3. If not already terminal, start polling
      if (!TERMINAL_STATES.has(job.status)) {
        startPolling(job.id)
      } else if (job.status === 'completed' && job.downloadUrl) {
        setState((prev) => ({
          ...prev,
          downloadUrl: getDownloadUrl(job.downloadUrl!),
          downloadExpiresAt: job.downloadExpiresAt || null,
        }))
      }
    } catch (err) {
      if (abortRef.current) return

      const message = err instanceof AuraConvertApiError
        ? err.message
        : 'An unexpected error occurred. Please try again.'

      setState((prev) => ({
        ...prev,
        phase: 'failed',
        error: message,
      }))
    }
  }, [stopPolling, startPolling])

  /** Convert from URL (shows provider unavailable message). */
  const convertUrl = useCallback(async (
    url: string,
    options: { quality: number; title?: string; artist?: string }
  ) => {
    abortRef.current = false
    stopPolling()

    setState({
      phase: 'queued',
      progress: 0,
      uploadProgress: 0,
      error: null,
      jobId: null,
      downloadUrl: null,
      downloadExpiresAt: null,
    })

    try {
      const job = await createConversion({
        sourceType: 'url',
        sourceUrl: url,
        quality: options.quality,
        title: options.title,
        artist: options.artist,
      })

      setState({
        phase: job.status as ConversionPhase,
        progress: job.progress,
        uploadProgress: 0,
        error: job.error || null,
        jobId: job.id,
        downloadUrl: null,
        downloadExpiresAt: null,
      })
    } catch (err) {
      const message = err instanceof AuraConvertApiError
        ? err.message
        : 'An unexpected error occurred. Please try again.'

      setState((prev) => ({
        ...prev,
        phase: 'failed',
        error: message,
      }))
    }
  }, [stopPolling])

  /** Cancel an in-progress conversion. */
  const cancel = useCallback(async () => {
    if (!state.jobId) return

    try {
      await cancelConversion(state.jobId)
      stopPolling()
      setState((prev) => ({
        ...prev,
        phase: 'cancelled',
        error: 'Conversion was cancelled.',
      }))
    } catch (err) {
      const message = err instanceof AuraConvertApiError
        ? err.message
        : 'Could not cancel the conversion.'
      setState((prev) => ({
        ...prev,
        error: message,
      }))
    }
  }, [state.jobId, stopPolling])

  return {
    ...state,
    convertFile,
    convertUrl,
    cancel,
    reset,
    isActive: !['idle', 'completed', 'failed', 'cancelled'].includes(state.phase),
  }
}
