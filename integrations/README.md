# Integrations (V1.2)

Run a platform **suite** (saved Playwright tests, no AI) from CI or a script, and get its verdict, a job summary
and a JUnit report. Everything goes through the web app's external path, `https://<web host>/api/ext/v1/...`,
with an **API token**; the API itself stays on the private network.

## 1. Create an API token

In the web app: **Account → API tokens → New API token**, with both permissions (**Run suites**, **Read
results**). The token (`tap_…`) is shown once. It acts as you: it can run and read only the suites you can see.
Administrators can revoke anyone's under **Settings → API tokens**.

The web host CI uses must be in the web server's `WEB_ALLOWED_HOSTS`.

## 2. GitHub Actions

The action lives in this repository at `.github/actions/run-suite` (Node 24, no dependencies).

```yaml
name: Smoke tests after deploy
on:
  deployment_status:
jobs:
  smoke:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - id: suite
        uses: <owner>/<this-repo>/.github/actions/run-suite@main
        with:
          platform-url: https://tests.example.com
          api-token: ${{ secrets.PLATFORM_API_TOKEN }}
          suite: Checkout smoke
          fail-on: FAILED,BLOCKED
          junit-path: platform-junit.xml
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: platform-junit
          path: platform-junit.xml
```

| Input | Default | |
|---|---|---|
| `platform-url` | — | The web app's address |
| `api-token` | — | `tap_…`, from a secret (masked in the log) |
| `suite` | — | The suite's name (exact, any case) or id (`ste_…`) |
| `wait` | `true` | `false` only starts the run |
| `timeout-minutes` | `30` | Then the step exits; the run goes on in the platform |
| `fail-on` | `FAILED` | Verdicts that fail the step |
| `junit-path` | — | Where to write the JUnit XML |

Outputs: `suite-run-id`, `verdict`, `url`. The job summary shows the verdict, each test with a link and how it
changed since its previous run. The suite run records the repository, ref, commit and a link back to the job.

## 3. Anywhere else: the CLI

```bash
PLATFORM_API_TOKEN=tap_… node integrations/platform-client/cli.mjs run-suite \
  --url https://tests.example.com --suite "Checkout smoke" --junit junit.xml --fail-on FAILED,BLOCKED
```

Exit codes: `0` passed (or `--no-wait`), `1` a verdict in `--fail-on`, `2` usage or platform error, `3` timed out.

## The HTTP API

With `Authorization: Bearer tap_…` on `https://<web host>/api/ext`:

| Request | Permission |
|---|---|
| `GET /v1/suites?name=` | either |
| `POST /v1/suites/:suiteId/runs` `{ secrets?, credentialProfileId?, context? }` (Idempotency-Key) | Run suites |
| `POST /v1/suite-runs/:suiteRunId/cancel` | Run suites |
| `GET /v1/suite-runs/:suiteRunId`, `…/junit.xml` | Read results |
| `GET /v1/test-runs/:runId`, `…/report`, `…/report.md`, `…/comparison` | Read results |

Anything else answers `403 TOKEN_SCOPE`. A token makes at most 600 requests an hour (120 a minute per web
instance).
