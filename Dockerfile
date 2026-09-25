# One image recipe for api, worker, and web (select with --target).
ARG BASE_IMAGE=node:22-bookworm-slim

FROM ${BASE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# Dependencies only depend on the lockfile, so this layer is cached across source changes.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

FROM deps AS source
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile

FROM source AS api
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "--filter", "@platform/api", "start"]

FROM source AS worker
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD node -e "process.exit(Date.now()-require('fs').statSync('/tmp/worker-alive').mtimeMs<30000?0:1)"
CMD ["pnpm", "--filter", "@platform/worker", "start"]

FROM source AS migrate
CMD ["pnpm", "--filter", "@platform/db", "migrate"]

FROM source AS web
RUN pnpm --filter @platform/web build
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "--filter", "@platform/web", "start"]
