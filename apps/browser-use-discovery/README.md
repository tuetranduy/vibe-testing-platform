# browser-use-discovery (fixture-only slice)

Browser Use 1.0.6 proposes functional test scenarios from one bundled, disposable fixture site. The platform
reviews and executes selected scenarios through the existing Stagehand and Playwright workflow.

## Interface (one-shot, driven by Node)

```
bin/browser-use-discovery            # no args. Node sends SIGTERM to cancel.
stdin  : {"schemaVersion":"discovery.v1","runId":"<[A-Za-z0-9_-]{1,128}>","targetUrl":"<url>"}\n
stdout : {"schemaVersion":"discovery.v1","runId":"<same>","status":"COMPLETED|PARTIAL|BLOCKED|FAILED|CANCELLED",
          "candidates":[{"title":"...","goal":"...","rationale":"...","relevantPaths":["/..."],
          "expectedBehavior":["..."],"negativeCases":[]}]}\n
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
- Wall time: the launcher bounds itself independently at 180 s (up to 45 s container/Chromium start + the 120 s
  agent budget + 15 s grace), then removes the container. The caller may stop it sooner at any time with SIGTERM
  (→ `CANCELLED`, container removed). The platform's survey gives it at most 120 s.

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
| `DISCOVERY_MODEL` | `scripted` (local and deterministic, no key, no cost) or a Pydantic AI model string such as `anthropic:claude-sonnet-5-5`. Its API key goes in the same file and stays in the host launcher. |
| `DISCOVERY_IMAGE` | Default `vtp-browser-use-discovery:1.0.6` (`--pull never`). |
| `DOCKER_HOST` | Optional, for a Docker CLI that cannot find its socket without `HOME`. |

## Run discovery from the platform

From the repository root, start the host copy of the fixture in a separate terminal.

```sh
apps/browser-use-discovery/bin/serve-fixture --port 4599
```

Add these values to the local worker environment. Append the fixture address to any existing development allowlist and use that allowlist for the API and worker.

```sh
export BROWSER_USE_DISCOVERY_LAUNCHER="$PWD/apps/browser-use-discovery/bin/browser-use-discovery"
export BROWSER_USE_DISCOVERY_FIXTURE_URL=http://127.0.0.1:4599/
export TARGET_PRIVATE_ALLOWLIST="${TARGET_PRIVATE_ALLOWLIST:+$TARGET_PRIVATE_ALLOWLIST,}127.0.0.1:4599"
```

Start or restart the local API and worker with the updated environment. Create a staging run using the exact fixture URL, select a real model for the standard survey, and leave the requirement blank. Browser Use candidates appear with the survey suggestions. The worker has up to 120 seconds for discovery, limited further by the remaining survey deadline. It keeps the original suggestions if discovery fails or times out. To disable the pilot, unset both discovery variables and restart the worker.

With the scripted discovery model configured, run the real Chromium survey and Browser Use integration test from the repository root.

```sh
pnpm test:integration tests/integration/survey-stage.test.ts
```

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
- **Grounding:** a candidate survives only if its `relevantPaths` are real fixture pages. Scenarios about logins,
  payments, deletion or security testing are dropped.

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
- `scripted` is a test double that grounds its candidates in a real crawl. Real-model quality has not been evaluated.
