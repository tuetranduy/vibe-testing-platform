# One image recipe for api, worker, and web (select with --target).
ARG BASE_IMAGE=node:22-bookworm-slim

FROM ${BASE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_HOME=/usr/local/share/corepack \
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
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "--filter", "@platform/api", "start"]

FROM source AS worker
# Real engine (Ruling R7/R23): Playwright's Chromium, matching the workspace's playwright-core
# pin, plus its OS deps, in a fixed path readable by the node user the container runs as.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @platform/worker exec playwright-core install --with-deps chromium \
    && chown -R node:node /ms-playwright
# Playwright rerun (Task 17, Ruling R32): per-run workspaces live here; each links node_modules to the
# @playwright/test that testing-engine depends on (infra/runner/Dockerfile: a pre-installed runner base).
# procps: `ps` finds a browser left behind by a killed runner.
ENV RUNNER_WORKSPACE_DIR=/work/runs
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /work/runs && chown node:node /work/runs
USER node
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD node -e "process.exit(Date.now()-require('fs').statSync('/tmp/worker-alive').mtimeMs<30000?0:1)"
CMD ["pnpm", "--filter", "@platform/worker", "start"]

# The Playwright runner service (KI-029): the worker image (same @playwright/test, Chromium and paths, so a
# workspace's node_modules link resolves the same here), running only the runner server. In compose it is on an
# internal network with the workers: no route to the database, Redis, object storage or the internet.
FROM worker AS runner
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RUNNER_PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "--filter", "@platform/worker", "runner"]

FROM source AS migrate
USER node
CMD ["pnpm", "--filter", "@platform/db", "migrate"]

FROM source AS web
RUN pnpm --filter @platform/web build && chown -R node:node apps/web/.next
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["pnpm", "--filter", "@platform/web", "start"]
