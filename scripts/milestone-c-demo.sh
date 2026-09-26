#!/usr/bin/env bash
# Milestone C demo (Tasks 16-18): exploration -> generated Playwright test -> sandboxed rerun ->
# scrubbed trace -> reconciled report JSON. Every step is ASSERTED: the script exits non-zero with a
# message on the first mismatch.
#
# Preconditions (see README "Real engine (Milestone B)" and "Milestone C demo"):
#   - the API is reachable at $API and a worker with the REAL engine consumes its queue:
#     LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY (LLM_MODEL optional, default claude-sonnet-5);
#   - no worker on the fake engine (LLM_PROVIDER=fake, the compose default) is consuming the same
#     queue — e.g. `docker compose -f infra/compose/docker-compose.yml stop api worker` first;
#   - that worker can launch its sandboxed Chromium for exploration AND for the Playwright rerun
#     (locally: Playwright's Chromium installed). The compose worker can't yet (README: open sandbox
#     decision), so run the worker locally.
# The script detects the fake engine from run 1's criteria (the fake analyze stage always proposes
# the same two fixed statements) and stops with an explanation.
#
# Two live runs (each costs LLM tokens), both auto-confirmed:
#   1. healthy shop: add iPhone 17 Pro to the cart -> COMPLETED; the generated test reran and
#      confirmed at least one criterion; no PASS rests on model-extracted facts.
#   2. ?bug=empty_cart + a login with a password secret: the cart-listing criterion FAILs, confirmed
#      by the rerun, with its evidence; the rerun trace is downloaded through the API and must not
#      contain the password (plain, URL-encoded, base64) although it records the secret-filled action.
#
# Usage: ./scripts/milestone-c-demo.sh
# Env: API (default http://localhost:3001), API_TOKEN, TARGET (default http://localhost:4000/ — the
#      demo shop as a local worker reaches it; use http://demo-shop:4000/ for a worker inside compose).
set -euo pipefail
API=${API:-http://localhost:3001}
TOKEN=${API_TOKEN:-dev-api-token-change-me-please}
TARGET=${TARGET:-http://localhost:4000/}
BASE=${TARGET%/}
# The demo shop's test login (tests/fixtures/demo-shop/src/server.js VALID_EMAIL / VALID_PASSWORD).
EMAIL=qa@demo.test
PASSWORD=demo-pass-123
H=(-H "authorization: Bearer $TOKEN" -H "content-type: application/json")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/milestone-c-demo.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

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
events() { # runId, max seconds -> the run's events as a JSON array (the stream closes after the terminal event)
  { curl -sN --max-time "$2" "${H[@]}" "$API/v1/test-runs/$1/events" || true; } | { grep '^data:' || true; } | cut -c7- | node -e "
    const lines=require('fs').readFileSync(0,'utf8').split('\n').filter(Boolean);console.log(JSON.stringify(lines.map(l=>JSON.parse(l))))"
}
print_events() { json 'o.map(e=>String(e.sequence).padStart(3)+" "+e.stage.padEnd(22)+" "+e.type.padEnd(20)+" "+e.message).join("\n")'; }
has_event() { [[ $(printf '%s' "$1" | json "o.some(e=>e.type===\"$2\")") == true ]]; }
report() { # runId -> the report JSON (asserts 200)
  local out
  out=$(curl -s -w '\n%{http_code}' "${H[@]}" "$API/v1/test-runs/$1/report")
  [[ ${out##*$'\n'} == 200 ]] || die "GET /v1/test-runs/$1/report returned ${out##*$'\n'}: ${out%$'\n'*}"
  printf '%s' "${out%$'\n'*}"
}
# The demo's deliverable: the reconciled part of the report (criteria, summary, verdict, rerun).
print_report() { json 'JSON.stringify({runId:o.runId,lifecycle:o.lifecycle,verdict:o.verdict,summary:o.summary,playwright:o.playwright,
  generatedTest:o.generatedTest&&{id:o.generatedTest.id,compiledCriteria:o.generatedTest.compiledCriteria,notCompiled:o.generatedTest.notCompiled,notes:o.generatedTest.notes,sourceLines:o.generatedTest.source.split("\n").length},
  criteria:o.criteria,diagnostics:o.diagnostics,usage:o.usage,durationMs:o.durationMs},null,2)'; }
run_to_end() { # runId -> events JSON; asserts COMPLETED
  local ev summary
  ev=$(events "$1" 900)
  printf '%s' "$ev" | print_events >&2
  summary=$(lifecycle "$1")
  echo "summary: $summary" >&2
  [[ $summary =~ ^COMPLETED ]] || die "run $1: expected COMPLETED, got '$summary'"
  printf '%s' "$ev"
}
# Every PASS criterion is backed by deterministic evidence: a verdict source, and — the rerun or not —
# every fact it references was last read from the DOM (fact.observed provenance; never model-extracted).
assert_pass_evidence() { # runId, report JSON, events JSON
  local bad
  bad=$(node -e '
    const [report, events] = [JSON.parse(process.argv[1]), JSON.parse(process.argv[2])];
    const latest = new Map();
    for (const e of events) if (e.type === "fact.observed") latest.set(e.payload.key + "@" + e.payload.checkpoint, e.payload.provenance);
    const bad = [];
    for (const c of report.criteria.filter((c) => c.status === "PASS")) {
      if (!["PLAYWRIGHT_RERUN", "EXPLORATION_ONLY"].includes(c.verdictSource)) bad.push(c.criterionId + ": verdictSource " + c.verdictSource);
      if (c.factRefs.length === 0) bad.push(c.criterionId + ": PASS without any fact");
      for (const r of c.factRefs) {
        const p = latest.get(r.key + "@" + r.checkpoint);
        if (p !== "DOM_VERIFIED") bad.push(c.criterionId + ": fact " + r.key + "@" + r.checkpoint + " is " + (p ?? "not recorded"));
      }
    }
    console.log(bad.join("; "));' "$2" "$3")
  [[ -z $bad ]] || die "run $1: a PASS without deterministic evidence: $bad"
  echo "OK: every PASS criterion has a verdict source and only DOM-verified facts"
}

curl -sf "$API/healthz" >/dev/null 2>&1 || die "API is not reachable at $API (see README: Real engine (Milestone B))"
command -v unzip >/dev/null || die "unzip is required to inspect the rerun trace"

# ---------------------------------------------------------------------------------------------
say "1. Healthy shop: exploration -> generated test -> sandboxed rerun -> reconciled report"
BODY1=$(printf '{"targetUrl":"%s","requirement":"Open the iPhone 17 Pro product page and click Add to cart: the cart badge count in the header increases by 1. Then open the Cart page: the cart lists iPhone 17 Pro.","options":{"autoConfirmCriteria":true,"maxRunSeconds":600}}' "$TARGET")
RUN1=$(create "$BODY1")
echo "runId: $RUN1"
say "Events until the run is terminal (real planner, Stagehand explorer, compiler and rerun; may take a few minutes)"
EV1=$(run_to_end "$RUN1")
REPORT1=$(report "$RUN1")
# The fake engine's analyze stage always proposes exactly these two statements (fake-stages.ts).
FAKE=$(printf '%s' "$REPORT1" | json 'JSON.stringify((o.requirement?.criteria??[]).map(c=>c.statement).sort())===JSON.stringify(["The cart count increases after adding a product","The cart lists the selected product"])')
if [[ $FAKE == true ]]; then
  die "these are the fake engine's fixed criteria: the worker consuming the queue runs LLM_PROVIDER=fake.
Stop it (e.g. docker compose -f infra/compose/docker-compose.yml stop api worker) and start a local API and
a real-engine worker (README: Real engine (Milestone B)), then re-run this script."
fi
has_event "$EV1" test.generated || die "run $RUN1: no test.generated event (the flow was not compiled into a test)"
has_event "$EV1" playwright.completed || die "run $RUN1: no playwright.completed event (the generated test was not rerun)"
echo "OK: test.generated and playwright.completed were published"

say "GET /v1/test-runs/$RUN1/report (reconciled)"
printf '%s' "$REPORT1" | print_report
[[ $(printf '%s' "$REPORT1" | json 'typeof o.generatedTest?.source==="string"&&o.generatedTest.source.length>0') == true ]] \
  || die "run $RUN1: the report has no generatedTest.source"
CONFIRMED1=$(printf '%s' "$REPORT1" | json 'o.summary.confirmedByRerun')
((CONFIRMED1 >= 1)) || die "run $RUN1: summary.confirmedByRerun is $CONFIRMED1; expected the rerun to confirm at least one criterion"
echo "OK: generatedTest.source is present; $CONFIRMED1 criterion(s) confirmed by the rerun"
assert_pass_evidence "$RUN1" "$REPORT1" "$EV1"

# ---------------------------------------------------------------------------------------------
say "2. ?bug=empty_cart + login with a password secret: the cart-listing criterion FAILs with evidence; the trace is scrubbed"
# bug=empty_cart (a cookie set from the query) makes the cart page list nothing while the badge still
# counts. The login makes the rerun fill the password from SECRET_PASSWORD, so its trace records a
# secret-filled action; failing runs keep their trace.
BODY2=$(printf '{"targetUrl":"%s/login?bug=empty_cart","requirement":"Log in with the email from the test data and the password secret. Then open the iPhone 17 Pro product page, click Add to cart, and open the Cart page: the cart lists iPhone 17 Pro.","testData":{"email":"%s"},"secrets":{"password":"%s"},"options":{"autoConfirmCriteria":true,"maxRunSeconds":600}}' "$BASE" "$EMAIL" "$PASSWORD")
RUN2=$(create "$BODY2")
echo "runId: $RUN2"
say "Events until the run is terminal"
EV2=$(run_to_end "$RUN2")
has_event "$EV2" test.generated || die "run $RUN2: no test.generated event"
has_event "$EV2" playwright.completed || die "run $RUN2: no playwright.completed event"
REPORT2=$(report "$RUN2")

say "GET /v1/test-runs/$RUN2/report (reconciled)"
printf '%s' "$REPORT2" | print_report
assert_pass_evidence "$RUN2" "$REPORT2" "$EV2"

# The criterion about the cart listing the product: the one whose source text or statement says the cart lists iPhone 17 Pro.
LISTING=$(printf '%s' "$REPORT2" | json '(o.requirement?.criteria??[]).filter(c=>/\blist/i.test(c.sourceText+" "+c.statement)&&/iPhone 17 Pro/i.test(c.sourceText+" "+c.statement)).map(c=>c.id).join(" ")')
[[ -n $LISTING ]] || die "run $RUN2: no criterion about the cart listing iPhone 17 Pro among: $(printf '%s' "$REPORT2" | json '(o.requirement?.criteria??[]).map(c=>c.id+" "+c.statement).join(" | ")')"
for ID in $LISTING; do
  ROW=$(printf '%s' "$REPORT2" | json "JSON.stringify(o.criteria.find(c=>c.criterionId===\"$ID\")??null)")
  [[ $ROW != null ]] || die "run $RUN2: $ID has no result in the report"
  STATE=$(printf '%s' "$ROW" | json '[o.status,o.verdictSource,o.rerunOutcome,o.provisional.status].join(" / ")')
  echo "$ID: status / verdictSource / rerunOutcome / provisional = $STATE"
  [[ $STATE =~ ^FAIL\ /\ PLAYWRIGHT_RERUN ]] || die "run $RUN2: expected $ID to be FAIL / PLAYWRIGHT_RERUN (a discovery FAIL confirmed by the rerun), got $STATE"
  MISSING=$(printf '%s' "$ROW" | json '[["expected",o.expected],["actual",o.actual],["evidenceArtifactIds",o.evidenceArtifactIds],["relatedStepIds",o.relatedStepIds]].filter(([,v])=>!(v&&v.length>0)).map(([k])=>k).join(", ")')
  [[ -z $MISSING ]] || die "run $RUN2: the FAIL criterion $ID has empty: $MISSING"
  echo "OK: $ID is FAIL / PLAYWRIGHT_RERUN with expected, actual, evidence and related steps"
done
FAIL_ID=${LISTING%% *}

say "Rerun evidence of $FAIL_ID"
printf '%s' "$EV2" | json 'o.filter(e=>e.type==="artifact.created"||e.type==="artifact.omitted").map(e=>e.type+" "+JSON.stringify(e.payload)+"  "+e.message).join("\n")'
NOT_SECRET=$(printf '%s' "$EV2" | json 'o.filter(e=>e.type==="artifact.created"&&e.payload.sensitivity!=="SECRET_BEARING").map(e=>e.payload.type+" "+e.payload.artifactId).join(", ")')
[[ -z $NOT_SECRET ]] || die "run $RUN2 has a secret, but these artifacts are not SECRET_BEARING: $NOT_SECRET"
echo "OK: every artifact of the run is SECRET_BEARING"
TRACE_ID=$(node -e '
  const [report, events, id] = [JSON.parse(process.argv[1]), JSON.parse(process.argv[2]), process.argv[3]];
  const evidence = new Set(report.criteria.find((c) => c.criterionId === id).evidenceArtifactIds);
  const trace = events.find((e) => e.type === "artifact.created" && e.payload.type === "TRACE" && evidence.has(e.payload.artifactId));
  console.log(trace ? trace.payload.artifactId : "");' "$REPORT2" "$EV2" "$FAIL_ID")
[[ -n $TRACE_ID ]] || die "run $RUN2: $FAIL_ID's evidence has no rerun TRACE (see the artifact events above)"
echo "trace artifact: $TRACE_ID"

URL_ROUTE="$API/v1/test-runs/$RUN2/artifacts/$TRACE_ID/url"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" "$URL_ROUTE")
[[ $CODE == 403 ]] || die "GET $URL_ROUTE without reveal=true returned $CODE; a SECRET_BEARING artifact needs reveal=true (403)"
echo "OK: without reveal=true the artifact URL route answers 403"
SIGNED=$(curl -sf "${H[@]}" "$URL_ROUTE?reveal=true" | json 'o.url') || die "GET $URL_ROUTE?reveal=true failed"
curl -sf -o "$WORK/trace.zip" "$SIGNED" || die "could not download the trace through its signed URL"
mkdir "$WORK/trace"
unzip -q "$WORK/trace.zip" -d "$WORK/trace" || die "the downloaded trace is not a readable zip"
echo "downloaded $(wc -c <"$WORK/trace.zip" | tr -d ' ') bytes, $(find "$WORK/trace" -type f | wc -l | tr -d ' ') entries"

# The forms the password could take in a trace: plain, URL-encoded (the demo password encodes to
# itself), form-encoded, base64 and base64url.
FORMS=$(node -e 'const s=process.argv[1];console.log([...new Set([s,encodeURIComponent(s),new URLSearchParams([["",s]]).toString().slice(1),Buffer.from(s).toString("base64"),Buffer.from(s).toString("base64").replace(/=+$/,""),Buffer.from(s).toString("base64url")])].join("\n"))' "$PASSWORD")
while IFS= read -r FORM; do
  if grep -rqaF -- "$FORM" "$WORK/trace" "$WORK/trace.zip"; then die "the rerun trace of run $RUN2 contains the password secret (one of its encoded forms)"; fi
done <<<"$FORMS"
echo "OK: the password appears in the trace in none of its forms (plain, URL-encoded, base64)"
# ... and the trace does record the secret-filled action: a fill whose value is the scrubbed secret
# (Playwright trace events: {"method":"fill","params":{"selector":...,"value":"[REDACTED]",...}}).
grep -rqaE '"method":"fill","params":\{[^}]*"value":"\[REDACTED\]"' "$WORK/trace" \
  || die "the rerun trace has no fill action with a [REDACTED] value: the secret-filled action is not in it"
echo "OK: the trace records the password fill, with the value replaced by [REDACTED]"

say "History (newest first)"
curl -sf "${H[@]}" "$API/v1/test-runs?limit=2" | json 'o.items.map(i=>i.runId+"  "+i.lifecycle+(i.verdict?" "+i.verdict:"")+(i.errorCategory?" "+i.errorCategory:"")).join("\n")'
printf '\n\033[32mMilestone C demo passed.\033[0m\n'
