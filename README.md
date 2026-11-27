# AuraConvert

Convert authorized media into MP3 audio, customize ID3v2.3 metadata, embed cover artwork, and download cleanly organized audio files.

## Architecture

```
Frontend (React + Vite)
  → Express API (server/src/index.ts, server/src/routes.ts)
  → Validation & Sanitization (server/src/validation.ts)
  → Redis Job Store & BullMQ Queue (server/src/job-store.ts, server/src/queue.ts)
  → Dedicated Worker (server/src/worker.ts)
  → FFmpeg / FFprobe (server/src/ffmpeg.ts)
  → Temporary Storage & Expiring Downloads (server/src/storage.ts)
```

## API Endpoints

- `POST /api/uploads` — Upload authorized media (`MP4`, `MOV`, `WebM`, `MP3`, `M4A`, `WAV`, max 100 MB). Returns `uploadId`.
- `POST /api/artwork` — Upload cover artwork (`JPG`, `PNG`, `WebP`, max 5 MB). Returns `artworkId`.
- `POST /api/conversions` — Validate input and enqueue a conversion job (`queued` → `validating` → `preparing` → `processing` → `finalizing` → `completed` / `failed` / `cancelled`).
- `GET /api/conversions/:id` — Poll job status, progress, metadata, and download URL.
- `POST /api/conversions/:id/cancel` — Cancel a queued or active job and clean up temporary files.
- `GET /api/downloads/:token` — Stream the generated MP3 with sanitized `Content-Disposition` filename and expiring token check.
- `GET /api/health` — Health check for API and Redis connectivity.

## Environment Variables

### Frontend
- `VITE_API_URL` — Base URL of the backend API (default: `http://localhost:3001`).

### Backend (`server/.env`)
- `PORT` — API server port (default: `3001`)
- `NODE_ENV` — `development` or `production`
- `CORS_ORIGIN` — Allowed frontend origin (default: `http://localhost:8443`)
- `REDIS_URL` — Redis connection string (default: `redis://localhost:6379`)
- `UPLOAD_DIR`, `OUTPUT_DIR`, `TEMP_DIR` — Temporary storage paths
- `MAX_FILE_SIZE_MB` — Max upload size in MB (default: `100`)
- `MAX_CONCURRENT_JOBS` — Worker concurrency (default: `5`)
- `JOB_TIMEOUT_SECONDS` — FFmpeg timeout per job (default: `300`)
- `DOWNLOAD_EXPIRY_SECONDS` — Download token & file retention TTL (default: `3600`)
- `FFMPEG_PATH` — Path to `ffmpeg` binary (default: `ffmpeg`)
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS` — API rate limiting

## Local Development

### 1. Frontend
```bash
pnpm install
pnpm dev
```

### 2. Backend + Redis + Worker (Docker Compose)
```bash
cd server
docker compose up --build
```
Or run locally with Redis and FFmpeg installed:
```bash
cd server
cp .env.example .env
npm install
npm run dev        # API server
npm run dev:worker # Processing worker
```

## Deployment

- **Frontend (Vercel)**: Deploy the root Vite project (`pnpm build` → `dist/`). Set `VITE_API_URL` to your deployed API URL.
- **API & Worker**: Deploy `server/Dockerfile.api` and `server/Dockerfile` (which includes FFmpeg) to a container platform (e.g., Railway, Fly.io, Render, or ECS) with a shared volume for `/app/storage` and a managed Redis instance.

## Security Controls

- Argument-based `spawn()` for FFmpeg/FFprobe (no shell string concatenation).
- Path traversal prevention (`isPathWithin`) on all file operations.
- Randomized filenames (`nanoid`) and sanitized download filenames.
- Strict MIME/extension/size validation for media and artwork uploads.
- Rate limiting on `/api/*`, CORS origin restriction, and no exposed stack traces.
- Automatic periodic cleanup of expired uploads, temp files, and outputs.
