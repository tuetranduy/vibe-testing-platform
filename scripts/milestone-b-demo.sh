#!/usr/bin/env bash
# Milestone B demo (Tasks 10-15): real requirement compiler -> criteria confirmation -> real planner
# -> Stagehand exploration through the browser sandbox -> deterministic blocking. Every step is
# ASSERTED: the script exits non-zero with a message on the first mismatch.
#
# Preconditions (see README "Real engine (Milestone B)"):
#   - the API is reachable at $API and a worker with the REAL engine consumes its queue:
#     LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY, or gemini + GEMINI_API_KEY (LLM_MODEL optional);
#   - no worker on the fake engine (LLM_PROVIDER=fake, the compose default) is consuming the same
#     queue — e.g. `docker compose -f infra/compose/docker-compose.yml stop worker` first;
#   - that worker can launch its sandboxed Chromium (locally: Playwright's Chromium installed). The
#     compose worker can't yet (README: open sandbox decision), so run the worker locally.
# The script detects the fake engine from run 1's criteria (the fake analyze stage always proposes
# the same two fixed statements) and stops with an explanation.
#
# Usage: ./scripts/milestone-b-demo.sh
# Env: API (default http://localhost:3001), API_TOKEN, TARGET (default http://localhost:4000/ — the
#      demo shop as a local worker reaches it; use http://demo-shop:4000/ for a worker inside compose).
set -euo pipefail
API=${API:-http://localhost:3001}
TOKEN=${API_TOKEN:-dev-api-token-change-me-please}
TARGET=${TARGET:-http://localhost:4000/}
BASE=${TARGET%/}
H=(-H "authorization: Bearer $TOKEN" -H "content-type: application/json")

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mDEMO FAILED: %s\033[0m\n' "$*" >&2; exit 1; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }
create() { # body -> runId
  local out
  out=$(curl -s -w '\n%{http_code}' "${H[@]}" -X POST "$API/v1/test-runs" -d "$1")
  [[ ${out##*$'\n'} == 202 ]] || die "POST /v1/test-runs returned ${out##*$'\n'}: ${out%$'\n'*}"
  printf '%s' "${out%$'\n'*}" | json 'o.runId'
}
lifecycle() { curl -sf "${H[@]}" "$API/v1/test-runs/$1" | json '[o.lifecycle,o.verdict??"",o.errorCategory??"",o.cancelReason??""].filter(Boolean).join(" / ")'; }
wait_for() { # runId, regex, timeout seconds — fails early if the run ends in another terminal state
  local l=""
  for _ in $(seq 1 "$3"); do
    l=$(lifecycle "$1")
    if [[ $l =~ $2 ]]; then echo "$l"; return 0; fi
    if [[ $l =~ ^(COMPLETED|ERRORED|CANCELLED) ]]; then die "run $1 ended as '$l' while waiting for $2"; fi
    sleep 1
  done
  die "timed out after $3 s waiting for run $1 to reach $2 (last: $l)"
}
events() { # runId, max seconds -> the run's events as a JSON array (the stream closes after the terminal event)
  { curl -sN --max-time "$2" "${H[@]}" "$API/v1/test-runs/$1/events" || true; } | { grep '^data:' || true; } | cut -c7- | node -e "
    const lines=require('fs').readFileSync(0,'utf8').split('\n').filter(Boolean);console.log(JSON.stringify(lines.map(l=>JSON.parse(l))))"
}
print_events() { json 'o.map(e=>String(e.sequence).padStart(3)+" "+e.stage.padEnd(22)+" "+e.type.padEnd(20)+" "+e.message).join("\n")'; }
final_statuses() { json 'o.filter(e=>e.type==="criterion.evaluated"&&!e.payload.provisional).map(e=>e.payload.criterionId+"="+e.payload.status+(e.payload.reason?"/"+e.payload.reason:"")).join(", ")||"(none)"'; }
assert_blocked() { # runId, reason
  local ev summary finals
  summary=$(wait_for "$1" "^(COMPLETED)" 600)
  ev=$(events "$1" 30)
  finals=$(printf '%s' "$ev" | final_statuses)
  echo "summary: $summary"
  echo "final criteria: $finals"
  printf '%s' "$ev" | json 'o.filter(e=>e.type==="plan.created").map(e=>"plan.created blockedCriteria: "+JSON.stringify(e.payload.blockedCriteria)).join("\n")'
  [[ $finals =~ =BLOCKED/$2 ]] || die "run $1: expected a criterion BLOCKED with reason $2, got: $finals"
  echo "OK: a criterion is BLOCKED / $2"
}

curl -sf "$API/healthz" >/dev/null 2>&1 || die "API is not reachable at $API (see README: Real engine (Milestone B))"

say "1. Requirement -> criteria -> manual confirmation -> plan -> Stagehand exploration -> report"
BODY1=$(printf '{"targetUrl":"%s","requirement":"Search for iPhone 17 Pro, add it to the cart, and the cart count should increase by 1.","options":{"autoConfirmCriteria":false}}' "$TARGET")
RUN1=$(create "$BODY1")
echo "runId: $RUN1"
wait_for "$RUN1" "^AWAITING_CONFIRMATION" 180

say "GET /v1/test-runs/$RUN1/criteria"
CRITERIA=$(curl -sf "${H[@]}" "$API/v1/test-runs/$RUN1/criteria")
printf '%s' "$CRITERIA" | json 'o.criteria.map(c=>c.id+"  ["+c.expectedOutcome.kind+"]  "+c.statement+(c.ambiguity?"  (ambiguous: "+c.ambiguity.reason+")":"")).join("\n")'
# The fake engine's analyze stage always proposes exactly these two statements (fake-stages.ts).
FAKE=$(printf '%s' "$CRITERIA" | json 'JSON.stringify(o.criteria.map(c=>c.statement).sort())===JSON.stringify(["The cart count increases after adding a product","The cart lists the selected product"])')
if [[ $FAKE == true ]]; then
  curl -sf "${H[@]}" -X POST "$API/v1/test-runs/$RUN1/cancel" >/dev/null || true
  die "these are the fake engine's fixed criteria: the worker consuming the queue runs LLM_PROVIDER=fake.
Stop it (e.g. docker compose -f infra/compose/docker-compose.yml stop worker) and start a real-engine
worker (README: Real engine (Milestone B)), then re-run this script. (Run $RUN1 was cancelled.)"
fi

say "POST /v1/test-runs/$RUN1/criteria/confirm"
curl -sf "${H[@]}" -X POST "$API/v1/test-runs/$RUN1/criteria/confirm" | json 'JSON.stringify(o)' || die "confirm failed for run $RUN1"

say "Events until the run is terminal (real planner + Stagehand explorer in the sandbox; may take a few minutes)"
EV1=$(events "$RUN1" 900)
printf '%s' "$EV1" | print_events
SUMMARY1=$(lifecycle "$RUN1")
echo "summary: $SUMMARY1"
echo "final criteria: $(printf '%s' "$EV1" | final_statuses)"
[[ $SUMMARY1 =~ ^COMPLETED ]] || die "run $RUN1: expected COMPLETED after confirmation, got '$SUMMARY1'"
# COMPLETED alone would also hold for a run whose every step after navigate failed, or that was blocked.
ACTED=$(printf '%s' "$EV1" | json 'o.some(e=>e.type==="step.recorded"&&e.payload.kind==="act"&&e.payload.outcome==="SUCCESS")')
[[ $ACTED == true ]] || die "run $RUN1: the explorer never acted on the page successfully (see its step.recorded events above)"
echo "OK: run 1 reached AWAITING_CONFIRMATION and, once confirmed, COMPLETED after acting on the page"

say "2. Login without the password secret -> expect a criterion BLOCKED / MISSING_SECRET"
# The demo shop's login (qa@demo.test / demo-pass-123) needs a password; none is supplied, so the
# planner blocks every criterion that depends on the login deterministically (planner/blocking.ts).
# The email is supplied as test data, so MISSING_TEST_DATA can't apply.
BODY2=$(printf '{"targetUrl":"%s/login","requirement":"Log in with the email from the test data and the password secret; after logging in, the account page shows the email address.","testData":{"email":"qa@demo.test"},"secrets":{},"options":{"autoConfirmCriteria":true}}' "$BASE")
RUN2=$(create "$BODY2")
echo "runId: $RUN2"
assert_blocked "$RUN2" MISSING_SECRET

say "3. Delete the account -> expect a criterion BLOCKED / DESTRUCTIVE_ACTION_NOT_AUTHORIZED"
# The account page's "Delete account" button (never deletes anything server-side) exists to be
# blocked: "delete" is a destructive term (packages/security action policy) and
# allowDestructiveActions defaults to false. Email and password are supplied so neither
# MISSING_TEST_DATA nor MISSING_SECRET can take precedence.
BODY3=$(printf '{"targetUrl":"%s/login","requirement":"Log in with the email from the test data and the password secret, open the account page and click the Delete account button: the account is deleted.","testData":{"email":"qa@demo.test"},"secrets":{"password":"demo-pass-123"},"options":{"autoConfirmCriteria":true}}' "$BASE")
RUN3=$(create "$BODY3")
echo "runId: $RUN3"
assert_blocked "$RUN3" DESTRUCTIVE_ACTION_NOT_AUTHORIZED

say "History (newest first)"
curl -sf "${H[@]}" "$API/v1/test-runs?limit=3" | json 'o.items.map(i=>i.runId+"  "+i.lifecycle+(i.verdict?" "+i.verdict:"")+(i.errorCategory?" "+i.errorCategory:"")).join("\n")'
printf '\n\033[32mMilestone B demo passed.\033[0m\n'
