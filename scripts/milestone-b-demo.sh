#!/usr/bin/env bash
# Milestone B demo (Tasks 10-15): real requirement compiler -> criteria confirmation ->
# real planner -> Stagehand exploration through the sandbox -> deterministic blocking.
#
# Precondition: the compose stack must be running with the REAL engine, i.e.
#   LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY=sk-ant-... set before `docker compose up` /
#   `pnpm stack:up` (see infra/compose/.env or export them in your shell). LLM_MODEL is optional
#   (defaults to claude-sonnet-5). With the default LLM_PROVIDER=fake this script refuses to run,
#   because every run would be handled by the deterministic fake engine instead of the real one.
#
# Usage (compose stack running with a real provider): ./scripts/milestone-b-demo.sh
# Env: API (default http://localhost:3001), API_TOKEN, TARGET (default http://demo-shop:4000/)
set -euo pipefail
API=${API:-http://localhost:3001}
TOKEN=${API_TOKEN:-dev-api-token-change-me-please}
TARGET=${TARGET:-http://demo-shop:4000/}
COMPOSE="docker compose -f $(dirname "$0")/../infra/compose/docker-compose.yml"
H=(-H "authorization: Bearer $TOKEN" -H "content-type: application/json")

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }
create() { curl -sf "${H[@]}" -X POST "$API/v1/test-runs" -d "$1"; }
run_summary() { curl -sf "${H[@]}" "$API/v1/test-runs/$1"; }
lifecycle() { run_summary "$1" | json '[o.lifecycle,o.verdict??"",o.errorCategory??"",o.cancelReason??""].filter(Boolean).join(" / ")'; }
wait_for() { # runId, regex, timeout seconds
  for _ in $(seq 1 "$3"); do l=$(lifecycle "$1"); if [[ $l =~ $2 ]]; then echo "$l"; return 0; fi; sleep 1; done
  echo "timed out waiting for $2 (last: $l)"; return 1
}
stream_until_terminal() { # runId, max seconds
  curl -sN --max-time "$2" "${H[@]}" "$API/v1/test-runs/$1/events" | grep '^data:' | cut -c7- | node -e "
    require('readline').createInterface({input:process.stdin}).on('line',l=>{const e=JSON.parse(l);console.log(String(e.sequence).padStart(3),e.stage.padEnd(22),e.type.padEnd(20),e.message)})"
}

# --- Precondition: the worker must be on the real engine (LLM_PROVIDER != fake). --------------
# The API exposes no engine flag, so this checks the worker's own start-up log line
# ("using the fake test engine" vs "using the real test engine" — apps/worker/src/main.ts).
if ! curl -sf "$API/healthz" >/dev/null 2>&1; then
  echo "API is not reachable at $API — is the compose stack up? (pnpm stack:up)" >&2
  exit 1
fi
if $COMPOSE logs worker 2>&1 | tail -100 | grep -q "using the fake test engine"; then
  cat >&2 <<'EOF'
The worker is running the fake engine (LLM_PROVIDER=fake, the compose default).
This demo needs the real engine: restart the stack with a real provider, e.g.

  LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... docker compose -f infra/compose/docker-compose.yml up -d --wait worker

then re-run this script.
EOF
  exit 1
fi
if ! $COMPOSE logs worker 2>&1 | tail -100 | grep -q "using the real test engine"; then
  echo "Could not confirm the worker is on the real engine (no start-up log line found); restart the worker and retry." >&2
  exit 1
fi
echo "worker is on the real engine (LLM_PROVIDER=anthropic)."

say "1. Requirement -> criteria -> manual confirmation -> plan -> Stagehand exploration -> report"
BODY1=$(printf '{"targetUrl":"%s","requirement":"Search for iPhone 17 Pro, add it to the cart, and the cart count should increase by 1.","options":{"autoConfirmCriteria":false}}' "$TARGET")
RUN1=$(create "$BODY1" | json 'o.runId')
echo "runId: $RUN1"
wait_for "$RUN1" "AWAITING_CONFIRMATION" 150

say "GET /v1/test-runs/$RUN1/criteria"
curl -sf "${H[@]}" "$API/v1/test-runs/$RUN1/criteria" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s),null,2)))"

