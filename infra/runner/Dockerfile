# Playwright runner image (Task 17, Ruling R32): what a worker needs to rerun generated tests.
#
# Each rerun gets a workspace <RUNNER_WORKSPACE_DIR>/<runId>/ (run.spec.ts, helpers.ts,
# run-data.json, playwright.config.js) whose node_modules links to RUNNER_NODE_MODULES_DIR, so the
# generated test resolves this pre-installed @playwright/test (same pin as the workspace's
# playwright-core) and nothing is installed per run. The worker runs the Playwright CLI from there in
# a child process with an allow-listed environment (only the run's SECRET_*, PATH and
# PLAYWRIGHT_BROWSERS_PATH) and kills its process group on abort (`ps`, from procps, finds a
# leftover browser).
#
# Use it as the base of the worker image:
#   docker build -f infra/runner/Dockerfile -t platform-runner .
#   docker build --build-arg BASE_IMAGE=platform-runner --target worker .
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    RUNNER_NODE_MODULES_DIR=/opt/runner/node_modules \
    RUNNER_WORKSPACE_DIR=/work/runs

WORKDIR /opt/runner
RUN npm init -y >/dev/null \
    && npm install --no-audit --no-fund --save-exact @playwright/test@1.56.1 \
    && npx playwright install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /work/runs \
    && chown -R node:node /ms-playwright /work/runs

WORKDIR /
