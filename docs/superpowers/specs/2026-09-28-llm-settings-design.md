# AI provider settings, model and reasoning choice — design

**Date:** 2026-09-28 · **Status:** approved design (approach 1: settings in the database, each run records its
choice) · **Changes:** how the worker builds its model client (per run instead of once per process); `LLM_*`
environment variables become defaults.

## Problem

The model provider, model and Gemini thinking level come from worker environment variables (`LLM_PROVIDER`,
`LLM_MODEL`, `GEMINI_THINKING_LEVEL`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`), read once at start-up; one `LlmClient`
serves every run (`apps/worker/src/engine.ts`). Switching provider or model means editing the environment and
restarting the worker; a run cannot use a different model or reasoning level from any other; Claude's reasoning
effort cannot be set at all; and nothing records which model a run used except its per-call `llm_calls` rows.

## Goal and success criteria

- A Settings page in the web UI holds the API key of each provider (Anthropic, Gemini) and the default model and
  reasoning level for new tests.
- The new-test form can override model and reasoning for one run.
- Each run records the `{provider, model, reasoning}` it was created with; changing Settings never affects a run
  already created; the run page shows what the run uses.
- Keys are write-only: stored encrypted, never returned by any endpoint, never logged, never sent to the browser
  after entry.
- A run whose chosen provider has no key, or whose model or level is not offered, is refused at submission
  (`422`), not failed later.
- Existing deployments keep working unchanged: with nothing saved, runs use the `LLM_*` environment variables
  exactly as today (including `LLM_PROVIDER=fake`).

## Non-goals

- New providers (OpenAI, OpenAI-compatible endpoints): Anthropic and Gemini only (decision 2026-09-28).
- A "test this key" call: the API never talks to model providers (operations.md topology); a bad key surfaces as
  the run's `MODEL_PROVIDER` error.
- Per-stage model choice (one model per run), and reasoning levels above `high` (`xhigh`, `max`).
- User accounts or per-user settings: settings are per tenant (single tenant in V1, D6).
- Changing the evals and `@live` tools: they stay environment-driven (`loadLiveLlmEnv`).

## Design

### 1. Contracts — `packages/contracts/src/llm.ts` (new)

- `LlmProviderSchema = z.enum(["anthropic", "gemini", "fake"])`.
- `ReasoningLevelSchema = z.enum(["default", "minimal", "low", "medium", "high"])` — `default` sends no reasoning
  parameter (the model's own level; what every run does today).
- `LlmChoiceSchema = { provider, model: string (1–100), reasoning }` — what a run records.
- `CreateTestRunRequestSchema` gains optional `llm: { model?: string (1–100); reasoning?: ReasoningLevel }`. The
  contract checks shape only; the API checks the catalog and key availability (section 4).
- `StoredTestRunRequest` gains `llm?: LlmChoice` — the resolved choice. Optional: runs created before this change
  have none.
- `TestRunSummary` gains `llm: { provider, model, label, reasoning } | null` (`label` from the catalog at read
  time, the id itself when the model is not in the catalog; `null` for runs without a recorded choice).
- Settings schemas: `LlmDefaultsInput = { model: string; reasoning: ReasoningLevel }`; `ProviderKeyInput = { apiKey:
  string | null }` (trimmed, 1–500 characters, printable ASCII without spaces — the rule `loadEnv` applies to
  environment keys; the error never quotes the value); and the `GET` response `LlmSettingsView`:

  ```ts
  {
    defaults: { provider, model, label, reasoning, source: "settings" | "environment", available: boolean },
    providers: { provider: "anthropic" | "gemini", label, key: { source: "settings" | "environment" | null, updatedAt: IsoDateTime | null } }[],
    models: {
      provider, id, label,
      reasoningLevels: ReasoningLevel[],        // always starts with "default"
      defaultLevel: "minimal" | "low" | "medium" | "high" | null, // what "default" means, for display; null: no reasoning
      price: { inputUsdPerMTok, outputUsdPerMTok } | null,      // today's price (pricing.ts)
      available: boolean,                       // its provider has a key (fake: allowed in this deployment)
    }[],
  }
  ```

### 2. Model catalog — `packages/llm/src/catalog.ts` (new)

Plain data next to `pricing.ts`; a test requires every entry to have a price. Levels from the providers' docs
(Anthropic effort levels; Google's thinking-level table, checked 2026-09-28):

| Provider | Id | Label | Levels (after `default`) | `default` means | Refusal fallback |
|---|---|---|---|---|---|
| anthropic | `claude-fable-5-1` | Claude Fable 5.1 | low, medium, high | high | yes |
| anthropic | `claude-opus-5-5` | Claude Opus 5.5 | low, medium, high | medium | yes |
| anthropic | `claude-sonnet-5` | Claude Sonnet 5 (default) | low, medium, high | high | no |
| anthropic | `claude-haiku-4-5` | Claude Haiku 4.5 | — | no reasoning | no |
| gemini | `gemini-3.8-flash` | Gemini 3.8 Flash (default) | low, medium, high | medium | — |
| gemini | `gemini-3.5-flash` | Gemini 3.5 Flash | minimal, low, medium, high | medium | — |
| gemini | `gemini-3.5-flash-lite` | Gemini 3.5 Flash-Lite | minimal, low, medium, high | minimal | — |
| gemini | `gemini-3.1-pro-preview` | Gemini 3.1 Pro (preview) | low, medium, high | high | — |
| fake | `fake` | Fake engine (development) | — | — | — |

The `fake` entry is offered only when `NODE_ENV` is not `production` (the environment already forbids the fake
provider in production). The provider defaults (`defaultLlmModel`) stay `claude-sonnet-5` and `gemini-3.8-flash`.

### 3. Storage — `packages/db`

- `llm_settings`: `tenant_id` (PK, → tenants), `default_model`, `default_reasoning`, `updated_at`. No row: the
  defaults come from the environment.
- `llm_provider_keys`: `tenant_id`, `provider` (PK together), `ciphertext`, `iv`, `auth_tag` (bytea), `updated_at`.
  Encrypted with `SECRETS_ENCRYPTION_KEY`, AES-256-GCM as run secrets, through new `encryptProviderKey` /
  `decryptProviderKey` in `packages/security/src/secret-vault.ts` whose AAD is `["llm-provider-key", tenantId,
  provider]` (a three-element tag, so it can never equal a run secret's `[runId, name]`).
- Repositories: `LlmSettingsRepository` (get / upsert defaults) and `ProviderKeyRepository` (status without
  values; set; remove; `getEncrypted` for the worker only). One SQL migration (`0001_…`, generated from `schema.ts`).

### 4. API — `apps/api`

All under the bearer-protected `/v1`, and added to the web proxy's allow-list (`apps/web/lib/proxy.ts`).

- `GET /v1/settings/llm` → `LlmSettingsView`. Key status only: `source` is `settings` when a row exists, else
  `environment` when the API's own `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` is set (the API and the worker share the
  `LLM_*` environment, as compose's `x-app-env` does), else `null`.
- `PUT /v1/settings/llm` with `{ defaults: LlmDefaultsInput }` → the model must be in the catalog and `available`,
  and the level one of its `reasoningLevels`; else `422 MODEL_NOT_AVAILABLE` with an `issues` path. Returns the view.
- `PUT /v1/settings/llm/keys/:provider` (`anthropic` | `gemini`, else 404) with `ProviderKeyInput` → encrypts and
  saves, or removes the saved key when `apiKey` is `null`. `400 VALIDATION_FAILED` for a malformed key (message
  without the value). Returns the view. Removing the key the saved defaults rely on is allowed; the view then
  shows `defaults.available: false` and new runs on them get `422` until fixed.
- Every settings change writes an audit log line (`settings.llm.defaults_saved`, `settings.llm.key_saved`,
  `settings.llm.key_removed`, with provider and model, never the key). The redactor already masks `apiKey` and
  `ANTHROPIC_API_KEY`-style fields (its `apikey` suffix rule); a test pins that.
- **Run creation** (`TestRunService.create`) resolves the run's choice, in order: the request's `llm.model` (must be
  in the catalog and `available`; its provider from the catalog) with `llm.reasoning` (default `default`; must be
  one of the model's levels); else the saved defaults (`llm.reasoning` alone may override their level when the
  default model supports it); else the environment defaults: `LLM_PROVIDER`, `LLM_MODEL` (or `defaultLlmModel`),
  reasoning `GEMINI_THINKING_LEVEL` for gemini, else `default`. An environment model outside the catalog is
  accepted as configured by the operator (today's behaviour), but the form and Settings offer only catalog models.
  The chosen provider needs a key (settings or environment; none for `fake`), else `422 MODEL_NOT_AVAILABLE` with
  the path `["llm", "model"]` (or `["llm"]` when the defaults are at fault) and a message naming the fix ("Add an
  Anthropic API key in Settings"). The resolved choice is stored as `request.llm`. The idempotency hash stays over
  the request as sent (its `llm` override included), so a retry after Settings changed still replays the original
  run.

### 5. Worker — `apps/worker`, `packages/llm`, `packages/testing-engine`, `packages/stagehand-adapter`

- **Both engines, chosen per run.** The worker builds the fake stages and the real stages at start-up (the real
  engine's browser and runner preflights now always run; they stay non-fatal). A run whose choice has provider
  `fake` runs the fake stages; any other runs the real ones. Runs without a recorded choice use the environment
  defaults, resolved by the same function as the API (exported from `@platform/config`). `WorkerDeps.stages`
  becomes a per-run lookup; `LLM_PROVIDER=openai` still stops the worker at start-up.
- **One model client per run.** `createRunContext` builds the run's `LlmClient` from its choice: the saved key
  (decrypted with `decryptProviderKey`) or else the environment key; the transport from `createTransport({ provider,
  apiKey })`, or the injected test transport (the E2E scripted model keeps working). `StageContext` gains `llm`;
  the analyze, plan and report stages and the explore stage's Stagehand bridge use it instead of a client captured
  at start-up. Failures before any model call end the run `ERRORED / MODEL_PROVIDER` with a template message: "No
  API key for Anthropic: add one in Settings", or "The saved Anthropic key can't be read (was
  SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings".
- **Reasoning reaches the provider per request.** `LlmTransportRequest` gains `reasoning: ReasoningLevel`;
  `LlmClient` takes a default `reasoning` and `LlmCallInput` may override it per call. Anthropic: `low` / `medium` /
  `high` → `output_config.effort` (sent next to `output_config.format`); `default` → no effort. Gemini: every level
  but `default` → `generationConfig.thinkingConfig.thinkingLevel` (upper-case, as today). The Gemini transport's
  constructor-level `thinkingLevel` goes away; the evals and `@live` tools pass `GEMINI_THINKING_LEVEL` as the
  client's reasoning instead.
- **Browser steps keep the model's default level.** The run's level applies to requirement analysis, planning and
  report diagnostics (and, later, sub-project C's page survey). The Stagehand bridge's calls always use `default`:
  each browser step has a 60 s limit and runs many times, so a higher level would slow every step and a lower one
  would change exploration quality the evals have not measured. Browsing therefore behaves as today whatever the
  run's level.
- **Refusal fallback on Claude Fable 5.1 and Opus 5.5.** For catalog models marked "refusal fallback", the
  Anthropic transport sends the request through the SDK's beta messages API with `fallbacks: "default"` (beta
  `server-side-fallback-2026-07-01`): a request the model's safety classifiers decline is retried by the API on the
  model Anthropic recommends, instead of ending the run. The transport reports the serving model when a fallback
  answered (a `fallback` content block / a `fallback_message` usage iteration); `LlmClient` then prices and records
  that call under the serving model (otherwise under the requested one, as today). A refusal that no fallback
  rescued stays a non-retryable provider error, as today.

### 6. Environment — `packages/config`

- `loadEnv` no longer requires `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` for `LLM_PROVIDER=anthropic` / `gemini`
  (Settings may hold the key); a key that is set is still checked (printable ASCII, no spaces), and a `LLM_MODEL` of
  the other provider is still rejected. `loadLiveLlmEnv` is unchanged.
- `LLM_PROVIDER`, `LLM_MODEL` and `GEMINI_THINKING_LEVEL` are documented as the defaults used when Settings hold
  none.

### 7. Web UI — `apps/web`

**Settings page** (`app/settings/page.tsx`; "Settings" link in `AppNav` between "Test runs" and "New test"):

- **AI providers** — one card per provider: status ("Key saved · updated `<when>`", "Using the server's key
  (`ANTHROPIC_API_KEY`)", or "No key"); an "API key" password field (`autocomplete="off"`) with "Save key"; "Remove
  saved key" (with an inline confirmation) when the key comes from Settings. The field is cleared as soon as the
  request is sent, whatever the answer (as secrets are on the new-test form); errors show on the field.
- **Defaults for new tests** — "Model": a select grouped by provider (Anthropic, Google Gemini, and Development
  when the fake engine is offered); models of a provider without a key are disabled and labelled "add a key". The
  price per million tokens of the selected model shows under it. "Reasoning": the selected model's levels, the
  first reading "Model default (`<defaultLevel>`)". "Save defaults". When the defaults come from the environment,
  a note says so; when they are unavailable (key removed), a warning says new tests will be refused until fixed.

**New-test form** (`components/NewTestForm.tsx`), Advanced options: "Model" (first option "Default — `<label>`",
then the grouped catalog, unavailable models disabled) and "Reasoning" (first option "Default"; after a model is
chosen, that model's levels). The body carries `llm` only for what was changed. The catalog comes from `GET
/v1/settings/llm` on load; if that fails, the two selects are replaced by "Model choices couldn't be loaded; the
default model will be used." A `422 MODEL_NOT_AVAILABLE` lands on the Model field (or as a banner naming Settings
when the defaults are at fault). The Advanced options summary adds the model label when overridden.

**Run page** (`components/RunView.tsx`): a meta chip with `summary.llm` — "Claude Sonnet 5 · medium reasoning", or
"Claude Sonnet 5 · model default"; the report's cost card repeats it. Nothing for runs without a recorded choice.

### 8. Unchanged

The run lifecycle, events, criteria, planner prompts, verifier, compiler, rerun and reconciliation. `llm_calls`
keeps its columns (it already records provider and model per call). Metrics keep their labels.

## Testing

- **Contracts:** the new schemas; `CreateTestRunRequestSchema` with and without `llm`; `ProviderKeyInput` rejects
  spaces and non-ASCII without echoing the value.
- **LLM:** every catalog entry priced; Anthropic transport sends `output_config.effort` for low/medium/high and
  nothing for `default`, alongside the format; uses beta messages with `fallbacks: "default"` only for
  fallback-marked models and reports the serving model after a fallback; Gemini maps each level and omits
  `thinkingConfig` for `default`; `LlmClient` passes its default reasoning, honours a per-call override, and prices
  a fallback-served call under the serving model.
- **Security / DB:** provider-key encrypt/decrypt round trip; decryption fails for another tenant, another provider,
  or a run-secret AAD; repositories never return plaintext; migration applies on the test template.
- **API:** settings `GET` never contains a key (asserted on the raw body for a saved and an environment key);
  key `PUT` set / replace / remove / malformed / unknown provider; defaults `PUT` validation; audit lines carry no key;
  run creation resolution order (request → settings → environment), `422` cases (no key, unknown model, unsupported
  level, removed key behind saved defaults, fake in production); `request.llm` stored; summary `llm`.
- **Worker:** per-run engine choice (fake / real) and per-run client (provider, model, reasoning from the run; old
  runs from the environment); the Stagehand bridge uses `default`; missing key and undecryptable key end the run
  `ERRORED / MODEL_PROVIDER` with the template messages; the injected test transport is still used.
- **Web:** Settings page (statuses, save / remove key with the field cleared, defaults with grouped and disabled
  options, levels following the model, price line, environment and unavailable notes); new-test form overrides
  (body contains only what changed; catalog load failure; `422` on the field); the run-page chip.
- **E2E** (CI mode, a new `platform-settings.spec.ts`): before any Gemini key exists, a run naming a Gemini model →
  `422 MODEL_NOT_AVAILABLE`; then save a Gemini key through the settings API and start a run with that override →
  the run records it, its `llm_calls` rows carry that model, the settings `GET` never contains the key, and the
  key's plaintext appears in no database row, event or log (the forms `platform-blocked` checks for secrets).
- **Suites:** contracts, config, security, llm, db, api, worker, testing-engine, stagehand-adapter and web green;
  root typecheck; `pnpm test:e2e`.

## Docs

- README: a "Settings" subsection (keys, defaults, per-run choice, precedence over the environment); the
  environment section describes `LLM_*` as defaults; "Deviations from the plan": the model client is built per run.
- `.env.example`: the provider keys are optional (Settings can hold them).
- `docs/operations.md`: the database now holds provider keys (encrypted, long-lived); the `SECRETS_ENCRYPTION_KEY`
  rotation section gains "after rotating, re-enter the provider keys in Settings" (their runs otherwise fail with
  the "can't be read" message).

## Risks

- Keys in the database widen what a database compromise exposes; they are encrypted with the same key as run
  secrets, which lives only in the api and worker environment. The UI is for a trusted team (decision 2026-09-28);
  anyone who can reach it can replace keys and choose expensive models.
- The API's view of environment keys assumes the API and the worker share the `LLM_*` environment. If they differ,
  a run can pass the check and then fail with `MODEL_PROVIDER`. Documented; Settings avoid it.
- Reasoning levels are provider- and model-specific and change over time; the catalog pins them and is tested for
  prices only. A level a model stops accepting fails its first call (non-retryable), as `GEMINI_THINKING_LEVEL`
  does today.
- Fallback-served calls run on another model: results stay evidence-based (D2), and the recorded model and cost
  follow the serving model.
