# browser-use-discovery (fixture-only slice)

Browser Use 1.0.6 proposes functional test scenarios from one bundled, disposable fixture site. Users
review the suggestions and the platform verifies selected scenarios through Stagehand and Playwright.

## Interface (one-shot, driven by Node)

```
bin/browser-use-discovery            # no args. Node sends SIGTERM to cancel.
stdin  : {"schemaVersion":"discovery.v1","runId":"<[A-Za-z0-9_-]{1,128}>","targetUrl":"<url>"}\n
stdout : {"schemaVersion":"discovery.v1","runId":"<same>","status":"COMPLETED|PARTIAL|BLOCKED|FAILED|CANCELLED",
          "reason":"<code>","candidates":[{"title":"...","goal":"...","rationale":"...","relevantPaths":["/..."],
          "expectedBehavior":["..."],"negativeCases":[]}],"statistics":{...}}\n
stderr : JSON lines with only numbers and codes: discovery.progress {agentSteps}, discovery.summary {status, reason,
         agentSteps, modelRequests, inputTokens, outputTokens, durationMs}
exit   : 0 (a response was written), 143 (CANCELLED by a signal), 2 (invalid request: FAILED with runId "invalid")
```

- `BLOCKED`: `targetUrl` is not exactly the configured fixture URL, or no model is configured. No container starts.
- Only `COMPLETED` carries candidates (1 to 12). Bounds: title 3-80, goal 10-500, rationale 1-300, relevantPaths
  1-8 bare fixture paths (each ≤180 characters), expectedBehavior 1-5, negativeCases 0-5, items 1-180 characters.
  Unicode control and format characters are removed.
- Hard limits (not caller-configurable): Browser Use `max_steps=19`, `timeout=120`, at most 20 model calls per run
  (delivery repairs included), `judge=False`, `web_search=False`, `use_vision=False`, no `sensitive_data`.
- `reason` is a code, never text from a page or provider: `ok`, `no_valid_candidates`, `timeout`, `max_steps`,
  `hard_deadline`, `cancelled`, `agent_error`, `no_result`, `target_not_allowed`, `model_not_configured`,
  `docker_unavailable`, `invalid_request`.
- A request may lower the budget with `timeoutSeconds` (10–120) and `maxAgentSteps` (2–20 model calls).
  `timeoutSeconds` is the **whole job's** wall-clock budget from receipt: the orphan reaper, container start, the
  agent and result delivery. The agent gets what remains after a 5 s start reserve and a 5 s delivery margin (at
  least 5 s). At the budget the launcher stops and removes the container and answers `FAILED`/`hard_deadline`, so a
  caller that waits a few seconds longer always receives a typed reply. The agent's own timeout answers
  `PARTIAL`/`timeout`.
- Without `timeoutSeconds`, the launcher bounds itself at 180 s (up to 45 s container/Chromium start + the 120 s
  agent budget + 15 s grace). The caller may stop it sooner at any time with SIGTERM (→ `CANCELLED`, container
  removed). The platform always sends `timeoutSeconds`: its stage budget minus a 5 s result grace.
- Container removal is asynchronous and verified: `docker rm -f`, and when Docker's own `--rm` is already removing
  it, polling until Docker no longer knows the container (within 15 s). A failure is logged as
  `discovery.cleanup_error` and counted by the job service's health endpoint.

## Setup

```sh
cd apps/browser-use-discovery
uv sync --frozen                                     # host venv: launcher + broker (+ pytest)
docker build -t vtp-browser-use-discovery:1.0.6 .    # the disposable runner image
cp discovery.env.example discovery.env              # Node passes PATH only, so config is read from this file
echo '{"schemaVersion":"discovery.v1","runId":"r1","targetUrl":"http://127.0.0.1:4599/"}' | bin/browser-use-discovery
```

Config (`discovery.env`, or the file named by `BROWSER_USE_DISCOVERY_ENV`):

