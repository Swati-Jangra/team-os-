# syntax=docker/dockerfile:1.7
# One Dockerfile, four runtime targets: api, worker, migrate, web.
#   docker build --target api    -t teamos-api .
#   docker build --target worker -t teamos-worker .
#   docker build --target migrate -t teamos-migrate .
#   docker build --target web --build-arg API_INTERNAL_URL=http://api:4000 -t teamos-web .
#
# NOTE: the steps below mirror what was verified by hand without Docker (pnpm build, `pnpm deploy --prod`,
# booting dist/main.js from the deployed folder, `next build` standalone output). The image build itself has
# not been executed in the authoring environment (no Docker daemon there); run it once in CI before relying on it.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# ---------- build: install everything, compile, then carve out production bundles ----------
FROM base AS build
# web's next.config.mjs bakes the API origin into its rewrites at build time
ARG API_INTERNAL_URL=http://api:4000
ENV API_URL=${API_INTERNAL_URL} NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @teamos/api deploy --prod --legacy /out/api \
 && pnpm --filter @teamos/worker deploy --prod --legacy /out/worker \
 && pnpm --filter @teamos/database deploy --prod --legacy /out/migrate \
 && rm -f /out/*/dump.rdb

# ---------- runtime base: non-root, no package manager caches ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
ENV API_PORT=4000 STORAGE_DIR=/data/storage
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
ENV WORKER_HTTP_PORT=4100 STORAGE_DIR=/data/storage
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HTTP_PORT||4100)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# one-shot: applies SQL migrations as the schema owner, then seeds system roles (both idempotent)
FROM runtime AS migrate
COPY --from=build --chown=node:node /out/migrate ./
USER node
CMD ["sh", "-c", "node dist/cli.js migrate && node dist/cli.js seed"]

FROM runtime AS web
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
