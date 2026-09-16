# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the TTS orchestration backend.
#
#   deps    — production node_modules only (cached by lockfile)
#   build   — full toolchain, typecheck + compile to dist/
#   runtime — alpine, non-root, dist + production deps, ~130 MB
#
# Build:  docker build -t learning-app-tts .
# Run:    docker run --rm -p 8080:8080 --env-file .env learning-app-tts

ARG NODE_VERSION=22-alpine

# ── deps ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ── build ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run typecheck && npm run build

# ── runtime ───────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps

RUN addgroup -S tts && adduser -S -G tts tts
COPY --from=deps --chown=tts:tts /app/node_modules ./node_modules
COPY --from=build --chown=tts:tts /app/dist ./dist
COPY --chown=tts:tts package.json ./

USER tts
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