| Key | Meaning |
|---|---|
| `DISCOVERY_FIXTURE_URL` | The only accepted `targetUrl`, e.g. `http://127.0.0.1:4599/`. It must be `http`, use port 1024 or above, and have host `127.0.0.1` or a DNS name. |
| `DISCOVERY_MODEL` | `scripted` (local and deterministic, no key, no cost); `local:<model>` for a zero-cost OpenAI-compatible server on this host's loopback (LM Studio, llama.cpp, vLLM; `DISCOVERY_LOCAL_MODEL_URL`, default `http://127.0.0.1:1234/v1`, must be a loopback `http://` URL); or a Pydantic AI model string such as `anthropic:claude-sonnet-5-5`, whose API key goes in the same file and stays in the host launcher. |
| `DISCOVERY_TARGET_MODE` | `bundled` (default): the agent container has no network and explores its own copy of the fixture. `proxy` (development and test): see *Target egress (proxy mode)*. |
| `DISCOVERY_TARGET_NETWORK` | Proxy mode only: a pre-created `--internal` Docker network named `vtp-discovery-targets[-name]` holding the approved fixture container. |
| `DISCOVERY_IMAGE` | Default `vtp-browser-use-discovery:1.0.6` (`--pull never`). |
| `DOCKER_HOST` | Optional, for a Docker CLI that cannot find its socket without `HOME`. |

## Run discovery from the platform

From the repository root, start the host copy of the fixture in a separate terminal.

```sh
apps/browser-use-discovery/bin/serve-fixture --port 4599
```

Admission and transport are configured separately. The API needs only the non-secret admission values. The worker
also needs a transport; only the worker ever holds the job service token.

```sh
# API and worker: admission (non-secret)
export BROWSER_USE_DISCOVERY_FIXTURE_URL=http://127.0.0.1:4599/
export BROWSER_USE_DISCOVERY_TENANTS=t_default          # optional; default: DEFAULT_TENANT_ID
export TARGET_PRIVATE_ALLOWLIST="${TARGET_PRIVATE_ALLOWLIST:+$TARGET_PRIVATE_ALLOWLIST,}127.0.0.1:4599"
# Worker only: one transport (the one-shot launcher here; the job service below)
export BROWSER_USE_DISCOVERY_LAUNCHER="$PWD/apps/browser-use-discovery/bin/browser-use-discovery"
export BROWSER_USE_DISCOVERY_TENANT_HOURLY_LIMIT=20     # optional; attempts per tenant per hour
```

Configuration fails at startup for a transport without the fixture URL, two transports, a service URL without its
token, or a token without a service URL. With `NODE_ENV=production`, every `BROWSER_USE_DISCOVERY_*` admission or
transport variable that is set is named as an error: the pilot is for development and test only.
Start the API and worker with the updated environment. An administrator enables the pilot in **Settings → Browser Use fixture pilot**
for the eligible tenant. Enter the fixture URL
in **Create a test**, select a real survey model, choose **Find test ideas**, and check **Autonomous Discovery (Browser Use)**.
The run uses staging mode and requires manual criteria confirmation. Browser Use candidates show their source and
fixture paths in the review screen. If discovery does not complete, the run offers the standard survey suggestions.

Every opted-in run records exactly one outcome event (`discovery.completed` or `discovery.failed`) with a status, a
reason code and whether a broker job was attempted, including on a worker that cannot run discovery:

| Status | Meaning (reason codes) | Job attempted |
|---|---|---|
| `COMPLETED` | Candidates were returned (`ok`) | yes |
| `PARTIAL` | The agent finished without reviewable ideas (`no_valid_candidates`, `max_steps`) | yes |
| `TIMED_OUT` | A time budget ran out (`timeout`, `hard_deadline`, `worker_deadline`), or too little survey time was left (`no_budget`) | yes, except `no_budget` |
| `BUSY` | Backpressure: the broker's single slot (`broker_busy`) or the tenant's hourly quota (`tenant_quota`) | no |
| `BLOCKED` | Configuration or rollout: `not_configured` (no worker transport), `fixture_mismatch`, `environment`, `tenant_disabled` | no |
| `FAILED` | The broker or transport failed (`broker_unavailable`, `invalid_result`, `agent_error`, `no_result`, …) | yes |
| `CANCELLED` | The broker stopped an active job, or the tenant disabled discovery while it was running (`tenant_disabled`) | yes |

The discovery budget is independent of Stagehand execution and capped by the remaining survey time. An administrator
can select **Disable Browser Use** for the current tenant. New opted-in requests are refused. Queued runs that have
yet to start Browser Use continue with standard suggestions. During discovery, the worker checks the flag every
two seconds and again before using the broker result. A disabled or unreadable flag aborts the discovery call and
keeps the standard survey. Signed-service cancellation requests the broker's cleanup. The existing job deadline
still bounds the job if the worker cannot reach the broker.

### Internal job service

