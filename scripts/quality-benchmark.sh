#!/usr/bin/env bash
# The quality benchmark against the compose stack (evals/benchmark/README.md): rebuilds and starts the stack, runs every
# case of evals/benchmark/corpus.json REPEAT times (default 1), and compares with the last results when there are some.
# Schedule it (cron, launchd or /schedule) for a nightly trend; it costs about $0.03 a run on deepseek-flash.
set -euo pipefail
cd "$(dirname "$0")/.."
REPEAT="${REPEAT:-1}"
pnpm stack:up
previous="$(ls -1d .artifacts/benchmark/*/results.json 2>/dev/null | tail -1 || true)"
pnpm benchmark --repeat "$REPEAT" --concurrency "${CONCURRENCY:-2}" ${previous:+--compare "$previous"} "$@"
