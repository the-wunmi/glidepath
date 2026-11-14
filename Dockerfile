# syntax=docker/dockerfile:1.7
# One file, two images: `--target api` and `--target web`. docker-compose.yml builds both.

# Pinned to a digest so a rebuilt tag cannot change what runs. Bump deliberately.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# ── Shared: pnpm, and every dependency fetched once from the lockfile ─────────────────────────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN corepack install
RUN --mount=type=cache,id=glidepath-pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

# ── API: TypeScript run by tsx, production dependencies only ─────────────────────────────────
# A lockfile and manifests cut down to the API and the workspace packages it imports, so the
# install below can't pull in the web app's dependencies.
FROM fetch AS api-prune
COPY . .
RUN pnpm dlx turbo@2.11.10 prune @glidepath/api --docker

FROM fetch AS api-deps
COPY --from=api-prune /app/out/json/ ./
COPY --from=api-prune /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
# pnpm fetch leaves every package of the full lockfile in node_modules/.pnpm; start clean so only
# the API's production dependencies remain.
RUN --mount=type=cache,id=glidepath-pnpm-store,target=/pnpm/store \
    rm -rf node_modules && pnpm install --frozen-lockfile --prefer-offline --prod

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-deps --chown=root:root /app ./
COPY --chown=root:root tsconfig.base.json ./
# Unchanged sources: the simulated enclave measures packages/{enclave,planner,core}/src, and the
# registry pins that measurement.
COPY --chown=root:root packages ./packages
COPY --chown=root:root apps/api ./apps/api
# Prebuilt contract wasm (deployed only on a local network, but read by the engine), the replay
# study and the demo's real case, and the testnet registry the API connects to.
COPY --chown=root:root contracts/res ./contracts/res
COPY --chown=root:root data ./data
COPY --chown=root:root deployments ./deployments
# The one writable directory (a volume): the simulated enclave's hardware secret and the 1Click
# simulator's quote key. Everything else stays root-owned and read-only to the process.
RUN mkdir /data && chown node:node /data
WORKDIR /app/apps/api
ENV PATH=/app/apps/api/node_modules/.bin:$PATH \
    DATA_DIR=/data \
    API_HOST=0.0.0.0 \
    API_PORT=4400
USER node
EXPOSE 4400
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4400/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The server runs the (idempotent) migrations itself before it takes traffic.
CMD ["tsx", "src/server.ts"]

# ── Web: Next.js standalone build ────────────────────────────────────────────────────────────
FROM fetch AS web-build
COPY . .
RUN --mount=type=cache,id=glidepath-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@glidepath/web..." --filter verified-glidepath
# The API's address from the web container; Next fixes its rewrites at build time. Not secret.
ARG GLIDEPATH_API_ORIGIN=http://api:4400
ENV GLIDEPATH_API_ORIGIN=$GLIDEPATH_API_ORIGIN
RUN pnpm exec turbo run build --filter=@glidepath/web

FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3400
WORKDIR /app
COPY --from=web-build --chown=root:root /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=root:root /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3400
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3400/how-it-works').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