say "POST /v1/test-runs/$RUN1/criteria/confirm"
curl -sf "${H[@]}" -X POST "$API/v1/test-runs/$RUN1/criteria/confirm" | json 'JSON.stringify(o)'

say "Streaming events until the run reaches a terminal state (this drives the real planner + Stagehand explorer inside the sandbox; may take a few minutes)"
stream_until_terminal "$RUN1" 600
echo "summary: $(lifecycle "$RUN1")"

say "2. Requirement that needs a secret we never provide -> expect BLOCKED / MISSING_SECRET"
# The demo shop's login form (qa@demo.test / demo-pass-123) needs a "password" secret; the planner
# names that secret's inputRef even when unresolved (packages/testing-engine/src/planner/prompts.ts),
# and with no secrets supplied at all, packages/testing-engine/src/planner/blocking.ts always blocks
# whatever criterion depends on that fill step, deterministically, as MISSING_SECRET.
BODY2=$(printf '{"targetUrl":"%s","requirement":"A logged-in customer can see their account email on the account page after signing in as qa@demo.test.","secrets":{},"options":{"autoConfirmCriteria":true}}' "${TARGET%/}/login")
RUN2=$(create "$BODY2" | json 'o.runId')
echo "runId: $RUN2"
wait_for "$RUN2" "(COMPLETED|ERRORED|CANCELLED)" 240
echo "summary: $(lifecycle "$RUN2")"
echo "(planner blocking is deterministic once the plan names an unprovided secret's inputRef — see packages/testing-engine/src/planner/blocking.ts; expected: run verdict BLOCKED, with a plan.created/criterion.evaluated event carrying reason MISSING_SECRET)"
curl -sN --max-time 30 "${H[@]}" "$API/v1/test-runs/$RUN2/events" | grep -o '"reason":"[A-Z_]*"' | sort -u || true

say "3. Requirement that asks to delete the account -> expect BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED"
# The demo shop's /account page has a real "Delete account" button (data-testid=delete-account,
# tests/fixtures/demo-shop/src/server.js) that never actually deletes anything server-side — it
# exists purely to be blocked. packages/security/src/action-policy.ts's DESTRUCTIVE_TERMS match
# "delete" in the planned step's instruction/element text regardless of the model's own opinion
# (options.allowDestructiveActions defaults to false), so this blocks deterministically.
BODY3=$(printf '{"targetUrl":"%s","requirement":"After logging in as qa@demo.test, verify that clicking the Delete account button removes the account.","secrets":{"password":"demo-pass-123"},"options":{"autoConfirmCriteria":true}}' "${TARGET%/}/account")
RUN3=$(create "$BODY3" | json 'o.runId')
echo "runId: $RUN3"
wait_for "$RUN3" "(COMPLETED|ERRORED|CANCELLED)" 240
echo "summary: $(lifecycle "$RUN3")"
echo "(destructive-action blocking is a deterministic word match against the planned step's instruction/element text — packages/security/src/action-policy.ts DESTRUCTIVE_TERMS; expected: run verdict BLOCKED, reason DESTRUCTIVE_ACTION_NOT_AUTHORIZED)"
curl -sN --max-time 30 "${H[@]}" "$API/v1/test-runs/$RUN3/events" | grep -o '"reason":"[A-Z_]*"' | sort -u || true

say "History (newest first)"
curl -sf "${H[@]}" "$API/v1/test-runs?limit=5" | json 'o.items.map(i=>i.runId+"  "+i.lifecycle+(i.verdict?" "+i.verdict:"")+(i.errorCategory?" "+i.errorCategory:"")).join("\n")'
