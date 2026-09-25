#!/usr/bin/env bash
# Milestone A demo (Tasks 0–9): full lifecycle with the fake engine via API + SSE, cancel, crash recovery.
# Usage (compose stack running):  ./scripts/milestone-a-demo.sh
# Env: API (default http://localhost:3001), API_TOKEN, TARGET (default http://demo-shop:4000/),
#      KILL_WORKER / START_WORKER (commands used for the crash-recovery step; set SKIP_CRASH=1 to skip).
set -euo pipefail
API=${API:-http://localhost:3001}
TOKEN=${API_TOKEN:-dev-api-token-change-me-please}
TARGET=${TARGET:-http://demo-shop:4000/}
COMPOSE="docker compose -f $(dirname "$0")/../infra/compose/docker-compose.yml"
KILL_WORKER=${KILL_WORKER:-"$COMPOSE kill worker"}
START_WORKER=${START_WORKER:-"$COMPOSE start worker"}
H=(-H "authorization: Bearer $TOKEN" -H "content-type: application/json")

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }
create() { curl -sf "${H[@]}" -X POST "$API/v1/test-runs" -d "$1" | json 'o.runId'; }
lifecycle() { curl -sf "${H[@]}" "$API/v1/test-runs/$1" | json '[o.lifecycle,o.verdict??"",o.errorCategory??"",o.cancelReason??""].filter(Boolean).join(" / ")'; }
wait_for() { # runId, regex, timeout seconds
  for _ in $(seq 1 "$3"); do l=$(lifecycle "$1"); if [[ $l =~ $2 ]]; then echo "$l"; return 0; fi; sleep 1; done
  echo "timed out waiting for $2 (last: $l)"; return 1
}
body() { printf '{"targetUrl":"%s","requirement":"Verify that a user can search for an iPhone, add it to the cart, and see the selected product in the cart.","secrets":{"password":"demo-pass-123"},"options":{"autoConfirmCriteria":%s}}' "$TARGET" "$1"; }

say "1. Auto-confirmed run → fake engine → COMPLETED (SSE replay)"
RUN=$(create "$(body true)")
echo "runId: $RUN"
curl -sN --max-time 60 "${H[@]}" "$API/v1/test-runs/$RUN/events" | grep '^data:' | cut -c7- | json_lines=1 node -e "
  require('readline').createInterface({input:process.stdin}).on('line',l=>{const e=JSON.parse(l);console.log(String(e.sequence).padStart(3),e.stage.padEnd(22),e.type.padEnd(20),e.message)})"
echo "summary: $(lifecycle "$RUN")"

say "2. SSE reconnect with Last-Event-ID: 20 replays only later events, then closes"
curl -sN --max-time 10 "${H[@]}" -H "last-event-id: 20" "$API/v1/test-runs/$RUN/events" | grep -c '^id:' | xargs echo "events after #20:"

say "3. Run awaiting confirmation → cancel → CANCELLED immediately"
RUN2=$(create "$(body false)")
wait_for "$RUN2" "AWAITING_CONFIRMATION" 30
curl -sf "${H[@]}" -X POST "$API/v1/test-runs/$RUN2/cancel" | json 'o.lifecycle+" / "+o.cancelReason'

say "4. Cancel during EXPLORING → CANCELLED within seconds"
RUN3=$(create "$(body true)")
wait_for "$RUN3" "EXPLORING" 30
curl -sf "${H[@]}" -X POST "$API/v1/test-runs/$RUN3/cancel" >/dev/null
wait_for "$RUN3" "CANCELLED" 15

say "5. Guards: private target → 422, bad token → 401"
curl -s -o /dev/null -w "http://169.254.169.254 → %{http_code}\n" "${H[@]}" -X POST "$API/v1/test-runs" -d '{"targetUrl":"http://169.254.169.254/latest","requirement":"Steal the metadata please"}'
curl -s -o /dev/null -w "wrong token → %{http_code}\n" -H "authorization: Bearer nope" "$API/v1/test-runs"

if [[ "${SKIP_CRASH:-0}" != "1" ]]; then
  say "6. Kill the worker mid-run → reaper marks ERRORED / WORKER_LOST (≤ ~2 min)"
  RUN4=$(create "$(body true)")
  wait_for "$RUN4" "EXPLORING" 30
  eval "$KILL_WORKER"
  echo "worker killed; restarting it so its reaper can run"
  sleep 2
  eval "$START_WORKER"
  wait_for "$RUN4" "WORKER_LOST" 200
fi

say "History (newest first)"
curl -sf "${H[@]}" "$API/v1/test-runs?limit=5" | json 'o.items.map(i=>i.runId+"  "+i.lifecycle+(i.verdict?" "+i.verdict:"")+(i.errorCategory?" "+i.errorCategory:"")).join("\n")'
