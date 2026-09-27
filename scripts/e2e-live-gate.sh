#!/usr/bin/env bash
# Milestone E release gate: the live E2E suite (real model + Stagehand) green 3 times in a row.
# Needs the provider's API key — ANTHROPIC_API_KEY (LLM_PROVIDER unset, fake or anthropic), or
# LLM_PROVIDER=gemini with GEMINI_API_KEY; LLM_MODEL optional — and `pnpm infra:up`. Each run makes real,
# billed model calls.
set -euo pipefail
case "${LLM_PROVIDER:-fake}" in
  fake | anthropic) : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required for the live suite}" ;;
  gemini) : "${GEMINI_API_KEY:?GEMINI_API_KEY is required for the live suite with LLM_PROVIDER=gemini}" ;;
  *) printf 'LLM_PROVIDER must be anthropic or gemini for the live suite (unset or fake: anthropic), not %s\n' "$LLM_PROVIDER" >&2; exit 1 ;;
esac
for i in 1 2 3; do
  printf '\n\033[1m== live E2E run %s/3\033[0m\n' "$i"
  E2E_MODE=live pnpm exec vitest run --project e2e || { printf '\n\033[31mLIVE GATE FAILED on run %s\033[0m\n' "$i" >&2; exit 1; }
done
printf '\n\033[32mLIVE GATE PASSED: 3 consecutive green runs\033[0m\n'