The worker can use a loopback job service. Add a random `DISCOVERY_SERVICE_TOKEN` of at least 32 characters to the
trusted host's `discovery.env`, then run `apps/browser-use-discovery/bin/browser-use-discovery --serve`. Use the same value
for `BROWSER_USE_DISCOVERY_SERVICE_TOKEN` in the **worker** environment only, set
`BROWSER_USE_DISCOVERY_SERVICE_URL=http://127.0.0.1:4600` there, and unset `BROWSER_USE_DISCOVERY_LAUNCHER`. The API
does not need either value.

- `GET /internal/health` checks that the configured image is available and reports `activeJobs`, `jobSlots` (always
  1) and `cleanupFailures`. The service has no Prometheus endpoint; the worker's `discovery_active_jobs` is the
  scraped view of the same concurrency.
- `POST /internal/v1/discoveries` submits a job with the idempotency key `<runId>:discovery.v1`.
- `GET /internal/v1/discoveries/<jobId>` polls the latest step count and completed result.
- `GET /internal/v1/discoveries/<jobId>/events` returns a bounded progress snapshot.
- `DELETE /internal/v1/discoveries/<jobId>` cancels and cleans up the job.

Each request carries `Authorization: Bearer <unix-seconds>.<32-hex nonce>.<HMAC-SHA256>`. The signature covers
`v2`, the method, path, timestamp, nonce, idempotency key and the SHA-256 of the body, so a captured header cannot
authorize another body, budget, run, path or method. The service accepts each nonce once within the ±60 s window
(a replay is `401`) and keeps at most 4,096 live nonces (`503` when full). Status and cancellation requests must
have no body. The service accepts one active job at a time (`429` otherwise, which the worker records as `BUSY`) and
keeps completed replies for 15 minutes in a bounded, in-memory registry. It runs on the trusted host with local
Docker access. Each job runs in a fresh, isolated agent container.

### Platform verification

With the scripted discovery model configured, run the real Chromium survey and Browser Use integration test from the repository root.

```sh
pnpm test:integration tests/integration/survey-stage.test.ts
pnpm test:e2e tests/e2e/platform-discovery.spec.ts tests/e2e/platform-suggest.spec.ts
```

The discovery E2E selects a Browser Use suggestion **unedited**, confirms its criteria, and requires the run to pass
through Stagehand and an independent Playwright rerun with the suggestion's own requirement in the report. It also
drills a deterministic rollback: the run queue is paused, an opted-in run is queued, the tenant is disabled, and on
resume the run records `BLOCKED`/`tenant_disabled` and offers only standard suggestions. It uses scripted survey,
Stagehand and Browser Use models in CI mode, the real Browser Use agent container and the signed job service. CI
(`.github/workflows/browser-use-discovery.yml`) runs it with `BROWSER_USE_DISCOVERY_E2E_REQUIRED=1`, so a missing
transport fails instead of skipping. The signed-service integration test disables rollout after broker progress. It
checks for `CANCELLED`/`tenant_disabled`, standard suggestions and a clean broker health result.

### Fixture smoke, evaluation and alerts

The scripted fixture smoke and the hosted-model evaluation mechanism are described in
[`evals/discovery/README.md`](../../evals/discovery/README.md). The smoke is plumbing evidence, not a usefulness
measure.

Prometheus (worker) exposes:

