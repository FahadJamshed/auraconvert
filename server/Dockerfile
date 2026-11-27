# AuraConvert Worker — Docker image with FFmpeg
# Runs the BullMQ worker that processes conversion jobs.

FROM node:22-slim AS base

# Install FFmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production=false

# Build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Production stage
FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY --from=base /app/dist ./dist

# Create storage directories
RUN mkdir -p storage/uploads storage/outputs storage/temp

# Non-root user
RUN groupadd -r auraconvert && useradd -r -g auraconvert auraconvert && \
    chown -R auraconvert:auraconvert /app
USER auraconvert

ENV NODE_ENV=production

# Default to running the worker
CMD ["node", "dist/worker.js"]