| Metric | Notes |
|---|---|
| `discovery_jobs_total{status,reason}` | One per opted-in run, including `BLOCKED` and `BUSY` outcomes |
| `discovery_duration_seconds` | Attempted jobs only |
| `discovery_fallback_total`, `discovery_candidates_total{kind}`, `discovery_agent_steps` | |
| `discovery_model_cost_usd_total` | Known model cost only; unpriced requests are excluded |
| `discovery_cancellation_cleanup_errors_total` | Abandoned jobs whose cancellation the broker did not confirm |
| `discovery_protocol_violations_total` | Malformed frames from agent containers |
| `discovery_worker_memory_bytes` | Histogram of each attempted job's **agent container** peak memory (Chromium, Browser Use and the agent's Python), not the Node worker's. The host launcher samples `docker stats` about once a second, so spikes shorter than that can be missed; the kernel still enforces the container's 2 GiB limit. The Node worker's own memory is `process_resident_memory_bytes`. |
| `discovery_active_jobs` | Discovery calls in flight in this worker process; Prometheus sums workers |
| `discovery_selected_runs_total{lifecycle,verdict,edited}` | Runs that executed a selected Browser Use suggestion, by how they ended (from the suggestion's `discovery` provenance). Runs the API ends itself are not counted |

Load `infra/monitoring/browser-use-discovery.rules.yml` into the Prometheus instance that scrapes the worker. It
alerts on the failure rate of attempted jobs (backpressure and rollout outcomes excluded), sustained backpressure,
admitted runs a worker cannot run, p95 latency, cleanup errors, protocol violations, known hourly cost, an agent
container peaking above 90 % of its memory limit, and selected Browser Use suggestions that end inconclusive,
blocked or errored at least 20 points more often than the platform's runs overall (cancellations excluded).
`browser-use-discovery.rules.test.yml` holds promtool unit tests for these rules:

```sh
docker run --rm --network none -v "$PWD/infra/monitoring:/rules:ro" -w /rules --entrypoint promtool prom/prometheus:v3.5.0 test rules browser-use-discovery.rules.test.yml
```

The container has no network, so blocked-destination counts are not observable here: every egress attempt fails
in the kernel. Counting blocked destinations needs the policy-controlled egress proxy that external targets
require (see the plan's §8.2).

### Target egress (proxy mode)

Development and test only, for controlled disposable fixtures. With `DISCOVERY_TARGET_MODE=proxy` and
`DISCOVERY_TARGET_NETWORK=vtp-discovery-targets[-name]` (an existing `--internal` network that holds the fixture's
container), each job gets:

- its own `--internal` network (no route to the host or the internet), whose only peer is
- a per-job egress proxy (`discovery_service.egress_proxy`, same image and hardening) that also joins the target
  network and forwards plain HTTP only to the fixture URL's exact `host:port`, refusing CONNECT, other hosts and ports,
  malformed requests and names that resolve to loopback, link-local (metadata), multicast or unspecified addresses.

Chromium uses the proxy through `/app/bin/chromium-proxied` (Browser Use 1.0.6 has no local proxy option), with its
background networking disabled. Model calls still leave only through the broker on the container's stdin/stdout.
The proxy logs one reason code per refusal (never hosts, paths or content); the launcher counts them into
`statistics.blockedDestinations` and `blockedByReason`, and removes the proxy and network with the job. The launcher
refuses any target network that is not an internal `vtp-discovery-targets*` network.

Live jobs use a separate HTTPS proxy that forwards browser methods and request bodies to approved destinations.
Browser Use can submit forms with synthetic data and continue through checkout and sandbox payment steps.

## Isolation model

```
Node ──stdin/stdout──▶ launcher (host; holds model key) ──docker run -i──▶ container (untrusted)
                          │  broker: ≤20 model calls,                     runner + Browser Use agent
                          │  no media/native tools,                        + REPL (model-authored Python)
                          │  clamped settings                              + Chromium + fixture copy on loopback
                          └─ validates + sanitizes the result              --network none: only `lo` exists
```

- **The container can reach only its own loopback interface** (`--network none`). This applies to every process in it: Chromium,
  Browser Use, and the agent's arbitrary Python, including raw sockets, DNS, UDP and `http_get`. Cloud metadata,
  host services, the Docker gateway and the internet cannot be reached. The agent's target origin is answered by the
  container's own copy of the fixture: a loopback server on the configured port, with the hostname pinned by
  `--add-host` when one is used. `Browser(allowed_domains=...)` adds navigation hygiene, but it is not the security
  boundary.
- **No secrets inside.** The image holds no credentials. `docker run` gets only fixed, non-secret `-e` values, no
  volumes and no env-file. The model credential lives in the host launcher. Model calls leave the container only as
  `model_request` frames on its stdout. The broker re-validates every frame, refuses media (image, file or document
  URLs, inline bytes) and provider-native tools, clamps `max_tokens`, temperature and timeout, and stops at 20 calls.
- **Hardening:** read-only root filesystem, `/tmp` tmpfs (512 MB), `--cap-drop ALL`, `no-new-privileges`, uid 10001,
  no `--init` (the runner is PID 1), 512 PIDs, 2 GB memory (no swap), 2 CPUs, `--log-driver none`. The runner is PID 1 and the only process that holds the container's
  stdin and stdout. A wrapper such as docker-init or timeout(1) would keep those pipes in a dumpable process. The
  runner marks itself non-dumpable and moves the channel to private close-on-exec descriptors, so agent code cannot
  open `/proc/1/fd/*` to forge frames. Even a forged result would only reach the launcher's sanitizer.
- **Teardown:**
  - On SIGTERM, SIGINT or SIGHUP the launcher runs `docker rm -f` on the container and prints `CANCELLED`.
  - If the launcher is SIGKILLed, the heartbeat stops. The launcher sends an `hb` frame every 2 s, separate from
    model calls, and the runner exits after 10 s of host silence (this also applies before the start frame). Docker
    attach does not reliably close stdin when the parent dies.
  - As a backup, the runner kills itself after 210 s.
  - Each launch removes orphaned containers that are past their deadline label (`vtp.browser-use-discovery`).
- **Grounding:** bundled jobs only keep candidates backed by fixture pages. Scenarios about logins, deletion or
  security testing are dropped. Live jobs can also report payment steps on observed pages.

## Tests

```sh
uv run --frozen pytest -q -m "not docker"   # unit: protocol bounds, policy, broker budget/media, launcher mapping
uv run --frozen pytest -q -s -m docker      # needs the image: real Browser Use + Chromium in the container
```

The Docker tests use the scripted model and make no paid calls. They cover:

- a full discovery that ends `COMPLETED`;
- a **hostile agent cell** that tries raw TCP to `169.254.169.254`, `127.0.0.1`, `host.docker.internal`, the Docker
  gateways, `10.0.0.1`, `8.8.8.8`, `1.1.1.1` and a public IP; UDP DNS; name resolution; `urllib` and `http_get`;
  browser navigation to metadata and an off-site page; reading every `/proc/*/environ`; and opening the runner's
  IPC descriptors. Every attempt must be blocked, only the loopback interface may be up, a canary API key set in the
  launcher must not appear in the output, and a host canary listener must see zero connections;
- a **positive control**: the same image on a bridge network does reach that canary, so the probe is capable of
  detecting a leak;
- the CLI called with a PATH-only environment;
- `BLOCKED` for a non-fixture target;
- a caller budget that completes inside the job budget and leaves no container;
- an event loop that stays responsive while a real container starts, runs and is removed;
- SIGTERM → `CANCELLED`, exit 143, no container left;
- a SIGKILLed launcher → the container still exits.

## Upgrading Browser Use

This code relies on 1.0.6 behavior that was checked against the installed source:

- `Agent(..., output_model_schema, judge, web_search, use_vision, highlight_actions, workspace)` and
  `run(max_steps, timeout)` returning `AgentHistoryList`, with `status`, `structured_output`, `success`, `steps` and
  `partial`;
- a Pydantic AI `Model` instance is accepted as `llm`, and non-OpenAI-Responses models are called with non-streamed
  `request()`;
- the REPL tools are `python` and `finish` / `finish_from_repl`;
- progress comes from INFO lines `step N: ...` on `logging.getLogger('browser_use')`;
- `Browser('chromium', headless=True, allowed_domains=[...], block_ip_addresses=...)`, with `BH_CHROME_PATH` naming
  the binary.

To upgrade, bump the pin, then run `uv lock`, then
`uv export --frozen --no-dev --no-emit-project --format requirements-txt -o requirements.lock`, then rebuild the
image and run the Docker tests.

Known limits:

- The Debian `chromium` package version follows the bookworm archive at build time, and the base image is pinned by
  tag, not digest.
- `scripted` is a test double that grounds its candidates in a real crawl and, for the `/benchmark/` fixtures, in
  DOM heuristics written alongside their rubric. Real-model quality has not been evaluated: five bounded hosted
  smoke attempts returned no reviewable ideas.
- The job service is one replica with an in-memory registry and nonce cache: a restart forgets running jobs
  (their containers are reaped after their deadline label) and the replay window's nonces.
- **Fair admission is worker-side and single-Redis.** Workers wait for a fair turn (round robin across tenants,
  first in first out within one) at `BROWSER_USE_DISCOVERY_CAPACITY` slots (default 1, the broker's own) through Redis,
  within the run's discovery budget; a run not admitted in time records `BUSY`/`capacity_wait` and keeps the standard
  survey. Leases end by themselves after the job's budget plus 30 s, and waiters that stop polling expire after 5 s.
  The scheduler's Lua scripts read keys they do not declare, so Redis Cluster is not supported, and several broker
  replicas would need request routing and shared job and nonce state, which this pilot does not have. The broker's
  own single-slot `429` (`BUSY`/`broker_busy`) remains as a backstop.
