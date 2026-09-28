# AI Provider Settings, Model and Reasoning Choice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provider API keys and the default model / reasoning level live in a Settings page, each new test may pick its own model and level, every run records the `{provider, model, reasoning}` it was created with, and the worker builds one model client per run from that record.

**Architecture:** `@platform/contracts` gains the choice and settings schemas; `@platform/llm` gains a plain-data model catalog, a per-request reasoning level (Anthropic `output_config.effort`, Gemini `thinkingLevel`) and Anthropic's server-side refusal fallback. The API stores keys encrypted (`encryptProviderKey`, AAD `["llm-provider-key", tenantId, provider]`) and the defaults in two new tables, resolves each new run's choice (request → Settings → environment) and refuses an unusable one with `422 MODEL_NOT_AVAILABLE`; the worker builds both engines once and, per run, a `LlmClient` from `request.llm` (or the environment's choice for older runs), which reaches every real stage as `StageContext.llm`.

**Tech Stack:** TypeScript, Zod 4 (`@platform/contracts`), `@anthropic-ai/sdk` 0.128.0 (beta Messages API), Gemini Developer API over `fetch`, Drizzle + PostgreSQL (drizzle-kit migrations), Fastify (tests with `app.inject` against real Postgres), BullMQ worker, Next.js 16 / React 19 (Vitest + jsdom + Testing Library), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-28-llm-settings-design.md` — read it before any task.

**Branch:** `feat/llm-settings` (stacked on `feat/production-destructive-actions`; A's changes are present).

A's code (spec `2026-09-28-production-destructive-actions-design.md`) touches some of the same files: `packages/contracts/src/run.ts` (`confirmProductionHost`, `destructiveActionsAllowed`, `TestRunSummary.environment` / `allowDestructiveActions`), `packages/db/src/run-repository.ts` (`toRunSummary`), `packages/stagehand-adapter/src/browser-explorer.ts` and `stagehand-explorer.ts` (`allowDestructive`), `packages/testing-engine/src/exploration/explore-stage.ts`, the planner and its tests, `apps/web/components/NewTestForm.tsx`, `RunView.tsx` and `apps/web/test/fixtures.ts`. Every edit below anchors on lines A does not change and says where A's additions sit; keep A's code exactly as it is. The diff blocks in this plan show line numbers from before A: apply them by their context lines.

## Global Constraints

- Contracts (fixed names): `LlmProviderSchema = z.enum(["anthropic", "gemini", "fake"])`; `ReasoningLevelSchema = z.enum(["default", "minimal", "low", "medium", "high"])` — `default` sends no reasoning parameter (the model's own level); `LlmChoiceSchema = z.object({ provider: LlmProviderSchema, model: z.string().min(1).max(100), reasoning: ReasoningLevelSchema })`; `StoredTestRunRequest` gains `llm?: LlmChoice` (absent on runs created before this change); `TestRunSummarySchema` gains `llm: z.object({ provider: LlmProviderSchema, model: z.string(), label: z.string(), reasoning: ReasoningLevelSchema }).nullable()`.
- The catalog (`packages/llm/src/catalog.ts`), verbatim from the spec — id / label / levels after `default` / what `default` means / refusal fallback:
  `claude-fable-5-1` Claude Fable 5.1 / low, medium, high / high / yes · `claude-opus-5-5` Claude Opus 5.5 / low, medium, high / medium / yes · `claude-sonnet-5` Claude Sonnet 5 / low, medium, high / high / no · `claude-haiku-4-5` Claude Haiku 4.5 / — / no reasoning / no · `gemini-3.8-flash` Gemini 3.8 Flash / low, medium, high / medium · `gemini-3.5-flash` Gemini 3.5 Flash / minimal, low, medium, high / medium · `gemini-3.5-flash-lite` Gemini 3.5 Flash-Lite / minimal, low, medium, high / minimal · `gemini-3.1-pro-preview` Gemini 3.1 Pro (preview) / low, medium, high / high · `fake` Fake engine (development) / — / — / —.
- The `fake` entry is offered only when `NODE_ENV` is not `production`. The provider defaults (`defaultLlmModel`) stay `claude-sonnet-5` and `gemini-3.8-flash`.
- Storage: `llm_settings` (`tenant_id` PK → tenants, `default_model`, `default_reasoning`, `updated_at`; no row: the defaults come from the environment) and `llm_provider_keys` (`tenant_id`, `provider` PK together, `ciphertext`, `iv`, `auth_tag` bytea, `updated_at`), AES-256-GCM with `SECRETS_ENCRYPTION_KEY` through `encryptProviderKey` / `decryptProviderKey`, AAD `["llm-provider-key", tenantId, provider]`. One migration: `packages/db/migrations/0001_llm_settings.sql`, generated with `pnpm --filter @platform/db exec drizzle-kit generate --name llm_settings` (sub-project C adds 0002).
- API (bearer-protected `/v1`, added to `apps/web/lib/proxy.ts`): `GET /v1/settings/llm` → `LlmSettingsView`; `PUT /v1/settings/llm` with `{ defaults: { model, reasoning } }`; `PUT /v1/settings/llm/keys/:provider` (`anthropic` | `gemini`, else 404) with `{ apiKey: string | null }` (`null` removes). Keys are write-only: never returned, logged or sent to the browser after entry.
- Key rule: "trimmed, 1–500 characters, printable ASCII without spaces" (the rule `loadEnv` applies to environment keys); no error message quotes the value. A malformed key → `400 VALIDATION_FAILED`.
- `422 MODEL_NOT_AVAILABLE` with an `issues` path: `["llm", "model"]` / `["llm", "reasoning"]` for a request's own fields, `["llm"]` when the defaults are at fault, `["defaults", "model"]` / `["defaults", "reasoning"]` for the settings `PUT`; the message names the fix: "Add an Anthropic API key in Settings" (Gemini: "Add a Google Gemini API key in Settings").
- Audit lines: `settings.llm.defaults_saved`, `settings.llm.key_saved`, `settings.llm.key_removed`, with provider (and model), never the key.
- Run creation resolves, in order: the request's `llm.model` (catalog, available; `llm.reasoning` default `default`, one of the model's levels) → the saved defaults (`llm.reasoning` alone may override their level when their model takes it) → the environment (`LLM_PROVIDER`, `LLM_MODEL` or `defaultLlmModel`, reasoning `GEMINI_THINKING_LEVEL` for gemini else `default`; a model outside the catalog is accepted). The resolved choice is stored as `request.llm`; the idempotency hash stays over the request as sent.
- Worker template messages (`ERRORED / MODEL_PROVIDER`): "No API key for Anthropic: add one in Settings", "The saved Anthropic key can't be read (was SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings" (Gemini: "Google Gemini" in place of "Anthropic").
- Anthropic: `low` / `medium` / `high` → `output_config.effort`, sent next to `output_config.format`; `default` → no effort. Gemini: every level but `default` → `generationConfig.thinkingConfig.thinkingLevel` (upper-case); `default` → no `thinkingConfig`.
- Refusal fallback: only for catalog models with `refusalFallback`, the SDK's beta Messages API with `fallbacks: "default"` and `betas: ["server-side-fallback-2026-07-01"]`; a fallback-served call is priced and recorded under the serving model; a refusal no fallback rescued stays a non-retryable provider error.
- The Stagehand bridge always sends reasoning `default`. `LLM_PROVIDER=openai` still stops the worker at start-up. The E2E scripted transport (`BootOptions.engine.transport`) serves every run.
- UI strings (verbatim): "Settings"; "AI providers"; "Key saved · updated `<when>`"; "Using the server's key (`ANTHROPIC_API_KEY`)"; "No key"; "API key" (password, `autocomplete="off"`); "Save key"; "Remove saved key"; "Defaults for new tests"; "Model"; "add a key"; "Reasoning" (first option "Model default (`<defaultLevel>`)"); "Save defaults"; new-test form: "Default — `<label>`", "Default", "Model choices couldn't be loaded; the default model will be used."; run chip "Claude Sonnet 5 · medium reasoning" / "Claude Sonnet 5 · model default".
- Unchanged: the run lifecycle, events, criteria, planner prompts, verifier, compiler, rerun, reconciliation, `llm_calls` columns and metric labels. The evals and `@live` tools stay environment-driven (`loadLiveLlmEnv`).
- Toolchain: run `export PATH=$HOME/.config/nvm/versions/node/v24.15.0/bin:/opt/homebrew/bin:$PATH` before any pnpm command (the shell's default Node 22.13 is below `engines` and its corepack pnpm is broken).
- Infrastructure (Postgres, Redis, S3, demo shop) runs in docker compose (`pnpm infra:up`); the full compose stack may be running — never stop, restart or kill the user's compose containers or `pnpm dev` processes. DB tests use `TEST_DATABASE_URL` (compose Postgres); Redis tests use DB 15; E2E uses Redis DB 14.
- TDD: write the failing test, watch it fail, implement, watch it pass.
- Commits: conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`); every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never stage `Claude outputs/`.
- Per-package tests: `pnpm --filter <package> exec vitest run <path>`; whole repo typecheck: `pnpm typecheck`.

## Review Focus

1. **A key pasted with surrounding whitespace or a trailing newline** (password managers, terminal copies) — saved trimmed, and the trimmed key is what the provider receives (an environment key too). Pinned in Task 7 ("saves a key encrypted and trimmed") and Task 10 ("without a saved key, the environment's (trimmed)").
2. **A run created before this change that is confirmed (or still queued) after the deploy, while Settings already hold other defaults** — it runs on the environment's choice, never on the saved defaults, so analysis and execution use one model. Pinned in Task 10 ("a run without a recorded choice … never the defaults saved in Settings").
3. **An environment model outside the catalog** (e.g. `LLM_MODEL=claude-opus-5`) — the view shows it by id and `available: true`, runs are accepted on it, a reasoning override other than `default` is refused, and the Settings select asks the user to choose a model instead of preselecting a wrong one. Pinned in Task 7 (view and `resolveRunLlm`) and Task 11 ("an environment model outside the catalog is not preselected").
4. **A retry with the same `Idempotency-Key` after the provider's key was removed** (the first answer was lost) — `202` replaying the original run, not `422`; the same key with a different `llm` override → `409`. Pinned in Task 8.
5. **A key save that never reaches the server** (network failure) — the field is still cleared and the error shows on it, so no key lingers in the page. Pinned in Task 11 ("a request that never reaches the server still clears the field").

---

### Task 1: Contracts — model choice and settings schemas

**Files:**
- Create: `packages/contracts/src/llm.ts`
- Create: `packages/contracts/src/llm.test.ts`
- Modify: `packages/contracts/src/index.ts` (export `./llm` before `./run`)
- Modify: `packages/contracts/src/run.ts` (`StoredTestRunRequest.llm`)

**Interfaces:**
- Produces (from `@platform/contracts`): `LlmProviderSchema` / `LlmProvider` (`"anthropic" | "gemini" | "fake"`), `LlmKeyProviderSchema` / `LlmKeyProvider` (`"anthropic" | "gemini"`), `ReasoningLevelSchema` / `ReasoningLevel`, `LlmChoiceSchema` / `LlmChoice`, `LlmOverrideSchema` / `LlmOverride` (`{ model?: string; reasoning?: ReasoningLevel }`), `LlmDefaultsInputSchema` / `LlmDefaultsInput` (`{ model: string; reasoning: ReasoningLevel }`), `UpdateLlmSettingsRequestSchema` / `UpdateLlmSettingsRequest` (`{ defaults: LlmDefaultsInput }`), `ProviderKeyInputSchema` / `ProviderKeyInput` (`{ apiKey: string | null }`), `LlmSettingsViewSchema` / `LlmSettingsView`; `StoredTestRunRequest` gains `llm?: LlmChoice`.

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/llm.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  LlmChoiceSchema,
  LlmDefaultsInputSchema,
  LlmKeyProviderSchema,
  LlmOverrideSchema,
  LlmProviderSchema,
  LlmSettingsViewSchema,
  ProviderKeyInputSchema,
  ReasoningLevelSchema,
  UpdateLlmSettingsRequestSchema,
  type LlmSettingsView,
  type StoredTestRunRequest,
} from "./index";

describe("LLM choice contracts", () => {
  it("names the providers, the providers that take a key, and the reasoning levels", () => {
    expect(LlmProviderSchema.options).toEqual(["anthropic", "gemini", "fake"]);
    expect(LlmKeyProviderSchema.options).toEqual(["anthropic", "gemini"]);
    expect(ReasoningLevelSchema.options).toEqual(["default", "minimal", "low", "medium", "high"]);
  });

  it("a run's choice is a provider, a model id of 1–100 characters and a level", () => {
    const choice = { provider: "anthropic", model: "claude-sonnet-5", reasoning: "medium" } as const;
    expect(LlmChoiceSchema.parse(choice)).toEqual(choice);
    expect(LlmChoiceSchema.safeParse({ ...choice, provider: "openai" }).success).toBe(false);
    expect(LlmChoiceSchema.safeParse({ ...choice, model: "" }).success).toBe(false);
    expect(LlmChoiceSchema.safeParse({ ...choice, model: "m".repeat(101) }).success).toBe(false);
    expect(LlmChoiceSchema.safeParse({ ...choice, reasoning: "xhigh" }).success).toBe(false);
  });

  it("a stored request may carry the resolved choice, or none (runs created before model choice)", () => {
    const withChoice: Pick<StoredTestRunRequest, "llm"> = { llm: { provider: "gemini", model: "gemini-3.8-flash", reasoning: "low" } };
    const without: Pick<StoredTestRunRequest, "llm"> = {};
    expect(withChoice.llm?.provider).toBe("gemini");
    expect(without.llm).toBeUndefined();
  });

  it("an override names a model, a level, both or neither (the API checks the catalog)", () => {
    expect(LlmOverrideSchema.parse({})).toEqual({});
    expect(LlmOverrideSchema.parse({ reasoning: "high" })).toEqual({ reasoning: "high" });
    expect(LlmOverrideSchema.parse({ model: "not-in-any-catalog" })).toEqual({ model: "not-in-any-catalog" });
    expect(LlmOverrideSchema.safeParse({ model: "" }).success).toBe(false);
    expect(LlmOverrideSchema.safeParse({ reasoning: "max" }).success).toBe(false);
  });

  it("the defaults input and the settings PUT body", () => {
    expect(UpdateLlmSettingsRequestSchema.parse({ defaults: { model: "claude-opus-5-5", reasoning: "low" } })).toEqual({
      defaults: { model: "claude-opus-5-5", reasoning: "low" },
    });
    expect(LlmDefaultsInputSchema.safeParse({ model: "claude-opus-5-5" }).success).toBe(false);
    expect(UpdateLlmSettingsRequestSchema.safeParse({ model: "claude-opus-5-5", reasoning: "low" }).success).toBe(false);
  });
});

describe("ProviderKeyInputSchema", () => {
  it("trims a key, and takes null to remove the saved one", () => {
    expect(ProviderKeyInputSchema.parse({ apiKey: "  sk-ant-api03-abc_DEF-123  " })).toEqual({ apiKey: "sk-ant-api03-abc_DEF-123" });
    expect(ProviderKeyInputSchema.parse({ apiKey: null })).toEqual({ apiKey: null });
    expect(ProviderKeyInputSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ["an inner space", "sk-ant secret-part"],
    ["a non-ASCII character", "gm-schlüssel-geheim"],
    ["a tab", "sk-ant\tsecret-part"],
    ["a line break", "sk-ant\nsecret-part"],
    ["only whitespace", "   "],
    ["more than 500 characters", `sk-${"x".repeat(498)}`],
  ])("rejects a key with %s, and no issue repeats the value", (_what, apiKey) => {
    const r = ProviderKeyInputSchema.safeParse({ apiKey });
    expect(r.success).toBe(false);
    const text = `${JSON.stringify(r.error!.issues)} ${r.error!.message}`;
    expect(text).not.toContain("secret-part");
    expect(text).not.toContain("geheim");
    expect(text).not.toContain("xxxxxxxxxx");
    for (const issue of r.error!.issues) expect(issue.path).toEqual(["apiKey"]);
  });
});

describe("LlmSettingsViewSchema", () => {
  const view: LlmSettingsView = {
    defaults: { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "default", source: "environment", available: true },
    providers: [
      { provider: "anthropic", label: "Anthropic", key: { source: "environment", updatedAt: null } },
      { provider: "gemini", label: "Google Gemini", key: { source: "settings", updatedAt: "2026-09-28T10:00:00.000Z" } },
    ],
    models: [
      {
        provider: "anthropic",
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        reasoningLevels: ["default", "low", "medium", "high"],
        defaultLevel: "high",
        price: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
        available: true,
      },
      { provider: "fake", id: "fake", label: "Fake engine (development)", reasoningLevels: ["default"], defaultLevel: null, price: null, available: true },
    ],
  };

  it("parses a view", () => {
    expect(LlmSettingsViewSchema.parse(view)).toEqual(view);
  });

  it("has no field that could hold a key", () => {
    expect(Object.keys(LlmSettingsViewSchema.shape.providers.element.shape.key.shape)).toEqual(["source", "updatedAt"]);
    const strict = LlmSettingsViewSchema.parse({ ...view, providers: [{ ...view.providers[0]!, key: { ...view.providers[0]!.key, apiKey: "sk-ant-leak" } }] });
    expect(JSON.stringify(strict)).not.toContain("sk-ant-leak");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @platform/contracts exec vitest run src/llm.test.ts`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'options')` (nothing is exported yet).

- [ ] **Step 3: Create `packages/contracts/src/llm.ts`**

```ts
import { z } from "zod";
import { IsoDateTime } from "./common";

/** Model providers. `fake` is the deterministic fake engine (never in production). */
export const LlmProviderSchema = z.enum(["anthropic", "gemini", "fake"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

/** The providers that take an API key (Settings → AI providers). */
export const LlmKeyProviderSchema = z.enum(["anthropic", "gemini"]);
export type LlmKeyProvider = z.infer<typeof LlmKeyProviderSchema>;

/** `default` sends no reasoning parameter: the model's own level (what every run did before). */
export const ReasoningLevelSchema = z.enum(["default", "minimal", "low", "medium", "high"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/** The model a run uses, as it records it (`StoredTestRunRequest.llm`). */
export const LlmChoiceSchema = z.object({
  provider: LlmProviderSchema,
  model: z.string().min(1).max(100),
  reasoning: ReasoningLevelSchema,
});
export type LlmChoice = z.infer<typeof LlmChoiceSchema>;

/**
 * A new run's model override (`CreateTestRunRequest.llm`): shape only. The API checks the catalog and the
 * provider's key when it resolves the run's choice.
 */
export const LlmOverrideSchema = z.object({
  model: z.string().min(1).max(100).optional(),
  reasoning: ReasoningLevelSchema.optional(),
});
export type LlmOverride = z.infer<typeof LlmOverrideSchema>;

/** Settings → Defaults for new tests. */
export const LlmDefaultsInputSchema = z.object({
  model: z.string().min(1).max(100),
  reasoning: ReasoningLevelSchema,
});
export type LlmDefaultsInput = z.infer<typeof LlmDefaultsInputSchema>;

/** `PUT /v1/settings/llm` body. */
export const UpdateLlmSettingsRequestSchema = z.object({ defaults: LlmDefaultsInputSchema });
export type UpdateLlmSettingsRequest = z.infer<typeof UpdateLlmSettingsRequestSchema>;

/**
 * `PUT /v1/settings/llm/keys/:provider` body. `null` removes the saved key. A key is trimmed, 1–500 characters,
 * printable ASCII without spaces (the rule loadEnv applies to environment keys). No message quotes the value.
 */
export const ProviderKeyInputSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(1, "Enter the API key")
    .max(500, "An API key has at most 500 characters")
    .regex(/^[\x21-\x7e]+$/, "An API key is one line of printable ASCII characters without spaces")
    .nullable(),
});
export type ProviderKeyInput = z.infer<typeof ProviderKeyInputSchema>;

const SettingSourceSchema = z.enum(["settings", "environment"]);

/** `GET /v1/settings/llm` (and the answer of every settings `PUT`). Never contains a key. */
export const LlmSettingsViewSchema = z.object({
  defaults: z.object({
    provider: LlmProviderSchema,
    model: z.string(),
    label: z.string(),
    reasoning: ReasoningLevelSchema,
    source: SettingSourceSchema,
    /** False when new runs on these defaults would be refused (e.g. their provider's key was removed). */
    available: z.boolean(),
  }),
  providers: z.array(
    z.object({
      provider: LlmKeyProviderSchema,
      label: z.string(),
      key: z.object({ source: SettingSourceSchema.nullable(), updatedAt: IsoDateTime.nullable() }),
    }),
  ),
  models: z.array(
    z.object({
      provider: LlmProviderSchema,
      id: z.string(),
      label: z.string(),
      /** Always starts with "default". */
      reasoningLevels: z.array(ReasoningLevelSchema),
      /** What "default" means, for display; null: the model does not reason. */
      defaultLevel: z.enum(["minimal", "low", "medium", "high"]).nullable(),
      /** Today's list price (USD per million tokens); null when unknown. */
      price: z.object({ inputUsdPerMTok: z.number(), outputUsdPerMTok: z.number() }).nullable(),
      /** Its provider has a key (the fake engine: offered in this deployment). */
      available: z.boolean(),
    }),
  ),
});
export type LlmSettingsView = z.infer<typeof LlmSettingsViewSchema>;
```

- [ ] **Step 4: Export it and let a stored request carry the choice**

In `packages/contracts/src/index.ts` replace `export * from "./run";` with:

```ts
export * from "./llm";
export * from "./run";
```

In `packages/contracts/src/run.ts`, add this line right after the existing `import { DataKeySchema, HostnameSchema, HttpUrlSchema, IsoDateTime, SecretNameSchema } from "./common";` (A does not change that import):

```ts
import type { LlmChoice } from "./llm";
```

and replace the `StoredTestRunRequest` declaration (A does not change it):

```ts
/** The request as persisted: never contains secret values, only their names. */
export type StoredTestRunRequest = Omit<CreateTestRunRequest, "secrets"> & { secretNames: string[] };
```

with:

```ts
/** The request as persisted: never contains secret values, only their names. */
export type StoredTestRunRequest = Omit<CreateTestRunRequest, "secrets" | "llm"> & {
  secretNames: string[];
  /**
   * The model the run uses, resolved when it was created (request override → Settings → environment).
   * Absent on runs created before model choice existed: they use the environment's (resolveEnvLlmChoice).
   */
  llm?: LlmChoice;
};
```

(`"llm"` is omitted from `CreateTestRunRequest` because Task 8 gives the create request its own `llm` override, which is not what a run stores.)

- [ ] **Step 5: Run the contracts tests and the typecheck**

Run: `pnpm --filter @platform/contracts test && pnpm typecheck`
Expected: PASS (the new file's 14 tests and every existing test; the repo typechecks: the new field is optional).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/llm.ts packages/contracts/src/llm.test.ts packages/contracts/src/index.ts packages/contracts/src/run.ts
git commit -m "feat: contracts for model choice and AI provider settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Config — provider keys optional; the environment's model choice

**Files:**
- Create: `packages/config/src/llm-choice.ts`
- Create: `packages/config/src/llm-choice.test.ts`
- Modify: `packages/config/src/env.ts` (`checkLlmSettings`, lines 31–57)
- Modify: `packages/config/src/env.test.ts` (lines 85–96; one new test after line 131)
- Modify: `packages/config/src/index.ts`, `packages/config/package.json` (+ `@platform/contracts`), `pnpm-lock.yaml`
- Modify: `.env.example` (LLM section)

**Interfaces:**
- Consumes: `LlmChoiceSchema`, `LlmProviderSchema`, `ReasoningLevelSchema`, `LlmChoice` (Task 1).
- Produces (from `@platform/config`): `resolveEnvLlmChoice(env: { LLM_PROVIDER: string; LLM_MODEL?: string; GEMINI_THINKING_LEVEL?: string }): LlmChoice` — throws `Error("LLM_PROVIDER=openai is not implemented in V1 (use anthropic, gemini or fake)")` for any provider outside `LlmProviderSchema`; `EnvLlmSettings` (its parameter type). `loadEnv` no longer requires `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`.

- [ ] **Step 1: Write the failing tests**

`packages/config/src/llm-choice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadEnv, loadLiveLlmEnv } from "./env";
import { resolveEnvLlmChoice } from "./llm-choice";

describe("resolveEnvLlmChoice (the defaults when Settings hold none)", () => {
  it("anthropic: LLM_MODEL, else the provider's default model; reasoning default", () => {
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-opus-5-5" })).toEqual({ provider: "anthropic", model: "claude-opus-5-5", reasoning: "default" });
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "anthropic" })).toEqual({ provider: "anthropic", model: "claude-sonnet-5", reasoning: "default" });
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "anthropic", LLM_MODEL: "" })).toMatchObject({ model: "claude-sonnet-5" });
  });

  it("gemini: GEMINI_THINKING_LEVEL is the reasoning level; unset, the model's default", () => {
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "gemini", GEMINI_THINKING_LEVEL: "low" })).toEqual({ provider: "gemini", model: "gemini-3.8-flash", reasoning: "low" });
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.5-flash-lite" })).toEqual({ provider: "gemini", model: "gemini-3.5-flash-lite", reasoning: "default" });
  });

  it("GEMINI_THINKING_LEVEL does not apply to anthropic", () => {
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "anthropic", GEMINI_THINKING_LEVEL: "high" }).reasoning).toBe("default");
  });

  it("fake: the fake engine, whatever LLM_MODEL says", () => {
    expect(resolveEnvLlmChoice({ LLM_PROVIDER: "fake", LLM_MODEL: "claude-sonnet-5" })).toEqual({ provider: "fake", model: "fake", reasoning: "default" });
  });

  it("takes loadEnv's and loadLiveLlmEnv's results as they are", () => {
    const env = loadEnv({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://x",
      REDIS_URL: "redis://x",
      ARTIFACT_STORAGE_TYPE: "local",
      ARTIFACT_BUCKET: "a",
      LLM_PROVIDER: "gemini",
      GEMINI_THINKING_LEVEL: "medium",
      BROWSER_MODE: "local",
      API_TOKEN: "dev-token-0123456789abcdef",
      DEFAULT_TENANT_ID: "t_default",
      SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    expect(resolveEnvLlmChoice(env)).toEqual({ provider: "gemini", model: "gemini-3.8-flash", reasoning: "medium" });
    const live = loadLiveLlmEnv({ ANTHROPIC_API_KEY: "sk-test", LLM_MODEL: "claude-haiku-4-5" });
    if ("missingKey" in live) throw new Error("unexpected");
    expect(resolveEnvLlmChoice(live)).toEqual({ provider: "anthropic", model: "claude-haiku-4-5", reasoning: "default" });
  });

  it("LLM_PROVIDER=openai is refused: not implemented in V1 (the API and the worker stop at start-up)", () => {
    expect(() => resolveEnvLlmChoice({ LLM_PROVIDER: "openai", LLM_MODEL: "gpt-x" })).toThrow(/LLM_PROVIDER=openai is not implemented in V1/);
  });
});
```

In `packages/config/src/env.test.ts`, replace the two tests at lines 85–96:

```ts
  it("requires provider keys for real LLM providers", () => {
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" }).LLM_PROVIDER).toBe("anthropic");
  });

  it("LLM_PROVIDER=gemini requires GEMINI_API_KEY (compose passes an unset key as empty)", () => {
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "" })).toThrow(/GEMINI_API_KEY/);
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", ANTHROPIC_API_KEY: "sk-test" })).toThrow(/GEMINI_API_KEY/);
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-test" }).LLM_PROVIDER).toBe("gemini");
  });
```

with:

```ts
  it("provider keys are optional for anthropic and gemini: Settings may hold them (compose passes an unset key as empty)", () => {
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic" }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "" }).LLM_PROVIDER).toBe("gemini");
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" }).ANTHROPIC_API_KEY).toBe("sk-test");
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-test" }).GEMINI_API_KEY).toBe("gm-test");
  });

  it("LLM_PROVIDER=openai still needs OPENAI_API_KEY (resolveEnvLlmChoice then refuses it: not built in V1)", () => {
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
  });
```

and add this test right after the test "rejects a provider key that can't be an HTTP header value, without printing the key" (it ends at line 131):

```ts
  it("checks every provider key that is set, whatever LLM_PROVIDER is (a run may choose either provider)", () => {
    let message = "";
    try {
      loadEnv({ ...validEnv, LLM_PROVIDER: "fake", GEMINI_API_KEY: "gm secret-value" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/GEMINI_API_KEY/);
    expect(message).not.toContain("secret-value");
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-test", ANTHROPIC_API_KEY: "sk ant" })).toThrow(/ANTHROPIC_API_KEY/);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @platform/config exec vitest run src/llm-choice.test.ts src/env.test.ts`
Expected: FAIL — `llm-choice.test.ts`: `Failed to load url ./llm-choice` (the module does not exist); `env.test.ts`: "provider keys are optional …" fails with `Invalid environment configuration: … ANTHROPIC_API_KEY: is required when LLM_PROVIDER=anthropic`, and "checks every provider key that is set" fails (the fake provider's Gemini key is not checked yet).

- [ ] **Step 3: Give `@platform/config` the contracts**

In `packages/config/package.json` replace `"dependencies": { "@platform/security": "workspace:*", "zod": "4.4.3" }` with:

```json
  "dependencies": { "@platform/contracts": "workspace:*", "@platform/security": "workspace:*", "zod": "4.4.3" }
```

Run: `pnpm install`
Expected: it links the workspace package; `pnpm-lock.yaml` changes only in the `packages/config` importer.

- [ ] **Step 4: Implement `packages/config/src/llm-choice.ts`**

```ts
import { LlmChoiceSchema, LlmProviderSchema, ReasoningLevelSchema, type LlmChoice } from "@platform/contracts";
import { defaultLlmModel } from "./env";

/** The LLM_* variables resolveEnvLlmChoice reads: a loaded Env, or loadLiveLlmEnv's result. */
export interface EnvLlmSettings {
  LLM_PROVIDER: string;
  LLM_MODEL?: string;
  GEMINI_THINKING_LEVEL?: string;
}

/**
 * The model choice the environment configures: what a new run uses when neither its request nor the
 * saved Settings name a model, and what runs created before model choice existed use. The API (run
 * creation) and the worker (runs without a recorded choice) both call it, so they agree. LLM_MODEL unset
 * or empty: the provider's default model; the fake engine's model is always `fake`. Reasoning:
 * GEMINI_THINKING_LEVEL for gemini, otherwise `default`. Throws for a provider not built in V1
 * (LLM_PROVIDER=openai), which stops the API and the worker at start-up.
 */
export function resolveEnvLlmChoice(env: EnvLlmSettings): LlmChoice {
  const provider = LlmProviderSchema.safeParse(env.LLM_PROVIDER);
  if (!provider.success) {
    throw new Error(`LLM_PROVIDER=${env.LLM_PROVIDER} is not implemented in V1 (use anthropic, gemini or fake)`);
  }
  if (provider.data === "fake") return { provider: "fake", model: "fake", reasoning: "default" };
  const reasoning = provider.data === "gemini" && env.GEMINI_THINKING_LEVEL ? ReasoningLevelSchema.parse(env.GEMINI_THINKING_LEVEL) : "default";
  return LlmChoiceSchema.parse({ provider: provider.data, model: env.LLM_MODEL || defaultLlmModel(provider.data), reasoning });
}
```

Replace `packages/config/src/index.ts` with:

```ts
export * from "./env";
export * from "./llm-choice";
export * from "./logger";
```

- [ ] **Step 5: Keys optional in `loadEnv`, still checked when set**

In `packages/config/src/env.ts` replace lines 31–48 (from `const PROVIDER_KEYS` through the `if (env.LLM_PROVIDER === "openai") return;` line):

```ts
const PROVIDER_KEYS = { fake: null, anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY" } as const;
/** Model ids of each real provider: the other's (e.g. a leftover LLM_MODEL) would fail at the first call. */
const MODEL_PREFIXES = { anthropic: "claude-", gemini: "gemini-" } as const;

/**
 * A real provider needs its API key, usable as an HTTP header value (the runtime's error for an
 * invalid one quotes it, so it is checked here, where the message never includes values), and a
 * model of its own.
 */
function checkLlmSettings(env: LlmFields, ctx: z.core.$RefinementCtx<LlmFields>): void {
  const keyVar = PROVIDER_KEYS[env.LLM_PROVIDER];
  if (!keyVar) return;
  const key = env[keyVar];
  if (!key) ctx.addIssue({ code: "custom", path: [keyVar], message: `is required when LLM_PROVIDER=${env.LLM_PROVIDER}` });
  else if (!/^[\x21-\x7e]+$/.test(key.trim())) {
    ctx.addIssue({ code: "custom", path: [keyVar], message: "must be one line of printable ASCII without spaces" });
  }
  if (env.LLM_PROVIDER === "openai") return;
```

with:

```ts
const PROVIDER_KEYS = { fake: null, anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY" } as const;
/** The keys a run may use from the environment: its provider comes from its model choice, so either one. */
const MODEL_PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"] as const;
/** Model ids of each real provider: the other's (e.g. a leftover LLM_MODEL) would fail at the first call. */
const MODEL_PREFIXES = { anthropic: "claude-", gemini: "gemini-" } as const;

/**
 * Provider keys are optional (Settings may hold them), but a key that is set must be usable as an HTTP
 * header value (the runtime's error for an invalid one quotes it, so it is checked here, where the message
 * never includes values). LLM_MODEL must be the provider's own. openai still needs its key (and is then
 * refused by resolveEnvLlmChoice: not built in V1).
 */
function checkLlmSettings(env: LlmFields, ctx: z.core.$RefinementCtx<LlmFields>): void {
  for (const keyVar of MODEL_PROVIDER_KEYS) {
    const key = env[keyVar];
    if (key && !/^[\x21-\x7e]+$/.test(key.trim())) {
      ctx.addIssue({ code: "custom", path: [keyVar], message: "must be one line of printable ASCII without spaces" });
    }
  }
  if (env.LLM_PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) ctx.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "is required when LLM_PROVIDER=openai" });
    return;
  }
  if (env.LLM_PROVIDER === "fake") return;
```

The rest of the function (the other provider's `LLM_MODEL` check) stays as it is. `PROVIDER_KEYS` is still used by `loadLiveLlmEnv`, which is unchanged: it returns `{ missingKey }` before parsing, so the live tools still need the key.

- [ ] **Step 6: Document the keys as optional** — in `.env.example`, replace the LLM block (from `# LLM provider: fake (dev/test only), …` through `# ANTHROPIC_API_KEY=`):

```
# LLM provider: fake (dev/test only), anthropic, gemini (Gemini Developer API), openai (not implemented in V1)
LLM_PROVIDER=fake
# The bare model id; empty: claude-sonnet-5 (anthropic), gemini-3.8-flash (gemini). The other provider's model is rejected.
# LLM_MODEL=
# ANTHROPIC_API_KEY=
```

with:

```
# LLM provider: fake (dev/test only), anthropic, gemini (Gemini Developer API), openai (not implemented in V1).
# LLM_PROVIDER, LLM_MODEL and GEMINI_THINKING_LEVEL are the defaults for new tests while the web UI's Settings hold
# none; a test can also pick its own model and reasoning level. The api and the worker must see the same LLM_* values.
LLM_PROVIDER=fake
# The bare model id; empty: claude-sonnet-5 (anthropic), gemini-3.8-flash (gemini). The other provider's model is rejected.
# LLM_MODEL=
# Provider keys are optional: Settings → AI providers can hold them (encrypted in the database with
# SECRETS_ENCRYPTION_KEY). A key set here is the server's, used for a provider with no key saved in Settings.
# ANTHROPIC_API_KEY=
```

- [ ] **Step 7: Run the config tests and the typecheck**

Run: `pnpm --filter @platform/config test && pnpm typecheck`
Expected: PASS (every `loadLiveLlmEnv` test unchanged and green).

- [ ] **Step 8: Commit**

```bash
git add packages/config/src/llm-choice.ts packages/config/src/llm-choice.test.ts packages/config/src/env.ts packages/config/src/env.test.ts packages/config/src/index.ts packages/config/package.json pnpm-lock.yaml .env.example
git commit -m "feat: provider keys optional in the environment; resolveEnvLlmChoice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: LLM — the model catalog

**Files:**
- Create: `packages/llm/src/catalog.ts`
- Create: `packages/llm/src/catalog.test.ts`
- Modify: `packages/llm/src/index.ts`, `packages/llm/package.json` (`exports`)

**Interfaces:**
- Consumes: `LlmProvider`, `ReasoningLevel` (Task 1).
- Produces (from `@platform/llm`, and from the SDK-free entry point `@platform/llm/catalog`): `interface CatalogModel { provider: LlmProvider; id: string; label: string; reasoningLevels: ReasoningLevel[]; defaultLevel: "minimal" | "low" | "medium" | "high" | null; refusalFallback: boolean }`, `MODEL_CATALOG: readonly CatalogModel[]`, `catalogModel(id: string): CatalogModel | undefined`, `PROVIDER_LABELS: Readonly<Record<LlmProvider, string>>` (`Anthropic`, `Google Gemini`, `Development`). New entry point `@platform/llm/pricing` (`priceFor`, `estimateCostUsd`).

- [ ] **Step 1: Write the failing test** — `packages/llm/src/catalog.test.ts`

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, PROVIDER_LABELS, catalogModel } from "./catalog";
import { priceFor } from "./pricing";

describe("MODEL_CATALOG", () => {
  it("lists the spec's models with their levels, default level and refusal fallback", () => {
    expect(MODEL_CATALOG.map((m) => [m.provider, m.id, m.reasoningLevels.slice(1).join(","), m.defaultLevel, m.refusalFallback])).toEqual([
      ["anthropic", "claude-fable-5-1", "low,medium,high", "high", true],
      ["anthropic", "claude-opus-5-5", "low,medium,high", "medium", true],
      ["anthropic", "claude-sonnet-5", "low,medium,high", "high", false],
      ["anthropic", "claude-haiku-4-5", "", null, false],
      ["gemini", "gemini-3.8-flash", "low,medium,high", "medium", false],
      ["gemini", "gemini-3.5-flash", "minimal,low,medium,high", "medium", false],
      ["gemini", "gemini-3.5-flash-lite", "minimal,low,medium,high", "minimal", false],
      ["gemini", "gemini-3.1-pro-preview", "low,medium,high", "high", false],
      ["fake", "fake", "", null, false],
    ]);
  });

  it("every model but the fake engine has a price", () => {
    for (const m of MODEL_CATALOG.filter((m) => m.provider !== "fake")) expect(priceFor(m.id), m.id).not.toBeNull();
  });

  it("ids are unique; every model's levels start with default, without repeats; only reasoning models have a default level", () => {
    expect(new Set(MODEL_CATALOG.map((m) => m.id)).size).toBe(MODEL_CATALOG.length);
    for (const m of MODEL_CATALOG) {
      expect(m.reasoningLevels[0], m.id).toBe("default");
      expect(new Set(m.reasoningLevels).size, m.id).toBe(m.reasoningLevels.length);
      expect(m.defaultLevel === null, m.id).toBe(m.reasoningLevels.length === 1);
    }
  });

  it("offers the providers' default models (defaultLlmModel)", () => {
    expect(catalogModel("claude-sonnet-5")?.provider).toBe("anthropic");
    expect(catalogModel("gemini-3.8-flash")?.provider).toBe("gemini");
  });

  it("looks models up by exact id and names the providers", () => {
    expect(catalogModel("claude-opus-5-5")?.label).toBe("Claude Opus 5.5");
    expect(catalogModel("claude-opus-5-5-20260901")).toBeUndefined();
    expect(catalogModel("gpt-x")).toBeUndefined();
    expect(PROVIDER_LABELS).toEqual({ anthropic: "Anthropic", gemini: "Google Gemini", fake: "Development" });
  });

  it("the ./catalog and ./pricing entry points load no provider SDK (the API imports them)", () => {
    for (const file of ["./catalog.ts", "./pricing.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)].map((m) => `${m[1] ? "type " : ""}${m[2]}`);
      expect(imports.every((i) => i === "type @platform/contracts"), `${file}: ${imports.join(", ")}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @platform/llm exec vitest run src/catalog.test.ts`
Expected: FAIL — `Failed to load url ./catalog`.

- [ ] **Step 3: Implement `packages/llm/src/catalog.ts`**

```ts
import type { LlmProvider, ReasoningLevel } from "@platform/contracts";

/**
 * The models the Settings page and the new-test form offer (spec 2026-09-28-llm-settings-design.md,
 * section 2). Plain data next to pricing.ts: every entry but the fake engine has a price (catalog.test.ts).
 * Levels are the providers' own (Anthropic effort levels; Google's thinking-level table, checked 2026-09-28).
 * Importable as `@platform/llm/catalog` without loading a provider SDK (the API uses it).
 */
export interface CatalogModel {
  provider: LlmProvider;
  id: string;
  label: string;
  /** The levels a run may choose; always starts with "default" (no reasoning parameter: the model's own). */
  reasoningLevels: ReasoningLevel[];
  /** What "default" means, for display; null: the model does not reason. */
  defaultLevel: "minimal" | "low" | "medium" | "high" | null;
  /** Anthropic's server-side refusal fallback (`fallbacks: "default"`) is requested for this model. */
  refusalFallback: boolean;
}

export const MODEL_CATALOG: readonly CatalogModel[] = [
  { provider: "anthropic", id: "claude-fable-5-1", label: "Claude Fable 5.1", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "high", refusalFallback: true },
  { provider: "anthropic", id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "medium", refusalFallback: true },
  { provider: "anthropic", id: "claude-sonnet-5", label: "Claude Sonnet 5", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "high", refusalFallback: false },
  { provider: "anthropic", id: "claude-haiku-4-5", label: "Claude Haiku 4.5", reasoningLevels: ["default"], defaultLevel: null, refusalFallback: false },
  { provider: "gemini", id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "medium", refusalFallback: false },
  { provider: "gemini", id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", reasoningLevels: ["default", "minimal", "low", "medium", "high"], defaultLevel: "medium", refusalFallback: false },
  { provider: "gemini", id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", reasoningLevels: ["default", "minimal", "low", "medium", "high"], defaultLevel: "minimal", refusalFallback: false },
  { provider: "gemini", id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "high", refusalFallback: false },
  { provider: "fake", id: "fake", label: "Fake engine (development)", reasoningLevels: ["default"], defaultLevel: null, refusalFallback: false },
];

/** How the UI and messages name each provider. */
export const PROVIDER_LABELS: Readonly<Record<LlmProvider, string>> = {
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  fake: "Development",
};

/** The catalog entry for a model id (exact match), if the platform offers it. */
export function catalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}
```

The labels leave out the spec table's "(default)" marks: those mark `defaultLlmModel`, and a label is also what the run chip shows ("Claude Sonnet 5 · medium reasoning").

- [ ] **Step 4: Export it, and add the SDK-free entry points**

Replace `packages/llm/src/index.ts` with:

```ts
export * from "./types";
export * from "./transport";
export * from "./pricing";
export * from "./catalog";
export * from "./llm-client";
export * from "./providers";
```

In `packages/llm/package.json` replace:

```json
  "exports": {
    ".": "./src/index.ts"
  },
```

with:

```json
  "exports": {
    ".": "./src/index.ts",
    "./catalog": "./src/catalog.ts",
    "./pricing": "./src/pricing.ts"
  },
```

- [ ] **Step 5: Run the llm tests and the typecheck**

Run: `pnpm --filter @platform/llm test && pnpm --filter @platform/llm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/llm/src/catalog.ts packages/llm/src/catalog.test.ts packages/llm/src/index.ts packages/llm/package.json
git commit -m "feat: model catalog with reasoning levels, default level and refusal fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: LLM — the reasoning level travels with each request

**Files:**
- Modify: `packages/llm/src/transport.ts`, `packages/llm/src/llm-client.ts`, `packages/llm/src/providers/gemini.ts`, `packages/llm/src/providers/anthropic.ts`, `packages/llm/src/providers/index.ts`
- Test: `packages/llm/src/llm-client.test.ts`, `packages/llm/src/providers/gemini.test.ts`, `packages/llm/src/providers/anthropic.test.ts`
- Modify (callers of the old `createTransport` options): `evals/run-evals.ts`, `tests/integration/stagehand-smoke.live.test.ts`, `apps/worker/src/engine.ts` (interim; Task 10 replaces this code)

**Interfaces:**
- Consumes: `ReasoningLevel`, `LlmProvider` (Task 1); `resolveEnvLlmChoice` (Task 2).
- Produces: `LlmTransportRequest.reasoning: ReasoningLevel`; `LlmClientOptions.reasoning?: ReasoningLevel` (default `"default"`); `get LlmClient.reasoning: ReasoningLevel`; `LlmCallInput.reasoning?: ReasoningLevel` (overrides the client's for that call); `createTransport({ provider: LlmProvider; apiKey?: string }): LlmTransport` (throws `An API key is required for the <provider> provider` for a real provider without a key); `GeminiTransportOptions` loses `thinkingLevel` (and `GeminiThinkingLevel` is no longer exported).

- [ ] **Step 1: Write the failing tests**

`packages/llm/src/providers/anthropic.test.ts` — in the `request()` helper, add `reasoning: "default",` between `maxTokens: 1000,` and `signal: new AbortController().signal,`. Then append inside `describe("AnthropicTransport", …)`, after the test "a refusal is a non-retryable provider error":

```ts
  it.each(["low", "medium", "high"] as const)("sends reasoning %s as output_config.effort, next to the format", async (reasoning) => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage("{}")));
    await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ reasoning }));
    const config = seen[0]!.body.output_config as { effort?: string; format: { type: string } };
    expect(config.effort).toBe(reasoning);
    expect(config.format.type).toBe("json_schema");
  });

  it("sends no effort for the model's default level", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage("{}")));
    await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ reasoning: "default" }));
    expect(seen[0]!.body.output_config).not.toHaveProperty("effort");
  });

  it("refuses minimal, a level Claude does not have, without calling the API (non-retryable)", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage("{}")));
    const err = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ reasoning: "minimal" })).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect(err).toMatchObject({ retryable: false });
    expect(seen).toHaveLength(0);
  });
```

`packages/llm/src/providers/gemini.test.ts` — in its `request()` helper, add `reasoning: "default",` between `maxTokens: 1000,` and `signal: new AbortController().signal,`. Replace the test at lines 100–104:

```ts
  it("sends the configured thinking level", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse([{ text: "{}" }])));
    await new GeminiTransport({ apiKey: "gm-test-key", thinkingLevel: "low", fetch: fn }).complete(request());
    expect((seen[0]!.body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: "LOW" });
  });
```

with:

```ts
  it.each([
    ["minimal", "MINIMAL"],
    ["low", "LOW"],
    ["medium", "MEDIUM"],
    ["high", "HIGH"],
  ] as const)("sends reasoning %s as thinkingLevel %s", async (reasoning, thinkingLevel) => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse([{ text: "{}" }])));
    await new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }).complete(request({ reasoning }));
    expect((seen[0]!.body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel });
  });

  it("sends no thinkingConfig for the model's default level", async () => {
    const { fn, seen } = fakeFetch(() => json(200, okResponse([{ text: "{}" }])));
    await new GeminiTransport({ apiKey: "gm-test-key", fetch: fn }).complete(request({ reasoning: "default" }));
    expect(seen[0]!.body.generationConfig).not.toHaveProperty("thinkingConfig");
  });
```

`packages/llm/src/llm-client.test.ts` — replace the whole `describe("createTransport", …)` block at the end of the file (lines 343–380, whose first test is "LLM_PROVIDER=openai fails fast: not implemented in V1"; that behaviour is now `resolveEnvLlmChoice`'s, tested in Task 2) with:

```ts
describe("LlmClient reasoning", () => {
  it("sends the client's level with every request, and a call's own level when it names one", async () => {
    const { client, transport } = setup({ reasoning: "high" });
    transport.enqueue({ json: { answer: "a", count: 1 } }, { json: { answer: "b", count: 2 } });
    expect(client.reasoning).toBe("high");
    await client.generateStructured({ ...base(), schema: Answer });
    await client.generateStructured({ ...base(), schema: Answer, reasoning: "default" });
    expect(transport.requests.map((r) => r.reasoning)).toEqual(["high", "default"]);
  });

  it("without a level, sends default (the model's own), on retries and the correction round too", async () => {
    const { client, transport } = setup();
    transport.enqueue(
      { error: new LlmTransportError("rate limited", { status: 429, retryable: true }) },
      { json: { answer: "" } },
      { json: { answer: "ok", count: 1 } },
    );
    await client.generateStructured({ ...base(), schema: Answer });
    expect(client.reasoning).toBe("default");
    expect(transport.requests.map((r) => r.reasoning)).toEqual(["default", "default", "default"]);
  });
});

describe("createTransport", () => {
  it("builds the chosen provider's adapter with the run's key", () => {
    expect(createTransport({ provider: "anthropic", apiKey: "sk-test" }).provider).toBe("anthropic");
    expect(createTransport({ provider: "gemini", apiKey: "gm-test" }).provider).toBe("gemini");
    expect(createTransport({ provider: "fake" })).toBeInstanceOf(FakeTransport);
  });

  it("a real provider without a key fails before any request", () => {
    expect(() => createTransport({ provider: "anthropic" })).toThrow(/API key/);
    expect(() => createTransport({ provider: "gemini", apiKey: "" })).toThrow(/API key/);
  });

  it("the client's reasoning reaches Gemini as its thinking level (no longer a transport option)", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const reply = { candidates: [{ content: { parts: [{ text: '{"answer":"ok","count":1}' }], role: "model" }, finishReason: "STOP", index: 0 }] };
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const client = new LlmClient({ transport: createTransport({ provider: "gemini", apiKey: "gm-test" }), model: "gemini-3.8-flash", reasoning: "high" });
      await client.generateStructured({ ...base(), schema: Answer });
      expect(bodies[0]).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @platform/llm exec vitest run src/llm-client.test.ts src/providers/anthropic.test.ts src/providers/gemini.test.ts`
Expected: FAIL — no request carries `reasoning` (`[undefined, undefined]`), Anthropic sends no `effort` and calls the API for `minimal`, Gemini ignores the request's level, and `createTransport({ provider: "gemini", apiKey })` throws `GEMINI_API_KEY is required`.

- [ ] **Step 3: The request carries the level** — in `packages/llm/src/transport.ts`, replace `import type { JsonSchema, LlmMessage } from "./types";` with:

```ts
import type { ReasoningLevel } from "@platform/contracts";
import type { JsonSchema, LlmMessage } from "./types";
```

and in `LlmTransportRequest` replace:

```ts
  maxTokens: number;
  signal: AbortSignal;
}
```

with:

```ts
  maxTokens: number;
  /** `default`: no reasoning parameter (the model's own level). */
  reasoning: ReasoningLevel;
  signal: AbortSignal;
}
```

- [ ] **Step 4: The client's level, and a call's own** — in `packages/llm/src/llm-client.ts`:

Add `type ReasoningLevel,` to the `@platform/contracts` import (between `ModelProviderError,` and `type RunLifecycle,`).

In `LlmClientOptions`, after `model: string;` add:

```ts
  /** The run's reasoning level (default "default": no reasoning parameter). A call's `reasoning` overrides it. */
  reasoning?: ReasoningLevel;
```

In `LlmCallInput`, after `schemaName?: string;` add:

```ts
  /** This call's reasoning level instead of the client's (the Stagehand bridge always sends "default"). */
  reasoning?: ReasoningLevel;
```

After the `get provider()` getter add:

```ts
  /** The level every call sends unless it names its own. */
  get reasoning(): ReasoningLevel {
    return this.opts.reasoning ?? "default";
  }
```

In `request()`, in the object passed to `this.opts.transport.complete(…)`, replace:

```ts
            maxTokens: input.maxTokens ?? this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            signal,
```

with:

```ts
            maxTokens: input.maxTokens ?? this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            reasoning: input.reasoning ?? this.reasoning,
            signal,
```

- [ ] **Step 5: Gemini reads the level from the request** — in `packages/llm/src/providers/gemini.ts` replace:

```ts
export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface GeminiTransportOptions {
  apiKey: string;
  /** Unset: the model's default. Thinking tokens count against the request's `maxTokens`. */
  thinkingLevel?: GeminiThinkingLevel;
  /** Per-request HTTP timeout (default 25 s, see DEFAULT_TIMEOUT_MS). */
```

with:

```ts
export interface GeminiTransportOptions {
  apiKey: string;
  /** Per-request HTTP timeout (default 25 s, see DEFAULT_TIMEOUT_MS). */
```

and in `complete()` replace:

```ts
        maxOutputTokens: req.maxTokens,
        ...(this.opts.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.opts.thinkingLevel.toUpperCase() } } : {}),
```

with:

```ts
        maxOutputTokens: req.maxTokens,
        // "default": no thinkingConfig, the model's own level. Thinking tokens count against maxOutputTokens.
        ...(req.reasoning !== "default" ? { thinkingConfig: { thinkingLevel: req.reasoning.toUpperCase() } } : {}),
```

- [ ] **Step 6: Anthropic sends the level as `output_config.effort`** — in `packages/llm/src/providers/anthropic.ts`:

Replace the first import line `import Anthropic from "@anthropic-ai/sdk";` with:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { ReasoningLevel } from "@platform/contracts";
```

Add after the `type ImageMediaType = …;` line:

```ts
/** A run's reasoning level as Claude's `output_config.effort`; "default" sends none (the model's own). */
function effortOf(reasoning: ReasoningLevel): { effort: "low" | "medium" | "high" } | Record<string, never> {
  switch (reasoning) {
    case "default":
      return {};
    case "low":
    case "medium":
    case "high":
      return { effort: reasoning };
    case "minimal":
      throw new LlmTransportError("Claude models take the reasoning levels low, medium and high, not minimal", { retryable: false });
  }
}
```

In `complete()` replace:

```ts
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          messages: req.messages.map(toMessageParam),
          output_config: { format: { type: "json_schema", schema } },
        },
```

with:

```ts
    const effort = effortOf(req.reasoning); // before the request: a level Claude lacks never reaches the API
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          messages: req.messages.map(toMessageParam),
          output_config: { format: { type: "json_schema", schema }, ...effort },
        },
```

and in the class comment replace `Schema rewritten to the supported strict subset. SDK retries are disabled: LlmClient owns retry policy.` with `Schema rewritten to the supported strict subset, and the run's reasoning level as \`output_config.effort\`. SDK retries are disabled: LlmClient owns retry policy.`

- [ ] **Step 7: `createTransport` takes the run's provider and key** — replace `packages/llm/src/providers/index.ts` with:

```ts
import type { LlmProvider } from "@platform/contracts";
import type { LlmTransport } from "../transport";
import { AnthropicTransport } from "./anthropic";
import { FakeTransport } from "./fake";
import { GeminiTransport } from "./gemini";

export interface TransportConfig {
  provider: LlmProvider;
  /** The provider's API key (from Settings or the environment); unused by `fake`. */
  apiKey?: string;
}

/**
 * The provider adapter for one run's model choice. The reasoning level travels with each request
 * (`LlmTransportRequest.reasoning`), so one transport serves every level.
 */
export function createTransport(config: TransportConfig): LlmTransport {
  switch (config.provider) {
    case "anthropic":
      if (!config.apiKey) throw new Error("An API key is required for the anthropic provider");
      return new AnthropicTransport({ apiKey: config.apiKey });
    case "gemini":
      if (!config.apiKey) throw new Error("An API key is required for the gemini provider");
      return new GeminiTransport({ apiKey: config.apiKey });
    case "fake":
      return new FakeTransport();
  }
}

export { AnthropicTransport, type AnthropicTransportOptions } from "./anthropic";
export { FakeTransport, type FakeReply } from "./fake";
export { GeminiTransport, type GeminiTransportOptions } from "./gemini";
```

- [ ] **Step 8: Update the callers of the old options**

`evals/run-evals.ts` — replace `import { EnvValidationError, defaultLlmModel, loadLiveLlmEnv } from "@platform/config";` with:

```ts
import { EnvValidationError, defaultLlmModel, loadLiveLlmEnv, resolveEnvLlmChoice } from "@platform/config";
```

and replace:

```ts
  const transport = createTransport({
    provider: env.LLM_PROVIDER,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiThinkingLevel: env.GEMINI_THINKING_LEVEL,
  });
  const llm = new LlmClient({ transport, model: env.LLM_MODEL, recordCall: meter.sink });
  const thinking = env.LLM_PROVIDER === "gemini" ? `, thinking: ${env.GEMINI_THINKING_LEVEL ?? "model default"}` : "";
```

with:

```ts
  // GEMINI_THINKING_LEVEL is the client's reasoning level (gemini only), as for a run on the environment's defaults.
  const choice = resolveEnvLlmChoice(env);
  const transport = createTransport({ provider: choice.provider, apiKey: env.LLM_PROVIDER === "gemini" ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY });
  const llm = new LlmClient({ transport, model: choice.model, reasoning: choice.reasoning, recordCall: meter.sink });
  const thinking = choice.provider === "gemini" ? `, thinking: ${choice.reasoning === "default" ? "model default" : choice.reasoning}` : "";
```

`tests/integration/stagehand-smoke.live.test.ts` — replace `import { loadLiveLlmEnv } from "@platform/config";` with `import { loadLiveLlmEnv, resolveEnvLlmChoice } from "@platform/config";`, and replace:

```ts
    const env = LLM!;
    const llm = new LlmClient({
      transport: createTransport({
        provider: env.LLM_PROVIDER,
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        geminiApiKey: env.GEMINI_API_KEY,
        geminiThinkingLevel: env.GEMINI_THINKING_LEVEL,
      }),
      model: env.LLM_MODEL,
      logger: silent,
```

with:

```ts
    const env = LLM!;
    const choice = resolveEnvLlmChoice(env);
    const llm = new LlmClient({
      transport: createTransport({ provider: choice.provider, apiKey: env.LLM_PROVIDER === "gemini" ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY }),
      model: choice.model,
      reasoning: choice.reasoning,
      logger: silent,
```

`apps/worker/src/engine.ts` (interim until Task 10) — replace `import type { Env } from "@platform/config";` with `import { resolveEnvLlmChoice, type Env } from "@platform/config";`, and replace:

```ts
  const transport =
    deps.transport ??
    createTransport({
      provider: config.LLM_PROVIDER,
      anthropicApiKey: config.ANTHROPIC_API_KEY,
      geminiApiKey: config.GEMINI_API_KEY,
      geminiThinkingLevel: config.GEMINI_THINKING_LEVEL,
    });
```

with:

```ts
  // The environment's model choice; throws for LLM_PROVIDER=openai (not built in V1).
  const choice = resolveEnvLlmChoice(config);
  const transport =
    deps.transport ??
    createTransport({ provider: choice.provider, apiKey: choice.provider === "gemini" ? config.GEMINI_API_KEY : config.ANTHROPIC_API_KEY });
```

and in the `new LlmClient({ … })` just below replace `    model: config.LLM_MODEL,` with:

```ts
    model: choice.model,
    reasoning: choice.reasoning,
```

- [ ] **Step 9: Run the tests and the typecheck**

Run: `pnpm --filter @platform/llm test && pnpm typecheck && pnpm --filter @platform/worker exec vitest run src/engine.test.ts`
Expected: PASS. (The worker's engine tests keep passing unchanged: "LLM_PROVIDER=openai fails fast" now fails in `resolveEnvLlmChoice` with the same message, and the Gemini test's `GEMINI_THINKING_LEVEL: "low"` reaches the request as the client's level.)

- [ ] **Step 10: Commit**

```bash
git add packages/llm/src/transport.ts packages/llm/src/llm-client.ts packages/llm/src/llm-client.test.ts packages/llm/src/providers/gemini.ts packages/llm/src/providers/gemini.test.ts packages/llm/src/providers/anthropic.ts packages/llm/src/providers/anthropic.test.ts packages/llm/src/providers/index.ts evals/run-evals.ts tests/integration/stagehand-smoke.live.test.ts apps/worker/src/engine.ts
git commit -m "feat: the reasoning level travels with each model request (Claude effort, Gemini thinking level)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: LLM — refusal fallback for Claude Fable 5.1 and Opus 5.5

The SDK names used here (`@anthropic-ai/sdk` 0.128.0, `resources/beta/messages/messages.d.ts`): `client.beta.messages.create(params, options)` posts to `/v1/messages?beta=true` and sends `params.betas` as the `anthropic-beta` header; `MessageCreateParamsBase.fallbacks?: BetaFallbacksParam` (`"default"` or a chain); the response's `content` may hold `BetaFallbackBlock` (`{ type: "fallback", from: { model }, to: { model }, trigger }`) and `usage.iterations` a `BetaFallbackMessageIterationUsage` (`{ type: "fallback_message", model, … }`) — the documented signal that a fallback served the answer.

**Files:**
- Modify: `packages/llm/src/transport.ts` (`fallbackModel`), `packages/llm/src/providers/fake.ts`, `packages/llm/src/providers/anthropic.ts`, `packages/llm/src/llm-client.ts`
- Test: `packages/llm/src/providers/anthropic.test.ts`, `packages/llm/src/llm-client.test.ts`

**Interfaces:**
- Consumes: `catalogModel` (Task 3).
- Produces: `LlmTransportResponse.fallbackModel?: string` (the serving model after a refusal fallback); `FakeReply` may carry `fallbackModel`; `SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01"` (exported from `providers/anthropic.ts`); `LlmClient` prices and records such a call under `fallbackModel`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/llm/src/providers/anthropic.test.ts`:

```ts
describe("AnthropicTransport refusal fallback (catalog models marked refusalFallback)", () => {
  /** A fallback-served answer: Fable declined, Opus answered after the `fallback` block. */
  const fallbackAnswer = (usage: Record<string, unknown> = {}) =>
    okMessage("", {
      model: "claude-fable-5-1",
      content: [
        { type: "text", text: '{"par' },
        { type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5-5" }, trigger: { type: "refusal", category: "cyber" } },
        { type: "text", text: '{"name":"x"}' },
      ],
      usage: { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
    });

  it.each(["claude-fable-5-1", "claude-opus-5-5"])("%s goes through the beta Messages API with fallbacks: default", async (model) => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage('{"name":"x"}', { model })));
    await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model, reasoning: "high" }));
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(seen[0]!.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(seen[0]!.body).toMatchObject({ model, fallbacks: "default", output_config: { effort: "high", format: { type: "json_schema" } } });
    expect(seen[0]!.body).not.toHaveProperty("betas");
  });

  it.each(["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5"])("%s uses the Messages API, without fallbacks", async (model) => {
    const { fn, seen } = fakeFetch(() => json(200, okMessage("{}", { model })));
    await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model }));
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]!.headers.get("anthropic-beta")).toBeNull();
    expect(seen[0]!.body).not.toHaveProperty("fallbacks");
  });

  it("reports the model that served the fallback (its usage iteration), and returns only that model's text", async () => {
    const iterations = [
      { type: "message", model: "claude-fable-5-1", input_tokens: 60, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
      { type: "fallback_message", model: "claude-opus-5-5", input_tokens: 60, output_tokens: 35, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
    ];
    const { fn } = fakeFetch(() => json(200, fallbackAnswer({ iterations })));
    const res = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model: "claude-fable-5-1" }));
    expect(res).toEqual({ text: '{"name":"x"}', model: "claude-fable-5-1", usage: { inputTokens: 120, outputTokens: 40 }, fallbackModel: "claude-opus-5-5" });
  });

  it("without usage iterations, takes the serving model from the last fallback block", async () => {
    const { fn } = fakeFetch(() => json(200, fallbackAnswer({ iterations: null })));
    const res = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model: "claude-fable-5-1" }));
    expect(res.fallbackModel).toBe("claude-opus-5-5");
    expect(res.text).toBe('{"name":"x"}');
  });

  it("an answer from the requested model has no fallbackModel", async () => {
    const { fn } = fakeFetch(() => json(200, okMessage('{"name":"x"}', { model: "claude-opus-5-5" })));
    const res = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model: "claude-opus-5-5" }));
    expect(res).not.toHaveProperty("fallbackModel");
  });

  it("a refusal no fallback rescued stays a non-retryable provider error", async () => {
    const { fn } = fakeFetch(() => json(200, okMessage("", { model: "claude-fable-5-1", stop_reason: "refusal" })));
    const err = await new AnthropicTransport({ apiKey: "sk-test", fetch: fn }).complete(request({ model: "claude-fable-5-1" })).catch((e) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect(err).toMatchObject({ retryable: false });
    expect(err.message).toMatch(/declined/);
  });
});
```

In `packages/llm/src/llm-client.test.ts`, inside `describe("LlmClient.generateStructured", …)`, add before the test "an unpriced model is surfaced once through the logger, not silently costed at $0":

```ts
  it("prices and records a call a refusal fallback served under the serving model", async () => {
    const { client, transport, calls } = setup({ model: "claude-fable-5-1" });
    transport.enqueue({ json: { answer: "ok", count: 1 }, usage: { inputTokens: 1000, outputTokens: 500 }, fallbackModel: "claude-opus-5-5" });
    const res = await client.generateStructured({ ...base(), schema: Answer });
    // Opus 5.5 ($4 / $20 per MTok), not the requested Fable 5.1 ($10 / $50).
    expect(res.usage.estimatedCostUsd).toBe(0.014);
    expect(calls).toMatchObject([{ model: "claude-opus-5-5", estimatedCostUsd: 0.014, status: "SUCCESS" }]);
  });

  it("an unpriced fallback model is surfaced once through the logger", async () => {
    const warn = vi.fn();
    const { client, transport, calls } = setup({ model: "claude-fable-5-1", logger: { warn } });
    transport.enqueue(
      { json: { answer: "ok", count: 1 }, fallbackModel: "claude-future-9" },
      { json: { answer: "ok", count: 1 }, fallbackModel: "claude-future-9" },
    );
    await client.generateStructured({ ...base(), schema: Answer });
    await client.generateStructured({ ...base(), schema: Answer });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatchObject({ model: "claude-future-9" });
    expect(calls.map((c) => [c.model, c.estimatedCostUsd])).toEqual([
      ["claude-future-9", 0],
      ["claude-future-9", 0],
    ]);
  });

```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @platform/llm exec vitest run src/providers/anthropic.test.ts src/llm-client.test.ts`
Expected: FAIL — Fable and Opus go to `/v1/messages` without `fallbacks`, the transport returns the declined model's text too (`{"par{"name":"x"}`) and no `fallbackModel`, and the client prices the call as Fable 5.1 (`0.035`).

- [ ] **Step 3: The response names the serving model**

In `packages/llm/src/transport.ts`, in `LlmTransportResponse`, after `usage: { inputTokens: number; outputTokens: number };` add:

```ts
  /**
   * Set only when a server-side refusal fallback answered (Anthropic `fallbacks`): the model that served the
   * request. LlmClient then prices and records the call under it instead of the requested model.
   */
  fallbackModel?: string;
```

In `packages/llm/src/providers/fake.ts` replace:

```ts
export type FakeReply =
  | { json: unknown; usage?: Usage; model?: string }
  | { text: string; usage?: Usage; model?: string }
```

with:

```ts
export type FakeReply =
  | { json: unknown; usage?: Usage; model?: string; fallbackModel?: string }
  | { text: string; usage?: Usage; model?: string; fallbackModel?: string }
```

and replace `    return { text, model: reply.model ?? request.model, usage: reply.usage ?? DEFAULT_USAGE };` with:

```ts
    return {
      text,
      model: reply.model ?? request.model,
      usage: reply.usage ?? DEFAULT_USAGE,
      ...(reply.fallbackModel ? { fallbackModel: reply.fallbackModel } : {}),
    };
```

- [ ] **Step 4: The beta path for fallback models** — replace `packages/llm/src/providers/anthropic.ts` with:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { ReasoningLevel } from "@platform/contracts";
import { catalogModel } from "../catalog";
import { LlmTransportError, type LlmTransport, type LlmTransportRequest, type LlmTransportResponse } from "../transport";
import type { LlmMessage } from "../types";
import { retryAfterMs } from "./retry-after";
import { toStrictJsonSchema } from "./strict-json-schema";

export interface AnthropicTransportOptions {
  apiKey: string;
  /** Per-request HTTP timeout. */
  timeoutMs?: number;
  baseURL?: string;
  /** For tests: a fetch implementation (no network). */
  fetch?: typeof fetch;
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** The beta that lets the API retry a refused request on the model Anthropic recommends (`fallbacks: "default"`). */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** A run's reasoning level as Claude's `output_config.effort`; "default" sends none (the model's own). */
function effortOf(reasoning: ReasoningLevel): { effort: "low" | "medium" | "high" } | Record<string, never> {
  switch (reasoning) {
    case "default":
      return {};
    case "low":
    case "medium":
    case "high":
      return { effort: reasoning };
    case "minimal":
      throw new LlmTransportError("Claude models take the reasoning levels low, medium and high, not minimal", { retryable: false });
  }
}

/** What this adapter reads from a Messages (or beta Messages) response. */
interface MessageLike {
  content: readonly { type: string }[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    iterations?: readonly { type: string; model?: string | null }[] | null;
  };
  model: string;
}

type TextBlock = { type: "text"; text: string };
type FallbackBlock = { type: "fallback"; to: { model: string } };
const isText = (b: { type: string }): b is TextBlock => b.type === "text";
const isFallback = (b: { type: string }): b is FallbackBlock => b.type === "fallback";

/**
 * Anthropic Messages API adapter. Structured output uses `output_config.format` with the JSON
 * Schema rewritten to the supported strict subset, and the run's reasoning level as
 * `output_config.effort`. Catalog models marked `refusalFallback` go through the beta Messages API
 * with `fallbacks: "default"`: a request the model's safety classifiers decline is retried by the API
 * on the model Anthropic recommends, and the response names that model (`fallbackModel`). SDK retries
 * are disabled: LlmClient owns retry policy.
 */
export class AnthropicTransport implements LlmTransport {
  readonly provider = "anthropic";
  private readonly client: Anthropic;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicTransportOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 0,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async complete(req: LlmTransportRequest): Promise<LlmTransportResponse> {
    let schema: Record<string, unknown>;
    try {
      schema = toStrictJsonSchema(req.jsonSchema);
    } catch (err) {
      throw new LlmTransportError(`Unsupported JSON schema: ${(err as Error).message}`, { retryable: false, cause: err });
    }
    const params = {
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages.map(toMessageParam),
      output_config: { format: { type: "json_schema" as const, schema }, ...effortOf(req.reasoning) },
    };
    const options = { signal: req.signal, timeout: this.timeoutMs, maxRetries: 0 };
    let message: MessageLike;
    try {
      message = catalogModel(req.model)?.refusalFallback
        ? await this.client.beta.messages.create({ ...params, fallbacks: "default", betas: [SERVER_SIDE_FALLBACK_BETA] }, options)
        : await this.client.messages.create(params, options);
    } catch (err) {
      throw toTransportError(err);
    }
    if (message.stop_reason === "refusal") {
      throw new LlmTransportError("The model declined the request", { retryable: false });
    }
    // After a fallback, only the serving model's output counts: the text after the last `fallback` block.
    const lastFallback = message.content.findLastIndex(isFallback);
    const text = message.content
      .slice(lastFallback + 1)
      .filter(isText)
      .map((b) => b.text)
      .join("");
    const u = message.usage;
    const fallbackModel = servingFallbackModel(message);
    return {
      text,
      model: message.model,
      usage: {
        inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens,
      },
      ...(fallbackModel ? { fallbackModel } : {}),
    };
  }
}

/**
 * The model that served a fallback-answered response: the `fallback_message` usage iteration (the API's
 * signal that a fallback served it), else the last `fallback` content block's target. Undefined otherwise.
 */
function servingFallbackModel(message: MessageLike): string | undefined {
  const served = message.usage.iterations?.find((i) => i.type === "fallback_message")?.model;
  if (served) return served;
  return message.content.filter(isFallback).at(-1)?.to.model;
}

function toMessageParam(m: LlmMessage): Anthropic.MessageParam {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((p): Anthropic.TextBlockParam | Anthropic.ImageBlockParam =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image", source: { type: "base64", media_type: p.mimeType as ImageMediaType, data: p.data } },
    ),
  };
}

/** Classify SDK errors: 408/409/429/5xx and connection failures are retryable; other 4xx are not. */
function toTransportError(err: unknown): LlmTransportError {
  if (err instanceof Anthropic.APIUserAbortError) {
    return new LlmTransportError("Request aborted", { retryable: false, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmTransportError(`Connection error: ${err.message}`, { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const retryable = status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
    return new LlmTransportError(`Anthropic API error ${status ?? "?"}: ${err.message}`, {
      status,
      retryable,
      retryAfterMs: retryAfterMs(err.headers),
      cause: err,
    });
  }
  return new LlmTransportError(`Unexpected error: ${(err as Error)?.message ?? String(err)}`, { retryable: false, cause: err });
}
```

(`effortOf` runs while `params` is built, before the `try`, so a `minimal` level still fails before any request. Both SDK responses — `Anthropic.Message` and `Anthropic.Beta.BetaMessage` — are assignable to `MessageLike`.)

- [ ] **Step 5: The client prices and records the serving model** — in `packages/llm/src/llm-client.ts`, replace:

```ts
  private readonly retry: RetryPolicy;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly opts: LlmClientOptions) {
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    if (!priceFor(opts.model)) {
      (opts.logger ?? consoleLogger).warn(
        { model: opts.model, provider: opts.transport.provider },
        "LLM model has no price in @platform/llm pricing; estimatedCostUsd will be recorded as 0",
      );
    }
  }
```

with:

```ts
  private readonly retry: RetryPolicy;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Models already reported as unpriced (the requested one, and any fallback that served a call). */
  private readonly unpriced = new Set<string>();

  constructor(private readonly opts: LlmClientOptions) {
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.warnIfUnpriced(opts.model);
  }

  private warnIfUnpriced(model: string): void {
    if (priceFor(model) || this.unpriced.has(model)) return;
    this.unpriced.add(model);
    (this.opts.logger ?? consoleLogger).warn(
      { model, provider: this.opts.transport.provider },
      "LLM model has no price in @platform/llm pricing; estimatedCostUsd will be recorded as 0",
    );
  }
```

In `run()` replace:

```ts
      // Priced and recorded by the requested model (providers may echo a resolved snapshot id), at
      // the price in force when it answered.
      const cost = estimateCostUsd(this.opts.model, response.usage.inputTokens, response.usage.outputTokens, new Date(answeredAt)) ?? 0;
```

with:

```ts
      // Priced and recorded by the requested model (providers may echo a resolved snapshot id), or by the
      // model that served it after a refusal fallback, at the price in force when it answered.
      const servedBy = response.fallbackModel ?? this.opts.model;
      if (response.fallbackModel) this.warnIfUnpriced(response.fallbackModel);
      const cost = estimateCostUsd(servedBy, response.usage.inputTokens, response.usage.outputTokens, new Date(answeredAt)) ?? 0;
```

and, a few lines below, in the `this.record(input, { … })` call after `parseAndValidate`, replace `        model: this.opts.model,` with `        model: servedBy,`. (The failed-attempt records in `request()` keep `this.opts.model`: no model answered them.)

- [ ] **Step 6: Run the llm tests and the typecheck**

Run: `pnpm --filter @platform/llm test && pnpm --filter @platform/llm typecheck`
Expected: PASS (including "prices and records by the requested model even when the provider echoes a snapshot id": `model` alone never changes the recorded model).

- [ ] **Step 7: Commit**

```bash
git add packages/llm/src/transport.ts packages/llm/src/providers/fake.ts packages/llm/src/providers/anthropic.ts packages/llm/src/providers/anthropic.test.ts packages/llm/src/llm-client.ts packages/llm/src/llm-client.test.ts
git commit -m "feat: server-side refusal fallback for Claude Fable 5.1 and Opus 5.5, priced as the serving model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Security + DB — encrypted provider keys and the settings tables

**Files:**
- Modify: `packages/security/src/secret-vault.ts`, `packages/security/src/secret-vault.test.ts`, `packages/security/src/redaction.test.ts`
- Modify: `packages/db/src/schema.ts` (enum + two tables), `packages/db/src/index.ts`
- Create (generated): `packages/db/migrations/0001_llm_settings.sql`, `packages/db/migrations/meta/0001_snapshot.json`; Modify (generated): `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/src/llm-settings-repository.ts`, `packages/db/src/llm-settings-repository.test.ts`

**Interfaces:**
- Consumes: `ReasoningLevelSchema`, `LlmKeyProviderSchema`, `ReasoningLevel`, `LlmKeyProvider` (Task 1).
- Produces (`@platform/security`): `type ProviderKeyAad = { tenantId: string; provider: string }`, `encryptProviderKey(plain: string, aad: ProviderKeyAad, key: Buffer): EncryptedSecret`, `decryptProviderKey(enc: EncryptedSecret, aad: ProviderKeyAad, key: Buffer): string`.
- Produces (`@platform/db`): tables `llmSettings`, `llmProviderKeys` and enum `reasoningLevelEnum` in `schema`; `class LlmSettingsRepository { get(tenantId): Promise<LlmDefaultsRow | null>; upsertDefaults(tenantId, { model, reasoning }): Promise<LlmDefaultsRow> }`; `class ProviderKeyRepository { listStatus(tenantId): Promise<ProviderKeyStatus[]>; set(tenantId, provider, key: EncryptedProviderKey): Promise<ProviderKeyStatus>; remove(tenantId, provider): Promise<boolean>; getEncrypted(tenantId, provider): Promise<EncryptedProviderKey | null> }`; `interface LlmDefaultsRow { model: string; reasoning: ReasoningLevel; updatedAt: Date }`; `interface ProviderKeyStatus { provider: LlmKeyProvider; updatedAt: Date }`; `interface EncryptedProviderKey { ciphertext: Buffer; iv: Buffer; authTag: Buffer }`.

- [ ] **Step 1: Write the failing security tests**

In `packages/security/src/secret-vault.test.ts` replace the import `import { decryptSecret, encryptSecret, type EncryptedSecret } from "./secret-vault";` with:

```ts
import { decryptProviderKey, decryptSecret, encryptProviderKey, encryptSecret, type EncryptedSecret } from "./secret-vault";
```

and append:

```ts
describe("provider key vault (Settings → AI providers)", () => {
  const owner = { tenantId: "t_default", provider: "anthropic" };
  const apiKey = "sk-ant-api03-Provider-Key-777";

  it("round-trips, and the ciphertext does not contain the key", () => {
    const enc = encryptProviderKey(apiKey, owner, key);
    expect(decryptProviderKey(enc, owner, key)).toBe(apiKey);
    expect(enc.iv).toHaveLength(12);
    expect(enc.authTag).toHaveLength(16);
    expect(enc.ciphertext.toString("utf8")).not.toContain("Provider-Key");
  });

  it("fails for another tenant or another provider", () => {
    const enc = encryptProviderKey(apiKey, owner, key);
    expect(() => decryptProviderKey(enc, { ...owner, tenantId: "t_other" }, key)).toThrow();
    expect(() => decryptProviderKey(enc, { ...owner, provider: "gemini" }, key)).toThrow();
  });

  it("never opens with a run secret's AAD, nor opens a run secret", () => {
    const providerKey = encryptProviderKey(apiKey, owner, key);
    expect(() => decryptSecret(providerKey, { runId: owner.tenantId, name: owner.provider }, key)).toThrow();
    expect(() => decryptSecret(providerKey, { runId: "llm-provider-key", name: owner.tenantId }, key)).toThrow();
    const runSecret = encryptSecret(apiKey, { runId: owner.tenantId, name: owner.provider }, key);
    expect(() => decryptProviderKey(runSecret, owner, key)).toThrow();
  });

  it("fails after SECRETS_ENCRYPTION_KEY is rotated", () => {
    const enc = encryptProviderKey(apiKey, owner, key);
    expect(() => decryptProviderKey(enc, owner, randomBytes(32))).toThrow();
  });
});
```

In `packages/security/src/redaction.test.ts`, inside `describe("redactByKey", …)`, add before the `it.each(["email", "username", "tokens", …])("does not redact %s", …)` test (a pin of existing behaviour: it passes as soon as it is written):

```ts
  it.each(["apiKey", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "anthropic_api_key"])(
    "redacts the provider key field %s (settings bodies, environment dumps: the apikey suffix rule)",
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
      expect(redactByKey({ provider: "anthropic", [key]: "sk-ant-api03-x" })).toEqual({ provider: "anthropic", [key]: REDACTED });
    },
  );

```

- [ ] **Step 2: Run them to see the vault tests fail**

Run: `pnpm --filter @platform/security exec vitest run src/secret-vault.test.ts src/redaction.test.ts`
Expected: FAIL — `TypeError: encryptProviderKey is not a function` in the four new vault tests; the redaction pins PASS.

- [ ] **Step 3: Implement the provider-key vault** — replace `packages/security/src/secret-vault.ts` with:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedSecret = { ciphertext: Buffer; iv: Buffer; authTag: Buffer };
export type SecretAad = { runId: string; name: string };
/** A tenant's saved API key for one model provider (Settings → AI providers). */
export type ProviderKeyAad = { tenantId: string; provider: string };

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`Secret encryption key must be exactly ${KEY_BYTES} bytes (got ${key?.length ?? 0})`);
  }
}

// JSON array encoding keeps the (runId, name) boundary unambiguous: ("a:b","c") ≠ ("a","b:c").
const encodeAad = (aad: SecretAad): Buffer => Buffer.from(JSON.stringify([aad.runId, aad.name]), "utf8");
// A three-element tag, so a provider key's AAD can never equal a run secret's two-element [runId, name].
const encodeProviderKeyAad = (aad: ProviderKeyAad): Buffer =>
  Buffer.from(JSON.stringify(["llm-provider-key", aad.tenantId, aad.provider]), "utf8");

function encrypt(plain: string, aad: Buffer, key: Buffer): EncryptedSecret {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decrypt(enc: EncryptedSecret, aad: Buffer, key: Buffer): string {
  assertKey(key);
  if (enc.iv.length !== IV_BYTES) throw new Error(`Invalid IV length ${enc.iv.length}`);
  if (enc.authTag.length !== TAG_BYTES) throw new Error(`Invalid auth tag length ${enc.authTag.length}`);
  const decipher = createDecipheriv(ALGORITHM, key, enc.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(enc.authTag);
  return Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]).toString("utf8");
}

/** AES-256-GCM with a random 12-byte IV. The secret is bound to its run and name through the AAD. */
export function encryptSecret(plain: string, aad: SecretAad, key: Buffer): EncryptedSecret {
  return encrypt(plain, encodeAad(aad), key);
}

/** Throws if the key, AAD, IV, tag or ciphertext do not match what was encrypted. */
export function decryptSecret(enc: EncryptedSecret, aad: SecretAad, key: Buffer): string {
  return decrypt(enc, encodeAad(aad), key);
}

/**
 * A provider API key saved in Settings: AES-256-GCM with SECRETS_ENCRYPTION_KEY, as run secrets, bound to
 * its tenant and provider through the AAD `["llm-provider-key", tenantId, provider]`.
 */
export function encryptProviderKey(plain: string, aad: ProviderKeyAad, key: Buffer): EncryptedSecret {
  return encrypt(plain, encodeProviderKeyAad(aad), key);
}

/** The worker's only way to read a saved key. Throws when anything differs (e.g. SECRETS_ENCRYPTION_KEY was rotated). */
export function decryptProviderKey(enc: EncryptedSecret, aad: ProviderKeyAad, key: Buffer): string {
  return decrypt(enc, encodeProviderKeyAad(aad), key);
}
```

- [ ] **Step 4: Write the failing repository test** — `packages/db/src/llm-settings-repository.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmSettingsRepository, ProviderKeyRepository } from "./llm-settings-repository";
import { OTHER_TENANT_ID, TEST_TENANT_ID, createTestDatabase, type TestDatabase } from "./testing";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => tdb?.drop());

/** Stand-in ciphertext (the API encrypts with encryptProviderKey before saving). */
const encrypted = (tag: string) => ({ ciphertext: Buffer.from(`cipher-${tag}`), iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2) });

describe("LlmSettingsRepository", () => {
  it("has no row until defaults are saved; saving again replaces them, per tenant", async () => {
    const repo = new LlmSettingsRepository(tdb.db);
    expect(await repo.get(TEST_TENANT_ID)).toBeNull();
    const first = await repo.upsertDefaults(TEST_TENANT_ID, { model: "claude-sonnet-5", reasoning: "default" });
    expect(first).toMatchObject({ model: "claude-sonnet-5", reasoning: "default" });
    const second = await repo.upsertDefaults(TEST_TENANT_ID, { model: "gemini-3.8-flash", reasoning: "low" });
    expect(await repo.get(TEST_TENANT_ID)).toEqual(second);
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(await repo.get(OTHER_TENANT_ID)).toBeNull();
  });

  it("the database refuses a reasoning level the contract does not have", async () => {
    await expect(
      tdb.pool.query("INSERT INTO llm_settings (tenant_id, default_model, default_reasoning) VALUES ($1, 'x', 'xhigh')", [OTHER_TENANT_ID]),
    ).rejects.toThrow(/reasoning_level/);
  });
});

describe("ProviderKeyRepository", () => {
  it("saves, replaces and removes a key per tenant and provider; statuses never carry key material", async () => {
    const keys = new ProviderKeyRepository(tdb.db);
    expect(await keys.listStatus(TEST_TENANT_ID)).toEqual([]);
    await keys.set(TEST_TENANT_ID, "gemini", encrypted("g1"));
    await keys.set(TEST_TENANT_ID, "anthropic", encrypted("a1"));
    const replaced = await keys.set(TEST_TENANT_ID, "gemini", encrypted("g2"));
    expect(replaced).toEqual({ provider: "gemini", updatedAt: expect.any(Date) });

    const status = await keys.listStatus(TEST_TENANT_ID);
    expect(status.map((s) => s.provider)).toEqual(["anthropic", "gemini"]);
    for (const s of status) expect(Object.keys(s).sort()).toEqual(["provider", "updatedAt"]);
    expect(JSON.stringify(status)).not.toContain("cipher-");

    expect((await keys.getEncrypted(TEST_TENANT_ID, "gemini"))!.ciphertext.toString()).toBe("cipher-g2");
    expect(await keys.getEncrypted(OTHER_TENANT_ID, "gemini")).toBeNull();
    expect(await keys.remove(TEST_TENANT_ID, "gemini")).toBe(true);
    expect(await keys.remove(TEST_TENANT_ID, "gemini")).toBe(false);
    expect((await keys.listStatus(TEST_TENANT_ID)).map((s) => s.provider)).toEqual(["anthropic"]);
  });

  it("the database holds keys only for anthropic and gemini", async () => {
    await expect(
      tdb.pool.query("INSERT INTO llm_provider_keys (tenant_id, provider, ciphertext, iv, auth_tag) VALUES ($1, 'openai', '\\x00', '\\x00', '\\x00')", [TEST_TENANT_ID]),
    ).rejects.toThrow(/llm_provider_keys_provider/);
  });
});
```

- [ ] **Step 5: Run it to see it fail**

Run: `pnpm --filter @platform/db exec vitest run src/llm-settings-repository.test.ts`
Expected: FAIL — `Failed to load url ./llm-settings-repository`.

- [ ] **Step 6: Add the tables to `packages/db/src/schema.ts`**

Add `ReasoningLevelSchema,` to the `@platform/contracts` import (between `ErrorCategorySchema,` and `RunLifecycleSchema,`) and `primaryKey,` to the `drizzle-orm/pg-core` import (between `pgTable,` and `text,`). After the `artifactSensitivityEnum` line add:

```ts
export const reasoningLevelEnum = pgEnum("reasoning_level", values(ReasoningLevelSchema.options));
```

Append at the end of the file:

```ts

/** Settings → Defaults for new tests, per tenant. No row: the defaults come from the LLM_* environment. */
export const llmSettings = pgTable("llm_settings", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id),
  /** A model id from the @platform/llm catalog (checked by the API when saved). */
  defaultModel: text("default_model").notNull(),
  defaultReasoning: reasoningLevelEnum("default_reasoning").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Settings → AI providers: each tenant's saved API key per provider, AES-256-GCM with SECRETS_ENCRYPTION_KEY
 * (AAD ["llm-provider-key", tenantId, provider]). Long-lived, unlike run secrets.
 */
export const llmProviderKeys = pgTable(
  "llm_provider_keys",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    provider: text("provider").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    authTag: bytea("auth_tag").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.provider] }),
    check("llm_provider_keys_provider", sql`${t.provider} IN ('anthropic', 'gemini')`),
  ],
);
```

- [ ] **Step 7: Generate the migration**

Run: `pnpm --filter @platform/db exec drizzle-kit generate --name llm_settings`
Expected: `[✓] Your SQL migration file ➜ migrations/0001_llm_settings.sql`, a new `migrations/meta/0001_snapshot.json`, and a second entry (`"tag": "0001_llm_settings"`) in `migrations/meta/_journal.json`. The SQL must read exactly (review it; do not hand-edit it):

```sql
CREATE TYPE "public"."reasoning_level" AS ENUM('default', 'minimal', 'low', 'medium', 'high');--> statement-breakpoint
CREATE TABLE "llm_provider_keys" (
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_provider_keys_tenant_id_provider_pk" PRIMARY KEY("tenant_id","provider"),
	CONSTRAINT "llm_provider_keys_provider" CHECK ("llm_provider_keys"."provider" IN ('anthropic', 'gemini'))
);
--> statement-breakpoint
CREATE TABLE "llm_settings" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"default_model" text NOT NULL,
	"default_reasoning" "reasoning_level" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_provider_keys" ADD CONSTRAINT "llm_provider_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_settings" ADD CONSTRAINT "llm_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
```

(drizzle-kit only diffs `schema.ts` against `meta/0000_snapshot.json`; it needs no database. The test template database is keyed by a hash of the migration files, so every DB test from now on runs on a template with the new tables.)

- [ ] **Step 8: Implement the repositories** — `packages/db/src/llm-settings-repository.ts`

```ts
import { LlmKeyProviderSchema, ReasoningLevelSchema, type LlmKeyProvider, type ReasoningLevel } from "@platform/contracts";
import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { llmProviderKeys, llmSettings } from "./schema";

/** A tenant's saved defaults for new tests (Settings → Defaults for new tests). */
export interface LlmDefaultsRow {
  model: string;
  reasoning: ReasoningLevel;
  updatedAt: Date;
}

/** Settings' saved defaults. No row: new runs use the LLM_* environment's defaults. */
export class LlmSettingsRepository {
  constructor(private readonly db: Executor) {}

  async get(tenantId: string): Promise<LlmDefaultsRow | null> {
    const [row] = await this.db.select().from(llmSettings).where(eq(llmSettings.tenantId, tenantId));
    return row ? { model: row.defaultModel, reasoning: row.defaultReasoning, updatedAt: row.updatedAt } : null;
  }

  /** Saves the defaults (the API has checked them against the catalog), replacing any saved before. */
  async upsertDefaults(tenantId: string, defaults: { model: string; reasoning: ReasoningLevel }): Promise<LlmDefaultsRow> {
    const set = { defaultModel: defaults.model, defaultReasoning: ReasoningLevelSchema.parse(defaults.reasoning), updatedAt: new Date() };
    const [row] = await this.db
      .insert(llmSettings)
      .values({ tenantId, ...set })
      .onConflictDoUpdate({ target: llmSettings.tenantId, set })
      .returning();
    return { model: row!.defaultModel, reasoning: row!.defaultReasoning, updatedAt: row!.updatedAt };
  }
}

/** A saved key as stored: the output of @platform/security's encryptProviderKey (db does not depend on security). */
export interface EncryptedProviderKey {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/** Which providers have a saved key, and since when. Never the key. */
export interface ProviderKeyStatus {
  provider: LlmKeyProvider;
  updatedAt: Date;
}

/**
 * Saved provider API keys, encrypted by the API before they reach this repository; nothing here ever sees a
 * plaintext key. Only `getEncrypted` returns key material (ciphertext), for the worker to decrypt.
 */
export class ProviderKeyRepository {
  constructor(private readonly db: Executor) {}

  async listStatus(tenantId: string): Promise<ProviderKeyStatus[]> {
    const rows = await this.db
      .select({ provider: llmProviderKeys.provider, updatedAt: llmProviderKeys.updatedAt })
      .from(llmProviderKeys)
      .where(eq(llmProviderKeys.tenantId, tenantId))
      .orderBy(asc(llmProviderKeys.provider));
    return rows.map((r) => ({ provider: LlmKeyProviderSchema.parse(r.provider), updatedAt: r.updatedAt }));
  }

  /** Saves or replaces the tenant's key for `provider`. */
  async set(tenantId: string, provider: LlmKeyProvider, key: EncryptedProviderKey): Promise<ProviderKeyStatus> {
    const set = { ciphertext: key.ciphertext, iv: key.iv, authTag: key.authTag, updatedAt: new Date() };
    const [row] = await this.db
      .insert(llmProviderKeys)
      .values({ tenantId, provider: LlmKeyProviderSchema.parse(provider), ...set })
      .onConflictDoUpdate({ target: [llmProviderKeys.tenantId, llmProviderKeys.provider], set })
      .returning({ updatedAt: llmProviderKeys.updatedAt });
    return { provider, updatedAt: row!.updatedAt };
  }

  /** Deletes the saved key; false when there was none. */
  async remove(tenantId: string, provider: LlmKeyProvider): Promise<boolean> {
    const rows = await this.db
      .delete(llmProviderKeys)
      .where(and(eq(llmProviderKeys.tenantId, tenantId), eq(llmProviderKeys.provider, provider)))
      .returning({ provider: llmProviderKeys.provider });
    return rows.length > 0;
  }

  /** Worker only: what decryptProviderKey needs; null when no key is saved. */
  async getEncrypted(tenantId: string, provider: LlmKeyProvider): Promise<EncryptedProviderKey | null> {
    const [row] = await this.db
      .select({ ciphertext: llmProviderKeys.ciphertext, iv: llmProviderKeys.iv, authTag: llmProviderKeys.authTag })
      .from(llmProviderKeys)
      .where(and(eq(llmProviderKeys.tenantId, tenantId), eq(llmProviderKeys.provider, provider)));
    return row ?? null;
  }
}
```

In `packages/db/src/index.ts`, after `export * from "./llm-call-repository";` add:

```ts
export * from "./llm-settings-repository";
```

- [ ] **Step 9: Run the security and db tests and the typecheck**

Run: `pnpm --filter @platform/security test && pnpm --filter @platform/db test && pnpm typecheck`
Expected: PASS (every DB test file now clones the migrated template, which includes 0001).

- [ ] **Step 10: Commit**

```bash
git add packages/security/src/secret-vault.ts packages/security/src/secret-vault.test.ts packages/security/src/redaction.test.ts packages/db/src/schema.ts packages/db/src/index.ts packages/db/src/llm-settings-repository.ts packages/db/src/llm-settings-repository.test.ts packages/db/migrations/0001_llm_settings.sql packages/db/migrations/meta/0001_snapshot.json packages/db/migrations/meta/_journal.json
git commit -m "feat: encrypted provider keys and saved model defaults (llm_settings, llm_provider_keys)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: API — AI provider settings endpoints

**Files:**
- Create: `apps/api/src/services/llm-choice.ts`, `apps/api/src/services/llm-choice.test.ts`
- Create: `apps/api/src/services/llm-settings-service.ts`
- Create: `apps/api/src/routes/llm-settings.ts`, `apps/api/src/routes/llm-settings.test.ts`
- Modify: `apps/api/src/deps.ts` (`ApiConfig.llm`), `apps/api/src/app.ts`, `apps/api/src/main.ts`, `apps/api/src/test-support.ts`
- Modify: `apps/api/package.json` (+ `@platform/llm`), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 1 schemas; `MODEL_CATALOG`, `PROVIDER_LABELS`, `catalogModel`, `CatalogModel` from `@platform/llm/catalog` and `priceFor` from `@platform/llm/pricing` (Task 3); `resolveEnvLlmChoice` (Task 2); `encryptProviderKey` (Task 6); `LlmSettingsRepository`, `ProviderKeyRepository` (Task 6).
- Produces: `ApiConfig.llm: ApiLlmConfig` where `interface ApiLlmConfig { envChoice: LlmChoice; envKeys: Record<LlmKeyProvider, boolean>; fakeAllowed: boolean }`; `FAKE_LLM` (test-support default); `llm-choice.ts`: `interface LlmAvailability { keys: Record<LlmKeyProvider, boolean>; fakeAllowed: boolean }`, `type ChoiceResult = { ok: true; choice: LlmChoice } | { ok: false; issue: { path: (string | number)[]; message: string } }`, `offeredModels(a)`, `providerAvailable(provider, a)`, `addKeyHint(provider)`, `checkModel(model, reasoning, a, at)`, `resolveRunLlm({ override, saved, env, availability }): ChoiceResult`; `llm-settings-service.ts`: `class LlmSettingsService { state(tenantId); view(tenantId); saveDefaults(tenantId, defaults); saveKey(tenantId, provider, apiKey) }`, `modelNotAvailable(issue): HttpError`. HTTP: `GET /v1/settings/llm`, `PUT /v1/settings/llm`, `PUT /v1/settings/llm/keys/:provider`.

- [ ] **Step 1: Write the failing unit tests** — `apps/api/src/services/llm-choice.test.ts` (no database)

```ts
import type { LlmChoice } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { addKeyHint, checkModel, offeredModels, resolveRunLlm, type LlmAvailability } from "./llm-choice";

const ALL_KEYS: LlmAvailability = { keys: { anthropic: true, gemini: true }, fakeAllowed: true };
const ANTHROPIC_ONLY: LlmAvailability = { keys: { anthropic: true, gemini: false }, fakeAllowed: true };
const NO_KEYS: LlmAvailability = { keys: { anthropic: false, gemini: false }, fakeAllowed: true };
const ENV: LlmChoice = { provider: "anthropic", model: "claude-sonnet-5", reasoning: "default" };
const resolve = (input: Partial<Parameters<typeof resolveRunLlm>[0]>) =>
  resolveRunLlm({ override: undefined, saved: null, env: ENV, availability: ANTHROPIC_ONLY, ...input });

describe("offeredModels / addKeyHint", () => {
  it("offers the fake engine only outside production", () => {
    expect(offeredModels(ALL_KEYS).map((m) => m.id)).toContain("fake");
    expect(offeredModels({ ...ALL_KEYS, fakeAllowed: false }).map((m) => m.id)).not.toContain("fake");
  });

  it("names the fix", () => {
    expect(addKeyHint("anthropic")).toBe("Add an Anthropic API key in Settings");
    expect(addKeyHint("gemini")).toBe("Add a Google Gemini API key in Settings");
  });
});

describe("checkModel (Settings defaults)", () => {
  const at = { model: ["defaults", "model"], reasoning: ["defaults", "reasoning"] };

  it("accepts an offered model whose provider has a key, at one of its levels", () => {
    expect(checkModel("gemini-3.5-flash", "minimal", ALL_KEYS, at)).toEqual({ ok: true, choice: { provider: "gemini", model: "gemini-3.5-flash", reasoning: "minimal" } });
  });

  it.each([
    ["an unknown model", "gpt-x", "default", ALL_KEYS, ["defaults", "model"], /not a model offered here/],
    ["a provider without a key", "gemini-3.8-flash", "default", ANTHROPIC_ONLY, ["defaults", "model"], /^Add a Google Gemini API key in Settings$/],
    ["a level the model does not take", "claude-haiku-4-5", "high", ALL_KEYS, ["defaults", "reasoning"], /Claude Haiku 4.5 takes the reasoning levels default, not high/],
    ["minimal on Claude", "claude-sonnet-5", "minimal", ALL_KEYS, ["defaults", "reasoning"], /not minimal/],
    ["the fake engine in production", "fake", "default", { ...ALL_KEYS, fakeAllowed: false }, ["defaults", "model"], /not a model offered here/],
  ] as const)("refuses %s", (_what, model, level, availability, path, message) => {
    const r = checkModel(model, level, availability, at);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue.path).toEqual(path);
    expect(r.issue.message).toMatch(message);
  });
});

describe("resolveRunLlm: request → Settings → environment", () => {
  const saved = { model: "claude-opus-5-5", reasoning: "medium" as const };

  it("the request's model wins, with its level or default", () => {
    expect(resolve({ override: { model: "claude-fable-5-1", reasoning: "low" }, saved })).toEqual({
      ok: true,
      choice: { provider: "anthropic", model: "claude-fable-5-1", reasoning: "low" },
    });
    expect(resolve({ override: { model: "claude-fable-5-1" }, saved })).toMatchObject({ choice: { reasoning: "default" } });
  });

  it("the request's model is checked: offered, with a key, at one of its levels", () => {
    expect(resolve({ override: { model: "gemini-3.8-flash" } })).toEqual({
      ok: false,
      issue: { path: ["llm", "model"], message: "Add a Google Gemini API key in Settings" },
    });
    expect(resolve({ override: { model: "claude-sonnet-4-6" } })).toMatchObject({ ok: false, issue: { path: ["llm", "model"] } });
    expect(resolve({ override: { model: "claude-haiku-4-5", reasoning: "low" } })).toMatchObject({ ok: false, issue: { path: ["llm", "reasoning"] } });
  });

  it("no model in the request: the saved defaults, with the request's level when their model takes it", () => {
    expect(resolve({ saved })).toEqual({ ok: true, choice: { provider: "anthropic", model: "claude-opus-5-5", reasoning: "medium" } });
    expect(resolve({ saved, override: { reasoning: "high" } })).toMatchObject({ choice: { model: "claude-opus-5-5", reasoning: "high" } });
    expect(resolve({ saved: { model: "claude-haiku-4-5", reasoning: "default" }, override: { reasoning: "high" } })).toMatchObject({
      ok: false,
      issue: { path: ["llm", "reasoning"] },
    });
  });

  it("saved defaults whose provider lost its key: refused at the defaults, naming the fix", () => {
    expect(resolve({ saved: { model: "gemini-3.8-flash", reasoning: "low" } })).toEqual({
      ok: false,
      issue: { path: ["llm"], message: "Add a Google Gemini API key in Settings: the default model (Gemini 3.8 Flash) needs it" },
    });
  });

  it("nothing saved: the environment's choice, even a model outside the catalog (as the operator configured it)", () => {
    expect(resolve({})).toEqual({ ok: true, choice: ENV });
    const custom: LlmChoice = { provider: "anthropic", model: "claude-opus-5", reasoning: "default" };
    expect(resolve({ env: custom })).toEqual({ ok: true, choice: custom });
    expect(resolve({ env: custom, override: { reasoning: "default" } })).toEqual({ ok: true, choice: custom });
    expect(resolve({ env: custom, override: { reasoning: "high" } })).toMatchObject({ ok: false, issue: { path: ["llm", "reasoning"] } });
    expect(resolve({ env: { provider: "gemini", model: "gemini-3.8-flash", reasoning: "low" }, availability: ALL_KEYS })).toMatchObject({
      choice: { provider: "gemini", reasoning: "low" },
    });
  });

  it("the environment's provider without a key: refused at the defaults", () => {
    expect(resolve({ availability: NO_KEYS })).toEqual({
      ok: false,
      issue: { path: ["llm"], message: "Add an Anthropic API key in Settings: the default model (Claude Sonnet 5) needs it" },
    });
  });

  it("the fake engine needs no key, and is refused in production", () => {
    const fake: LlmChoice = { provider: "fake", model: "fake", reasoning: "default" };
    expect(resolve({ env: fake, availability: NO_KEYS })).toEqual({ ok: true, choice: fake });
    expect(resolve({ override: { model: "fake" }, availability: NO_KEYS })).toEqual({ ok: true, choice: fake });
    expect(resolve({ override: { model: "fake" }, availability: { ...NO_KEYS, fakeAllowed: false } })).toMatchObject({ ok: false, issue: { path: ["llm", "model"] } });
  });
});
```

- [ ] **Step 2: Write the failing route tests** — `apps/api/src/routes/llm-settings.test.ts`

```ts
import { LlmSettingsViewSchema, type LlmSettingsView } from "@platform/contracts";
import { ProviderKeyRepository, schema } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { decryptProviderKey } from "@platform/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiLlmConfig } from "../deps";
import { SECRETS_KEY, auth, createTestApi, type TestApi } from "../test-support";

let t: TestApi;
beforeAll(async () => {
  t = await createTestApi();
});
afterAll(async () => t?.close());

/** The environment: LLM_PROVIDER=anthropic, default model, and which keys it sets. */
const env = (keys: Partial<ApiLlmConfig["envKeys"]> = {}, patch: Partial<ApiLlmConfig> = {}): ApiLlmConfig => ({
  envChoice: { provider: "anthropic", model: "claude-sonnet-5", reasoning: "default" },
  envKeys: { anthropic: false, gemini: false, ...keys },
  fakeAllowed: true,
  ...patch,
});

beforeEach(async () => {
  t.deps.config.llm = env();
  t.audit.length = 0;
  await t.tdb.db.delete(schema.llmProviderKeys);
  await t.tdb.db.delete(schema.llmSettings);
});

const get = () => t.app.inject({ method: "GET", url: "/v1/settings/llm", headers: auth });
const putDefaults = (defaults: unknown) => t.app.inject({ method: "PUT", url: "/v1/settings/llm", headers: auth, payload: { defaults } });
const putKey = (provider: string, apiKey: string | null) =>
  t.app.inject({ method: "PUT", url: `/v1/settings/llm/keys/${provider}`, headers: auth, payload: { apiKey } });
const viewOf = (res: { json(): unknown }): LlmSettingsView => LlmSettingsViewSchema.parse(res.json());
const storedKey = async (provider: "anthropic" | "gemini") => {
  const enc = await new ProviderKeyRepository(t.tdb.db).getEncrypted(TEST_TENANT_ID, provider);
  return enc && decryptProviderKey(enc, { tenantId: TEST_TENANT_ID, provider }, SECRETS_KEY);
};

describe("GET /v1/settings/llm", () => {
  it("with nothing saved: the environment's defaults and keys, and every offered model with its levels, price and availability", async () => {
    t.deps.config.llm = env({ anthropic: true });
    const view = viewOf(await get());
    expect(view.defaults).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      reasoning: "default",
      source: "environment",
      available: true,
    });
    expect(view.providers).toEqual([
      { provider: "anthropic", label: "Anthropic", key: { source: "environment", updatedAt: null } },
      { provider: "gemini", label: "Google Gemini", key: { source: null, updatedAt: null } },
    ]);
    expect(view.models.map((m) => m.id)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-pro-preview",
      "fake",
    ]);
    expect(view.models.find((m) => m.id === "claude-opus-5-5")).toEqual({
      provider: "anthropic",
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      reasoningLevels: ["default", "low", "medium", "high"],
      defaultLevel: "medium",
      price: { inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
      available: true,
    });
    expect(view.models.find((m) => m.id === "gemini-3.8-flash")!.available).toBe(false);
    expect(view.models.find((m) => m.id === "fake")).toMatchObject({ price: null, available: true });
  });

  it("in production the fake engine is not offered", async () => {
    t.deps.config.llm = env({ anthropic: true }, { fakeAllowed: false });
    expect(viewOf(await get()).models.map((m) => m.id)).not.toContain("fake");
  });

  it("an environment model outside the catalog is shown by its id, and stays usable", async () => {
    t.deps.config.llm = env({ anthropic: true }, { envChoice: { provider: "anthropic", model: "claude-opus-5", reasoning: "default" } });
    const view = viewOf(await get());
    expect(view.defaults).toMatchObject({ model: "claude-opus-5", label: "claude-opus-5", source: "environment", available: true });
    expect(view.models.map((m) => m.id)).not.toContain("claude-opus-5");
  });

  it("the answer never contains a key, saved or from the environment (raw body)", async () => {
    t.deps.config.llm = env({ anthropic: true });
    const saved = "AIza-Saved-Gemini-Key-0042";
    const put = await putKey("gemini", saved);
    expect(put.statusCode).toBe(200);
    const res = await get();
    for (const body of [put.body, res.body]) {
      expect(body).not.toContain(saved);
      expect(body).not.toMatch(/apiKey|ciphertext/i);
    }
    expect(viewOf(res).providers).toEqual([
      { provider: "anthropic", label: "Anthropic", key: { source: "environment", updatedAt: null } },
      { provider: "gemini", label: "Google Gemini", key: { source: "settings", updatedAt: expect.any(String) } },
    ]);
  });
});

describe("PUT /v1/settings/llm/keys/:provider", () => {
  it("saves a key encrypted and trimmed, replaces it, removes it; audit lines name the provider, never the key", async () => {
    const first = "AIza-First-Key-111";
    const second = "AIza-Second-Key-222";
    expect((await putKey("gemini", `  ${first}\n`)).statusCode).toBe(200); // pasted with a trailing newline
    expect(await storedKey("gemini")).toBe(first);
    const replaced = viewOf(await putKey("gemini", second));
    expect(replaced.providers[1]!.key.source).toBe("settings");
    expect(await storedKey("gemini")).toBe(second);
    const removed = viewOf(await putKey("gemini", null));
    expect(removed.providers[1]!.key).toEqual({ source: null, updatedAt: null });
    expect(await storedKey("gemini")).toBeNull();

    expect(t.audit.map((a) => [a.action, a.provider])).toEqual([
      ["settings.llm.key_saved", "gemini"],
      ["settings.llm.key_saved", "gemini"],
      ["settings.llm.key_removed", "gemini"],
    ]);
    expect(JSON.stringify(t.audit)).not.toMatch(/AIza-/);
  });

  it("removing the saved key falls back to the environment's: the defaults stay usable", async () => {
    t.deps.config.llm = env({ anthropic: true });
    await putKey("anthropic", "sk-ant-api03-Saved-Key");
    const view = viewOf(await putKey("anthropic", null));
    expect(view.providers[0]!.key).toEqual({ source: "environment", updatedAt: null });
    expect(view.defaults.available).toBe(true);
  });

  it("removing a key that was never saved changes nothing and writes no audit line", async () => {
    expect((await putKey("anthropic", null)).statusCode).toBe(200);
    expect(t.audit).toEqual([]);
  });

  it("a malformed key → 400 VALIDATION_FAILED on apiKey, without the value", async () => {
    const res = await putKey("anthropic", "sk-ant with-a-space-Secret");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ path: ["apiKey"] }] });
    expect(res.body).not.toContain("with-a-space-Secret");
    expect(await storedKey("anthropic")).toBeNull();
  });

  it.each(["openai", "fake", "ANTHROPIC"])("an unknown provider (%s) → 404", async (provider) => {
    expect((await putKey(provider, "sk-test-key")).statusCode).toBe(404);
  });
});

describe("PUT /v1/settings/llm (defaults for new tests)", () => {
  it("saves an offered model whose provider has a key, at one of its levels; the audit line names provider and model", async () => {
    t.deps.config.llm = env({ gemini: true });
    const res = await putDefaults({ model: "gemini-3.5-flash", reasoning: "minimal" });
    expect(res.statusCode).toBe(200);
    expect(viewOf(res).defaults).toEqual({
      provider: "gemini",
      model: "gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      reasoning: "minimal",
      source: "settings",
      available: true,
    });
    expect(t.audit).toEqual([
      expect.objectContaining({ action: "settings.llm.defaults_saved", provider: "gemini", model: "gemini-3.5-flash", reasoning: "minimal" }),
    ]);
  });

  it.each([
    ["an unknown model", { model: "gpt-x", reasoning: "default" }, ["defaults", "model"]],
    ["a provider without a key", { model: "claude-sonnet-5", reasoning: "default" }, ["defaults", "model"]],
    ["a level the model does not take", { model: "gemini-3.8-flash", reasoning: "minimal" }, ["defaults", "reasoning"]],
  ])("refuses %s: 422 MODEL_NOT_AVAILABLE with the issue path", async (_what, defaults, path) => {
    t.deps.config.llm = env({ gemini: true });
    const res = await putDefaults(defaults);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "MODEL_NOT_AVAILABLE", issues: [{ path }] });
    expect(viewOf(await get()).defaults.source).toBe("environment");
  });

  it("a key named in the message when the provider has none", async () => {
    expect((await putDefaults({ model: "claude-opus-5-5", reasoning: "low" })).json()).toMatchObject({ message: "Add an Anthropic API key in Settings" });
  });

  it("the fake engine cannot be the default in production", async () => {
    t.deps.config.llm = env({ anthropic: true }, { fakeAllowed: false });
    expect((await putDefaults({ model: "fake", reasoning: "default" })).statusCode).toBe(422);
  });

  it("a malformed body → 400 VALIDATION_FAILED", async () => {
    expect((await putDefaults({ model: "claude-sonnet-5" })).json()).toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("removing the key the saved defaults rely on is allowed: the defaults then show unavailable", async () => {
    await putKey("gemini", "AIza-Only-Key-333");
    expect((await putDefaults({ model: "gemini-3.8-flash", reasoning: "high" })).statusCode).toBe(200);
    const view = viewOf(await putKey("gemini", null));
    expect(view.defaults).toMatchObject({ model: "gemini-3.8-flash", source: "settings", available: false });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @platform/api exec vitest run src/services/llm-choice.test.ts src/routes/llm-settings.test.ts`
Expected: FAIL — `llm-choice.test.ts`: `Failed to load url ./llm-choice`; `llm-settings.test.ts`: every test fails on `404` (no route yet; `ApiLlmConfig` is a type import, erased at run time).

- [ ] **Step 4: Give the API the catalog** — in `apps/api/package.json`, in `"dependencies"`, add `"@platform/llm": "workspace:*",` right after `"@platform/event-bus": "workspace:*",`. Run: `pnpm install` (only the `apps/api` importer of `pnpm-lock.yaml` changes). The API imports only `@platform/llm/catalog` and `@platform/llm/pricing`, which load no provider SDK (Task 3's test pins it).

- [ ] **Step 5: The model-choice rules** — `apps/api/src/services/llm-choice.ts`

```ts
import type { LlmChoice, LlmKeyProvider, LlmOverride, LlmProvider, ReasoningLevel } from "@platform/contracts";
import { MODEL_CATALOG, PROVIDER_LABELS, catalogModel, type CatalogModel } from "@platform/llm/catalog";

/** Which models this deployment can run now. */
export interface LlmAvailability {
  /** A key is saved in Settings or set in the environment (the API shares the worker's LLM_* variables). */
  keys: Record<LlmKeyProvider, boolean>;
  /** The fake engine is offered: NODE_ENV is not production. */
  fakeAllowed: boolean;
}

export type IssuePath = (string | number)[];
export interface ChoiceIssue {
  path: IssuePath;
  message: string;
}
export type ChoiceResult = { ok: true; choice: LlmChoice } | { ok: false; issue: ChoiceIssue };

/** The catalog as this deployment offers it: the fake engine only outside production. */
export function offeredModels(a: LlmAvailability): CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.provider !== "fake" || a.fakeAllowed);
}

/** A model of this provider can run now: its key exists (the fake engine: it is offered). */
export function providerAvailable(provider: LlmProvider, a: LlmAvailability): boolean {
  return provider === "fake" ? a.fakeAllowed : a.keys[provider];
}

/** The fix for a missing key, in the words the UI uses: "Add an Anthropic API key in Settings". */
export function addKeyHint(provider: LlmKeyProvider): string {
  return `Add ${provider === "anthropic" ? "an" : "a"} ${PROVIDER_LABELS[provider]} API key in Settings`;
}

const fail = (path: IssuePath, message: string): ChoiceResult => ({ ok: false, issue: { path, message } });
const levelsOf = (m: CatalogModel) => m.reasoningLevels.join(", ");

/**
 * A model a client names (a run's `llm.model`, or the defaults saved in Settings): it must be offered here, its
 * provider must have a key, and `reasoning` must be one of its levels. Issues are reported at `at.model` /
 * `at.reasoning`.
 */
export function checkModel(
  model: string,
  reasoning: ReasoningLevel,
  a: LlmAvailability,
  at: { model: IssuePath; reasoning: IssuePath },
): ChoiceResult {
  const m = offeredModels(a).find((o) => o.id === model);
  if (!m) return fail(at.model, `${model} is not a model offered here: choose one from the list`);
  if (m.provider !== "fake" && !a.keys[m.provider]) return fail(at.model, addKeyHint(m.provider));
  if (!m.reasoningLevels.includes(reasoning)) {
    return fail(at.reasoning, `${m.label} takes the reasoning levels ${levelsOf(m)}, not ${reasoning}`);
  }
  return { ok: true, choice: { provider: m.provider, model: m.id, reasoning } };
}

/**
 * The model choice a new run records (spec section 4), in order: the request's `llm.model` (with
 * `llm.reasoning`, default `default`); else the defaults saved in Settings (a request's `llm.reasoning` alone
 * may override their level when their model takes it); else the environment's (resolveEnvLlmChoice: a model
 * outside the catalog is accepted as the operator configured it). The chosen provider needs a key (the fake
 * engine none). Issues: `["llm", "model"]` / `["llm", "reasoning"]` for the request's own fields, `["llm"]`
 * when the defaults are at fault.
 */
export function resolveRunLlm(input: {
  override: LlmOverride | undefined;
  saved: { model: string; reasoning: ReasoningLevel } | null;
  env: LlmChoice;
  availability: LlmAvailability;
}): ChoiceResult {
  const { override, saved, env, availability: a } = input;
  if (override?.model) {
    return checkModel(override.model, override.reasoning ?? "default", a, { model: ["llm", "model"], reasoning: ["llm", "reasoning"] });
  }
  if (saved) {
    const m = offeredModels(a).find((o) => o.id === saved.model);
    if (!m) return fail(["llm"], `The default model in Settings (${saved.model}) is no longer offered: choose another in Settings`);
    return withDefaults({ provider: m.provider, model: m.id, reasoning: saved.reasoning }, m, override?.reasoning, a);
  }
  return withDefaults(env, catalogModel(env.model), override?.reasoning, a);
}

/** The defaults (saved or the environment's), with a request's own `llm.reasoning` when it gives one. */
function withDefaults(base: LlmChoice, model: CatalogModel | undefined, reasoning: ReasoningLevel | undefined, a: LlmAvailability): ChoiceResult {
  if (!providerAvailable(base.provider, a)) {
    return fail(
      ["llm"],
      base.provider === "fake"
        ? "The fake engine is not offered here: choose a default model in Settings"
        : `${addKeyHint(base.provider)}: the default model (${model?.label ?? base.model}) needs it`,
    );
  }
  if (reasoning === undefined) return { ok: true, choice: base };
  // An environment model outside the catalog takes only its own default level.
  if (reasoning !== "default" && !model?.reasoningLevels.includes(reasoning)) {
    return fail(
      ["llm", "reasoning"],
      model ? `${model.label} takes the reasoning levels ${levelsOf(model)}, not ${reasoning}` : `The default model (${base.model}) takes only its default reasoning level`,
    );
  }
  return { ok: true, choice: { ...base, reasoning } };
}
```

- [ ] **Step 6: The API's LLM environment** — in `apps/api/src/deps.ts` replace `import type { Database } from "@platform/db";` with:

```ts
import type { LlmChoice, LlmKeyProvider } from "@platform/contracts";
import type { Database } from "@platform/db";
```

and in `ApiConfig` replace:

```ts
  sseHeartbeatMs: number;
}
```

with:

```ts
  sseHeartbeatMs: number;
  /** The LLM_* environment, which the API shares with the worker (compose's x-app-env). */
  llm: ApiLlmConfig;
}

export interface ApiLlmConfig {
  /** resolveEnvLlmChoice(env): what new runs use when neither the request nor Settings name a model. */
  envChoice: LlmChoice;
  /** Which provider keys the environment sets (ANTHROPIC_API_KEY, GEMINI_API_KEY); never the keys. */
  envKeys: Record<LlmKeyProvider, boolean>;
  /** The fake engine is offered: NODE_ENV is not production. */
  fakeAllowed: boolean;
}
```

In `apps/api/src/test-support.ts` replace `import type { ApiDeps } from "./deps";` with `import type { ApiDeps, ApiLlmConfig } from "./deps";`, add after the `export const auth = …;` line:

```ts
/** The API's LLM_* environment in tests: LLM_PROVIDER=fake and no provider keys, as in local development. */
export const FAKE_LLM: ApiLlmConfig = {
  envChoice: { provider: "fake", model: "fake", reasoning: "default" },
  envKeys: { anthropic: false, gemini: false },
  fakeAllowed: true,
};
```

and in `createTestApi`'s config replace:

```ts
      sseHeartbeatMs: 20_000,
      ...overrides,
```

with:

```ts
      sseHeartbeatMs: 20_000,
      llm: FAKE_LLM,
      ...overrides,
```

In `apps/api/src/main.ts` replace `import { createLogger, loadEnvOrExit } from "@platform/config";` with `import { createLogger, loadEnvOrExit, resolveEnvLlmChoice } from "@platform/config";` and, in the `config` passed to `buildApp`, replace:

```ts
      artifactUrlTtlSeconds: 300,
      sseHeartbeatMs: 20_000,
    },
```

with:

```ts
      artifactUrlTtlSeconds: 300,
      sseHeartbeatMs: 20_000,
      llm: {
        // Throws for LLM_PROVIDER=openai (not built in V1): the API stops at start-up, as the worker does.
        envChoice: resolveEnvLlmChoice(env),
        envKeys: { anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()), gemini: Boolean(env.GEMINI_API_KEY?.trim()) },
        fakeAllowed: env.NODE_ENV !== "production",
      },
    },
```

- [ ] **Step 7: The settings service** — `apps/api/src/services/llm-settings-service.ts`

```ts
import {
  LlmSettingsViewSchema,
  type LlmChoice,
  type LlmDefaultsInput,
  type LlmKeyProvider,
  type LlmProvider,
  type LlmSettingsView,
} from "@platform/contracts";
import { LlmSettingsRepository, ProviderKeyRepository, type LlmDefaultsRow } from "@platform/db";
import { PROVIDER_LABELS, catalogModel } from "@platform/llm/catalog";
import { priceFor } from "@platform/llm/pricing";
import { encryptProviderKey } from "@platform/security";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { checkModel, offeredModels, providerAvailable, resolveRunLlm, type ChoiceIssue, type LlmAvailability } from "./llm-choice";

const KEY_PROVIDERS: readonly LlmKeyProvider[] = ["anthropic", "gemini"];

/** What decides which models a tenant's new runs may use: the saved defaults and keys, and the environment's. */
export interface LlmSettingsState {
  saved: LlmDefaultsRow | null;
  /** When each saved key was saved (never the key). */
  savedKeys: Map<LlmKeyProvider, Date>;
  availability: LlmAvailability;
}

/** 422 MODEL_NOT_AVAILABLE: the issue names the field and the fix. */
export function modelNotAvailable(issue: ChoiceIssue): HttpError {
  return new HttpError(422, "MODEL_NOT_AVAILABLE", issue.message, [issue]);
}

/** A saved model's provider: the catalog's (a model that left the catalog: by its id's prefix, for display). */
function providerOf(model: string): LlmProvider {
  return catalogModel(model)?.provider ?? (model.startsWith("gemini-") ? "gemini" : "anthropic");
}

/**
 * Settings → AI providers and defaults (spec 2026-09-28-llm-settings-design.md, sections 3–4). Keys are
 * encrypted here (encryptProviderKey) and never read back: the view reports only where each key comes from.
 */
export class LlmSettingsService {
  constructor(private readonly deps: ApiDeps) {}

  async state(tenantId: string): Promise<LlmSettingsState> {
    const [saved, keys] = await Promise.all([
      new LlmSettingsRepository(this.deps.db).get(tenantId),
      new ProviderKeyRepository(this.deps.db).listStatus(tenantId),
    ]);
    const savedKeys = new Map(keys.map((k) => [k.provider, k.updatedAt]));
    const { envKeys, fakeAllowed } = this.deps.config.llm;
    const keyed = (p: LlmKeyProvider) => savedKeys.has(p) || envKeys[p];
    return { saved, savedKeys, availability: { keys: { anthropic: keyed("anthropic"), gemini: keyed("gemini") }, fakeAllowed } };
  }

  async view(tenantId: string): Promise<LlmSettingsView> {
    const { saved, savedKeys, availability } = await this.state(tenantId);
    const { envChoice, envKeys } = this.deps.config.llm;
    const defaults = saved
      ? { provider: providerOf(saved.model), model: saved.model, reasoning: saved.reasoning, source: "settings" as const }
      : { ...envChoice, source: "environment" as const };
    // Available exactly when a run on the defaults would be accepted.
    const available = resolveRunLlm({ override: undefined, saved, env: envChoice, availability }).ok;
    return LlmSettingsViewSchema.parse({
      defaults: { ...defaults, label: catalogModel(defaults.model)?.label ?? defaults.model, available },
      providers: KEY_PROVIDERS.map((provider) => ({
        provider,
        label: PROVIDER_LABELS[provider],
        key: {
          source: savedKeys.has(provider) ? "settings" : envKeys[provider] ? "environment" : null,
          updatedAt: savedKeys.get(provider)?.toISOString() ?? null,
        },
      })),
      models: offeredModels(availability).map((m) => ({
        provider: m.provider,
        id: m.id,
        label: m.label,
        reasoningLevels: m.reasoningLevels,
        defaultLevel: m.defaultLevel,
        price: priceFor(m.id),
        available: providerAvailable(m.provider, availability),
      })),
    });
  }

  /** Saves the defaults for new tests: an offered model whose provider has a key, at one of its levels (else 422). */
  async saveDefaults(tenantId: string, defaults: LlmDefaultsInput): Promise<LlmChoice> {
    const { availability } = await this.state(tenantId);
    const checked = checkModel(defaults.model, defaults.reasoning, availability, { model: ["defaults", "model"], reasoning: ["defaults", "reasoning"] });
    if (!checked.ok) throw modelNotAvailable(checked.issue);
    await new LlmSettingsRepository(this.deps.db).upsertDefaults(tenantId, checked.choice);
    return checked.choice;
  }

  /** Encrypts and saves (or replaces) a provider key; `null` removes the saved one ("unchanged" when none was saved). */
  async saveKey(tenantId: string, provider: LlmKeyProvider, apiKey: string | null): Promise<"saved" | "removed" | "unchanged"> {
    const keys = new ProviderKeyRepository(this.deps.db);
    if (apiKey === null) return (await keys.remove(tenantId, provider)) ? "removed" : "unchanged";
    await keys.set(tenantId, provider, encryptProviderKey(apiKey, { tenantId, provider }, this.deps.config.secretsKey));
    return "saved";
  }
}
```

- [ ] **Step 8: The routes** — `apps/api/src/routes/llm-settings.ts`

```ts
import { LlmKeyProviderSchema, ProviderKeyInputSchema, UpdateLlmSettingsRequestSchema } from "@platform/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { LlmSettingsService } from "../services/llm-settings-service";
import { parseOr400 } from "./test-runs";

const KeyParams = z.object({ provider: z.string().min(1).max(40) });

/**
 * Settings → AI providers and defaults for new tests. Keys are write-only: no answer contains one, and the
 * audit lines name the provider (and model), never the key.
 */
export async function llmSettingsRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new LlmSettingsService(deps);
  const tenantId = deps.config.defaultTenantId;
  const audit = (req: FastifyRequest, entry: { action: string } & Record<string, string>) => {
    const line = { ...entry, tenantId, at: new Date().toISOString() };
    req.log.info(line, "LLM settings changed");
    deps.audit?.(line);
  };

  app.get("/v1/settings/llm", async () => service.view(tenantId));

  app.put("/v1/settings/llm", async (req) => {
    const { defaults } = parseOr400(UpdateLlmSettingsRequestSchema, req.body);
    const saved = await service.saveDefaults(tenantId, defaults);
    audit(req, { action: "settings.llm.defaults_saved", provider: saved.provider, model: saved.model, reasoning: saved.reasoning });
    return service.view(tenantId);
  });

  app.put("/v1/settings/llm/keys/:provider", async (req) => {
    const provider = LlmKeyProviderSchema.safeParse(parseOr400(KeyParams, req.params).provider);
    if (!provider.success) throw new HttpError(404, "NOT_FOUND", "Not found");
    const { apiKey } = parseOr400(ProviderKeyInputSchema, req.body);
    const outcome = await service.saveKey(tenantId, provider.data, apiKey);
    if (outcome !== "unchanged") {
      audit(req, { action: outcome === "saved" ? "settings.llm.key_saved" : "settings.llm.key_removed", provider: provider.data });
    }
    return service.view(tenantId);
  });
}
```

In `apps/api/src/app.ts` add `import { llmSettingsRoutes } from "./routes/llm-settings";` after the `artifactRoutes` import, and after `    await artifactRoutes(v1, deps);` add:

```ts
    await llmSettingsRoutes(v1, deps);
```

(`parseOr400` answers `400 VALIDATION_FAILED` with the Zod issues' paths and messages only — never the input — and the error handler logs request errors only at 5xx, so a rejected key is not logged either.)

- [ ] **Step 9: Run the API tests and the typecheck**

Run: `pnpm --filter @platform/api test && pnpm typecheck`
Expected: PASS (every existing API test runs on `FAKE_LLM`: its runs need no key).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/llm-choice.ts apps/api/src/services/llm-choice.test.ts apps/api/src/services/llm-settings-service.ts apps/api/src/routes/llm-settings.ts apps/api/src/routes/llm-settings.test.ts apps/api/src/deps.ts apps/api/src/app.ts apps/api/src/main.ts apps/api/src/test-support.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat: AI provider settings API (write-only keys, defaults for new tests)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: API — run creation records the model choice; summaries name it

**Files:**
- Modify: `packages/contracts/src/run.ts` (create-request `llm`, summary `llm`), `packages/contracts/src/contracts.test.ts`
- Modify: `packages/db/src/run-repository.ts` (`toRunSummary`), `packages/db/src/run-repository.test.ts`
- Modify: `apps/api/src/services/test-run-service.ts`, `apps/api/src/routes/test-runs.test.ts`
- Modify: `apps/web/test/fixtures.ts` (`summaryFixture`)

**Interfaces:**
- Consumes: `LlmOverrideSchema`, `LlmProviderSchema`, `ReasoningLevelSchema` (Task 1); `resolveRunLlm` (Task 7); `LlmSettingsService.state`, `modelNotAvailable` (Task 7); `catalogModel` (Task 3).
- Produces: `CreateTestRunRequestSchema` gains `llm: LlmOverrideSchema.optional()`; `TestRunSummarySchema` gains `llm: { provider, model, label, reasoning } | null`; `toRunSummary(run: TestRun, modelLabel?: (model: string) => string): TestRunSummary` (default: the id); `POST /v1/test-runs` stores the resolved choice as `request.llm` or answers `422 MODEL_NOT_AVAILABLE`.

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/contracts.test.ts` — add `TestRunSummarySchema,` to the `./index` import (after `TestReportSchema,`); inside `describe("CreateTestRunRequestSchema", …)` add before the test "rejects rerun without generation":

```ts
  it("takes an optional model / reasoning override for this run (shape only: the API checks the catalog)", () => {
    expect(CreateTestRunRequestSchema.parse(baseReq).llm).toBeUndefined();
    expect(CreateTestRunRequestSchema.parse({ ...baseReq, llm: { model: "gemini-3.8-flash" } }).llm).toEqual({ model: "gemini-3.8-flash" });
    expect(CreateTestRunRequestSchema.parse({ ...baseReq, llm: { reasoning: "high" } }).llm).toEqual({ reasoning: "high" });
    expect(CreateTestRunRequestSchema.safeParse({ ...baseReq, llm: { model: "" } }).success).toBe(false);
    expect(CreateTestRunRequestSchema.safeParse({ ...baseReq, llm: { reasoning: "extreme" } }).success).toBe(false);
  });
```

and add before `describe("statuses", …)`:

```ts
describe("TestRunSummarySchema", () => {
  const summary = {
    runId: "run_1",
    lifecycle: "QUEUED",
    verdict: null,
    errorCategory: null,
    cancelReason: null,
    targetUrl: "https://x.com",
    environment: "staging", // A
    allowDestructiveActions: false, // A
    requirementPreview: "Test the login page",
    createdAt: "2026-09-28T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  };

  it("carries the run's model choice with its catalog label, or null for runs created before model choice", () => {
    const llm = { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "medium" };
    expect(TestRunSummarySchema.safeParse({ ...summary, llm }).success).toBe(true);
    expect(TestRunSummarySchema.safeParse({ ...summary, llm: null }).success).toBe(true);
    expect(TestRunSummarySchema.safeParse(summary).success).toBe(false);
  });
});
```

`packages/db/src/run-repository.test.ts` — inside `describe("RunRepository", …)` add before the test "resolves concurrent transitions by CAS: exactly one wins":

```ts
  it("the summary carries the run's recorded model choice, labelled by the caller; null for runs created before model choice", async () => {
    const chosen = await runs.create({
      tenantId: TEST_TENANT_ID,
      targetUrl: "https://shop.example.com",
      request: storedRequest({ llm: { provider: "anthropic", model: "claude-opus-5-5", reasoning: "high" } }),
    });
    expect(toRunSummary(chosen, (model) => `label of ${model}`).llm).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      label: "label of claude-opus-5-5",
      reasoning: "high",
    });
    expect(toRunSummary(chosen).llm?.label).toBe("claude-opus-5-5");
    expect(toRunSummary(await create()).llm).toBeNull();
  });
```

`apps/api/src/routes/test-runs.test.ts` — replace the imports at the top:

```ts
import { TestRunSummarySchema } from "@platform/contracts";
import { EventRepository, RunRepository, SecretRepository, schema } from "@platform/db";
import { OTHER_TENANT_ID } from "@platform/db/testing";
import { runCancelChannel } from "@platform/event-bus";
import { decryptSecret } from "@platform/security";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REDIS_URL, SECRETS_KEY, auth, createTestApi, validBody, type TestApi } from "../test-support";
```

with:

```ts
import { TestRunSummarySchema } from "@platform/contracts";
import { EventRepository, LlmSettingsRepository, ProviderKeyRepository, RunRepository, SecretRepository, schema } from "@platform/db";
import { OTHER_TENANT_ID, TEST_TENANT_ID } from "@platform/db/testing";
import { runCancelChannel } from "@platform/event-bus";
import { decryptSecret, encryptProviderKey } from "@platform/security";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiLlmConfig } from "../deps";
import { FAKE_LLM, REDIS_URL, SECRETS_KEY, auth, createTestApi, validBody, type TestApi } from "../test-support";
```

add `  t.deps.config.llm = FAKE_LLM;` as the last line of the top-level `beforeEach`, and add this block before `describe("GET /v1/test-runs/:runId and list", …)`:

```ts
describe("POST /v1/test-runs: the run's model (request → Settings → environment)", () => {
  /** LLM_PROVIDER=anthropic with ANTHROPIC_API_KEY set, no Gemini key. */
  const ANTHROPIC_ENV: ApiLlmConfig = {
    envChoice: { provider: "anthropic", model: "claude-sonnet-5", reasoning: "default" },
    envKeys: { anthropic: true, gemini: false },
    fakeAllowed: true,
  };
  const saveGeminiKey = () =>
    new ProviderKeyRepository(t.tdb.db).set(TEST_TENANT_ID, "gemini", encryptProviderKey("AIza-Test-Key", { tenantId: TEST_TENANT_ID, provider: "gemini" }, SECRETS_KEY));
  const saveDefaults = (model: string, reasoning: "default" | "low" | "medium" | "high") =>
    new LlmSettingsRepository(t.tdb.db).upsertDefaults(TEST_TENANT_ID, { model, reasoning });
  const storedLlm = async (res: { json(): { runId: string } }) => (await new RunRepository(t.tdb.db).findById(res.json().runId))!.request.llm;
  const active = () => new RunRepository(t.tdb.db).countActive(TEST_TENANT_ID);

  beforeEach(async () => {
    t.deps.config.llm = ANTHROPIC_ENV;
    await t.tdb.db.delete(schema.llmProviderKeys);
    await t.tdb.db.delete(schema.llmSettings);
  });

  it("nothing saved, nothing requested: the environment's choice is recorded", async () => {
    const res = await post(validBody());
    expect(res.statusCode).toBe(202);
    expect(await storedLlm(res)).toEqual({ provider: "anthropic", model: "claude-sonnet-5", reasoning: "default" });
  });

  it("the saved defaults win over the environment; the request's reasoning alone overrides their level", async () => {
    await saveDefaults("claude-opus-5-5", "medium");
    expect(await storedLlm(await post(validBody()))).toEqual({ provider: "anthropic", model: "claude-opus-5-5", reasoning: "medium" });
    expect(await storedLlm(await post(validBody({ llm: { reasoning: "high" } })))).toEqual({ provider: "anthropic", model: "claude-opus-5-5", reasoning: "high" });
  });

  it("the request's model wins over Settings (its provider's key saved in Settings), its level defaulting to default", async () => {
    await saveDefaults("claude-opus-5-5", "medium");
    await saveGeminiKey();
    expect(await storedLlm(await post(validBody({ llm: { model: "gemini-3.8-flash", reasoning: "low" } })))).toEqual({
      provider: "gemini",
      model: "gemini-3.8-flash",
      reasoning: "low",
    });
    expect(await storedLlm(await post(validBody({ llm: { model: "claude-haiku-4-5" } })))).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      reasoning: "default",
    });
  });

  it.each([
    ["a model whose provider has no key", { model: "gemini-3.8-flash" }, ["llm", "model"], "Add a Google Gemini API key in Settings"],
    ["an unknown model", { model: "gpt-x" }, ["llm", "model"], "not a model offered here"],
    ["a level the model does not take", { model: "claude-haiku-4-5", reasoning: "high" }, ["llm", "reasoning"], "not high"],
  ])("refuses %s: 422 MODEL_NOT_AVAILABLE on the field, no run created", async (_what, llm, path, message) => {
    const before = await active();
    const res = await post(validBody({ llm }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "MODEL_NOT_AVAILABLE", issues: [{ path, message: expect.stringContaining(message) }] });
    expect(await active()).toBe(before);
  });

  it("defaults whose provider has no key → 422 at [\"llm\"], naming the fix; also after the key behind saved defaults is removed", async () => {
    t.deps.config.llm = { ...ANTHROPIC_ENV, envKeys: { anthropic: false, gemini: false } };
    const env = await post(validBody());
    expect(env.statusCode).toBe(422);
    expect(env.json()).toMatchObject({ code: "MODEL_NOT_AVAILABLE", message: expect.stringContaining("Add an Anthropic API key in Settings"), issues: [{ path: ["llm"] }] });

    t.deps.config.llm = ANTHROPIC_ENV;
    await saveGeminiKey();
    await saveDefaults("gemini-3.8-flash", "low");
    expect((await post(validBody())).statusCode).toBe(202);
    await new ProviderKeyRepository(t.tdb.db).remove(TEST_TENANT_ID, "gemini");
    expect((await post(validBody())).json()).toMatchObject({ code: "MODEL_NOT_AVAILABLE", issues: [{ path: ["llm"], message: expect.stringContaining("Add a Google Gemini API key in Settings") }] });
  });

  it("the fake engine is refused in production", async () => {
    t.deps.config.llm = { ...ANTHROPIC_ENV, fakeAllowed: false };
    expect((await post(validBody({ llm: { model: "fake" } }))).statusCode).toBe(422);
    t.deps.config.llm = ANTHROPIC_ENV;
    expect(await storedLlm(await post(validBody({ llm: { model: "fake" } })))).toEqual({ provider: "fake", model: "fake", reasoning: "default" });
  });

  it("a retry with the same Idempotency-Key replays the original run even after Settings changed; the hash covers the override", async () => {
    await saveGeminiKey();
    const body = validBody({ llm: { model: "gemini-3.8-flash" } });
    const first = await post(body, { "idempotency-key": "llm-retry-1" });
    expect(first.statusCode).toBe(202);
    await new ProviderKeyRepository(t.tdb.db).remove(TEST_TENANT_ID, "gemini");
    const retry = await post(body, { "idempotency-key": "llm-retry-1" });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().runId).toBe(first.json().runId);
    expect((await post(validBody({ llm: { model: "claude-sonnet-5" } }), { "idempotency-key": "llm-retry-1" })).statusCode).toBe(409);
    expect((await post(body, { "idempotency-key": "llm-retry-2" })).statusCode).toBe(422);
  });

  it("the summary names the run's model with its catalog label; a run created before model choice has none", async () => {
    const res = await post(validBody({ llm: { model: "claude-opus-5-5", reasoning: "medium" } }));
    const { runId } = res.json();
    const summary = TestRunSummarySchema.parse((await t.app.inject({ method: "GET", url: `/v1/test-runs/${runId}`, headers: auth })).json());
    expect(summary.llm).toEqual({ provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5", reasoning: "medium" });
    const list = (await t.app.inject({ method: "GET", url: "/v1/test-runs?limit=100", headers: auth })).json();
    expect(list.items.find((i: { runId: string }) => i.runId === runId).llm.label).toBe("Claude Opus 5.5");

    const { llm: _none, ...older } = (await new RunRepository(t.tdb.db).findById(runId))!.request;
    const old = await new RunRepository(t.tdb.db).create({ tenantId: TEST_TENANT_ID, targetUrl: "https://shop.example.com", request: older });
    expect((await t.app.inject({ method: "GET", url: `/v1/test-runs/${old.id}`, headers: auth })).json().llm).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run each: `pnpm --filter @platform/contracts exec vitest run src/contracts.test.ts`, `pnpm --filter @platform/db exec vitest run src/run-repository.test.ts`, `pnpm --filter @platform/api exec vitest run src/routes/test-runs.test.ts`
Expected: FAIL, all three — contracts: the create schema strips `llm` (`undefined` instead of the override) and the summary schema accepts a summary without `llm`; db: `toRunSummary(...).llm` is `undefined`; API: no `request.llm` is stored and runs that should be refused are created (`202` instead of `422`).

- [ ] **Step 3: The create override and the summary field** — in `packages/contracts/src/run.ts`:

Replace the Task 1 line `import type { LlmChoice } from "./llm";` with:

```ts
import { LlmOverrideSchema, LlmProviderSchema, ReasoningLevelSchema, type LlmChoice } from "./llm";
```

In `CreateTestRunRequestSchema`'s object, replace:

```ts
    options: RunOptionsSchema.prefault({}),
  })
```

with:

```ts
    options: RunOptionsSchema.prefault({}),
    /** This run's model and/or reasoning level; omitted: the defaults (Settings, else the environment). */
    llm: LlmOverrideSchema.optional(),
  })
```

(the refinements after the object — A's host-confirmation rules and the rerun rule — stay as they are). In `TestRunSummarySchema`, add as the **last** key of the object, after `finishedAt: IsoDateTime.nullable(),` (A's `environment` / `allowDestructiveActions` sit after `targetUrl`):

```ts
  /** The run's recorded model choice; `label` from the catalog (the id when not in it). Null: created before model choice. */
  llm: z
    .object({ provider: LlmProviderSchema, model: z.string(), label: z.string(), reasoning: ReasoningLevelSchema })
    .nullable(),
```

- [ ] **Step 4: `toRunSummary` names the model** — in `packages/db/src/run-repository.ts`, replace the function's first two lines:

```ts
export function toRunSummary(run: TestRun): TestRunSummary {
  return {
```

with:

```ts
/**
 * `modelLabel` names the run's model for display: the API passes the model catalog's labels (@platform/llm,
 * which db does not depend on); by default, the model id.
 */
export function toRunSummary(run: TestRun, modelLabel: (model: string) => string = (model) => model): TestRunSummary {
  const llm = run.request.llm;
  return {
```

and add as the **last** property of the returned object, after `finishedAt: …` (A's `environment` / `allowDestructiveActions` lines sit after `targetUrl`):

```ts
    llm: llm ? { provider: llm.provider, model: llm.model, label: modelLabel(llm.model), reasoning: llm.reasoning } : null,
```

After A and this step the function reads:

```ts
export function toRunSummary(run: TestRun, modelLabel: (model: string) => string = (model) => model): TestRunSummary {
  const llm = run.request.llm;
  return {
    runId: run.id,
    lifecycle: run.lifecycle,
    verdict: run.verdict,
    errorCategory: run.errorCategory,
    cancelReason: run.lifecycle === "CANCELLED" ? run.cancelReason : null,
    targetUrl: run.targetUrl,
    environment: run.request.environment, // A
    allowDestructiveActions: destructiveActionsAllowed(run.request), // A
    requirementPreview: run.request.requirement.slice(0, 200),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    llm: llm ? { provider: llm.provider, model: llm.model, label: modelLabel(llm.model), reasoning: llm.reasoning } : null,
  };
}
```

- [ ] **Step 5: Resolve and store the choice at creation** — in `apps/api/src/services/test-run-service.ts`:

Replace:

```ts
import { createRunEventPublisher, type RunEventPublisher } from "@platform/event-bus";
import { createRunRedactor, encryptSecret, redactByKey, validateTargetUrl } from "@platform/security";
import { createHmac } from "node:crypto";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";
import { NO_VERDICT, observeStage } from "../metrics";
```

with:

```ts
import { createRunEventPublisher, type RunEventPublisher } from "@platform/event-bus";
import { catalogModel } from "@platform/llm/catalog";
import { createRunRedactor, encryptSecret, redactByKey, validateTargetUrl } from "@platform/security";
import { createHmac } from "node:crypto";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";
import { NO_VERDICT, observeStage } from "../metrics";
import { resolveRunLlm } from "./llm-choice";
import { LlmSettingsService, modelNotAvailable } from "./llm-settings-service";
```

Add before `function isUniqueViolation(err: unknown): boolean {`:

```ts
/** The run summary, with the model named as the catalog names it (the id when not in the catalog). */
const summaryOf = (run: TestRun): TestRunSummary => toRunSummary(run, (model) => catalogModel(model)?.label ?? model);

```

In `create()`, replace:

```ts
    const { secrets, ...rest } = req;
    const redact = createRunRedactor(Object.values(secrets));
    // Secret values can also appear in the requirement text or test data: redact them by key and
    // value before anything is persisted (D7). The worker only ever sees this redacted copy.
    const stored: StoredTestRunRequest = {
      ...(redact(rest) as typeof rest),
      secretNames: Object.keys(secrets).sort(),
    };
```

with:

```ts
    // The run's model: the request's override, else the defaults saved in Settings, else the environment's.
    // Checked here, so a run whose provider has no key (or whose model or level is not offered) is refused now
    // instead of failing in the worker. Changing Settings later never changes this run's choice.
    const { saved, availability } = await new LlmSettingsService(this.deps).state(tenantId);
    const resolved = resolveRunLlm({ override: req.llm, saved, env: this.deps.config.llm.envChoice, availability });
    if (!resolved.ok) throw modelNotAvailable(resolved.issue);

    // `llm` is stored as the resolved choice, not the override the request sent.
    const { secrets, llm: _override, ...rest } = req;
    const redact = createRunRedactor(Object.values(secrets));
    // Secret values can also appear in the requirement text or test data: redact them by key and
    // value before anything is persisted (D7). The worker only ever sees this redacted copy.
    const stored: StoredTestRunRequest = {
      ...(redact(rest) as typeof rest),
      secretNames: Object.keys(secrets).sort(),
      llm: resolved.choice,
    };
```

(The idempotency hash above it still covers `req` as sent, `llm` override included, and the replay check runs before this resolution, so a retry replays even after Settings changed.) Then replace the four summary conversions: `return toRunSummary(await this.runs.getRequired(this.deps.config.defaultTenantId, runId));` → `return summaryOf(await this.runs.getRequired(this.deps.config.defaultTenantId, runId));`, `page.items.map(toRunSummary)` → `page.items.map(summaryOf)`, `return toRunSummary(cancelled);` → `return summaryOf(cancelled);`, `return toRunSummary(marked);` → `return summaryOf(marked);`. (`toRunSummary` now takes a second parameter, so `map(toRunSummary)` would pass the index as the labeller: the typecheck rejects it.)

- [ ] **Step 6: The web's summary fixture** — in `apps/web/test/fixtures.ts`, inside `summaryFixture`, add `  llm: null,` on its own line right before `  ...patch,` (after `finishedAt: null,`; A's `environment` / `allowDestructiveActions` defaults sit after `targetUrl`). The web parses every summary with `TestRunSummarySchema`, which now requires `llm`.

- [ ] **Step 7: Run the tests and the typecheck**

Run: `pnpm --filter @platform/contracts test && pnpm --filter @platform/db exec vitest run src/run-repository.test.ts && pnpm --filter @platform/api test && pnpm --filter @platform/web test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/run.ts packages/contracts/src/contracts.test.ts packages/db/src/run-repository.ts packages/db/src/run-repository.test.ts apps/api/src/services/test-run-service.ts apps/api/src/routes/test-runs.test.ts apps/web/test/fixtures.ts
git commit -m "feat: each run records its model choice (request, then Settings, then the environment)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Engine — every real stage uses the run's model client (`StageContext.llm`)

**Files:**
- Modify: `packages/testing-engine/src/orchestrator/stages.ts` (`StageContext.llm`, `requireLlm`)
- Modify: `packages/testing-engine/src/requirement/compiler.ts` (`createAnalyzeStage()`), `packages/testing-engine/src/planner/planner.ts` (`createPlanStage()`), `packages/testing-engine/src/orchestrator/real-stages.ts` (no `llm` dependency), `packages/testing-engine/src/reporting/report-builder.ts` (diagnostics built per run), `packages/testing-engine/src/exploration/explore-stage.ts` (hands the run's client to the explorer)
- Modify: `packages/stagehand-adapter/src/browser-explorer.ts` (`ExplorerStartInput.llm`), `packages/stagehand-adapter/src/stagehand-explorer.ts` (options lose `llm`), `packages/stagehand-adapter/src/client-llm.ts` (reasoning `default`)
- Test: `packages/testing-engine/src/orchestrator/real-stages.test.ts`, `packages/testing-engine/src/exploration/explore-stage.test.ts`, `packages/testing-engine/src/exploration/executor.test.ts`, `packages/testing-engine/src/planner/planner.test.ts`, `packages/testing-engine/src/requirement/compiler.test.ts`, `packages/testing-engine/src/reporting/report-builder.test.ts`, `packages/stagehand-adapter/src/client-llm.test.ts`, `packages/stagehand-adapter/src/stagehand-explorer.test.ts`, `packages/stagehand-adapter/src/stagehand-explorer.guardrail.test.ts` (A's)
- Modify (callers): `tests/integration/explore-stage.test.ts`, `tests/integration/stagehand-adapter.test.ts`, `tests/integration/stagehand-smoke.live.test.ts`
- Modify (worker, interim — Task 10 replaces the `engine.ts` part): `apps/worker/src/engine.ts`, `apps/worker/src/exploration.ts`, `apps/worker/src/report.ts`, `apps/worker/src/run-context.ts`

**Interfaces:**
- Consumes: `LlmClient` with `reasoning`, `LlmCallInput.reasoning` (Task 4).
- Produces: `StageContext.llm: LlmClient | null`; `requireLlm(ctx: Pick<StageContext, "llm">): LlmClient` (throws `ContractError("This run has no model client: the real engine cannot run it")`); `createAnalyzeStage()` and `createPlanStage()` take no argument; `RealStageDeps` loses `llm` (`createRealStages({ exploration, generateTest, runTest, report })`); `ReportStageDeps.diagnostics?: (ctx: StageContext) => Diagnostics`; `ExplorerStartInput.llm: Pick<LlmClient, "model" | "generateJson">`; `StagehandExplorerOptions` loses `llm`; every Stagehand bridge call carries `reasoning: "default"`.

- [ ] **Step 1: Write the failing tests**

`packages/testing-engine/src/orchestrator/real-stages.test.ts` — add `ContractError,` as the first name of the `@platform/contracts` import, and `import type { LlmClient } from "@platform/llm";` right after that import. Delete the line `const llm = { generateStructured: async () => ({}) as never };`. Replace:

```ts
const stagesWith = () =>
  createRealStages({ llm, exploration: explorationDeps, generateTest: generateTestDeps, runTest: runTestDeps, report: reportDeps });
```

with:

```ts
const stagesWith = () =>
  createRealStages({ exploration: explorationDeps, generateTest: generateTestDeps, runTest: runTestDeps, report: reportDeps });

describe("createRealStages: the run's model client (StageContext.llm)", () => {
  /** A client that records which stage called it, then stops the stage. */
  const recording = () => {
    const calls: string[] = [];
    const client = {
      generateStructured: async (input: { stage: string }) => {
        calls.push(input.stage);
        throw new Error("stopped after the call");
      },
    } as unknown as LlmClient;
    return { calls, client };
  };
  const runCtx = (llm: LlmClient | null) =>
    ({ ...ctx, request: { ...ctx.request, requirement: "A user can add a product to the cart.", testData: {}, options: { allowDestructiveActions: false } }, llm }) as unknown as StageContext;

  it("analyze and plan call the run's client", async () => {
    const { calls, client } = recording();
    await expect(stagesWith().analyze(runCtx(client))).rejects.toThrow("stopped after the call");
    await expect(stagesWith().plan(runCtx(client), requirement)).rejects.toThrow("stopped after the call");
    expect(calls).toEqual(["ANALYZING_REQUIREMENT", "PLANNING"]);
  });

  it("a run without a client (the fake engine's choice) fails with ContractError before any model call", async () => {
    await expect(stagesWith().analyze(runCtx(null))).rejects.toBeInstanceOf(ContractError);
    await expect(stagesWith().plan(runCtx(null), requirement)).rejects.toBeInstanceOf(ContractError);
  });
});
```

`packages/testing-engine/src/exploration/explore-stage.test.ts` — replace `import { BrowserProviderError, StorageError, type NormalizedRequirement, type TestPlan } from "@platform/contracts";` with:

```ts
import { BrowserProviderError, ContractError, StorageError, type NormalizedRequirement, type TestPlan } from "@platform/contracts";
import { FakeTransport, LlmClient } from "@platform/llm";
```

In `harness` (A gave it an `allowDestructiveActions` option; leave that as it is): after `const redact = (v: unknown) => v;` add

```ts
  const llm = new LlmClient({ transport: new FakeTransport(), model: "claude-sonnet-5", logger: { warn() {} } });
```

add `    llm,` as the last property of the `ctx` object (after `now: () => new Date(),`), and add `, llm` to the object `harness` returns (`return { ctx, run, budget, cleanups, log, logged, stage, started: () => started, redact, llm };`). In the first test ("opens the sandbox, starts the explorer…"), after its `expect(h.started()).toMatchObject({ … });` line (A added `allowDestructive: false` to it) add:

```ts
    expect(h.started()!.llm).toBe(h.llm); // the run's own model client drives Stagehand
```

and add after that test:

```ts
  it("a run without a model client fails with ContractError before any sandbox opens", async () => {
    const h = harness();
    await expect(h.stage({ ...h.ctx, llm: null }, plan, requirement)).rejects.toBeInstanceOf(ContractError);
    expect(h.log).toEqual([]);
  });
```

`packages/testing-engine/src/exploration/executor.test.ts` — in `fakeCtx`'s `ctx` object, after `    now: () => new Date("2026-09-26T10:00:00.000Z"),` add:

```ts
    llm: null, // the executor makes no model call of its own (the explorer does, through the stage)
```

`packages/testing-engine/src/planner/planner.test.ts` — in `stageContext`, after `    now: () => new Date(),` add `    llm: null,`. Replace each `createPlanStage(llm)(X, Y)` with `createPlanStage()({ ...X, llm }, Y)` — three calls after A:

```ts
    const plan = await createPlanStage()({ ...stageContext(storedRequest("production", true)), llm }, deleteRequirement());
```

```ts
    const plan = await createPlanStage()({ ...stageContext(storedRequest("production", true, {}, "shop.example.com")), llm }, deleteRequirement());
```

```ts
    const plan = await createPlanStage()({ ...ctx, llm }, loginRequirement());
```

and replace `realPlanStages`:

```ts
function realPlanStages(llm: Parameters<typeof createRealStages>[0]["llm"]) {
  const fake = createFakeStages();
  const unused = { openSandbox: async () => ({}) as never, explorer: { start: async () => ({}) as never }, store: () => ({}) as never };
  // No rerun here: a proxy that cannot start makes the rerun ERRORED without running anything.
  const noRerun = { openProxy: async () => Promise.reject(new Error("no rerun")), spawn: async () => ({}) as never, workspace: { baseDir: "/nonexistent" }, evidence: () => ({}) as never };
  const report = { store: () => ({ saveDiagnostics: async () => {}, llmUsage: async () => [] }) };
  return { ...createRealStages({ llm, exploration: unused, generateTest: { store: () => ({ save: async () => {} }) }, runTest: noRerun, report }), explore: fake.explore };
}
```

with:

```ts
function realPlanStages(llm: LlmClient) {
  const fake = createFakeStages();
  const unused = { openSandbox: async () => ({}) as never, explorer: { start: async () => ({}) as never }, store: () => ({}) as never };
  // No rerun here: a proxy that cannot start makes the rerun ERRORED without running anything.
  const noRerun = { openProxy: async () => Promise.reject(new Error("no rerun")), spawn: async () => ({}) as never, workspace: { baseDir: "/nonexistent" }, evidence: () => ({}) as never };
  const report = { store: () => ({ saveDiagnostics: async () => {}, llmUsage: async () => [] }) };
  const real = createRealStages({ exploration: unused, generateTest: { store: () => ({ save: async () => {} }) }, runTest: noRerun, report });
  // The plan stage runs on the run's client, as the worker's context gives it (StageContext.llm).
  return { ...real, plan: (ctx: StageContext, requirement: NormalizedRequirement) => real.plan({ ...ctx, llm }, requirement), explore: fake.explore };
}
```

(`LlmClient`, `NormalizedRequirement` and `StageContext` are already imported there.)

`packages/testing-engine/src/requirement/compiler.test.ts` — in `stageContext`, after `    now: () => new Date(),` add `    llm: null,`; in the test "publishes stage.started, criteria.proposed …" remove `llm, ` from `createRealStages({ llm, exploration: unusedExploration, … })` and replace `await runAnalysis(stageContext(storedRequest(CART_TEXT)), p.ports, stages);` with:

```ts
    await runAnalysis({ ...stageContext(storedRequest(CART_TEXT)), llm }, p.ports, stages);
```

and replace `await createAnalyzeStage(llm)(ctx);` with:

```ts
    await createAnalyzeStage()({ ...ctx, llm });
```

`packages/testing-engine/src/reporting/report-builder.test.ts` — every `createReportStage({ … })` dependency object that passes `diagnostics` now passes a function of the run's context (13 places; `diagnostics: [...]` inside a report *input* is not one of them): `diagnostics: createDiagnostics(X)` → `diagnostics: () => createDiagnostics(X)`, `diagnostics: failing` → `diagnostics: () => failing`, `diagnostics: hanging` → `diagnostics: () => hanging`, and the shorthand `diagnostics` (in `{ store: …, diagnostics }` and `{ store: …, diagnostics, … }`) → `diagnostics: () => diagnostics`. In the entry-point guard test (`describe("@platform/testing-engine/reporting entry point (Ruling R36)", …)`) replace:

```ts
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
        if (spec!.startsWith(".")) visit(path.resolve(path.dirname(file), `${spec}.ts`));
        else external.add(spec!);
      }
```

with:

```ts
      for (const [statement, spec] of readFileSync(file, "utf8").matchAll(/(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
        if (spec!.startsWith(".")) visit(path.resolve(path.dirname(file), `${spec}.ts`));
        // A type-only import is erased at runtime: StageContext's `llm` names @platform/llm's LlmClient type.
        else if (!/^(?:import|export)\s+type\s/.test(statement)) external.add(spec!);
      }
```

`packages/stagehand-adapter/src/client-llm.test.ts` — add before `describe("ClientLLM bridge: a Stagehand operation that gives up (KI-020)", …)`:

```ts
describe("ClientLLM bridge: reasoning level", () => {
  it("always calls the model at its default level, whatever the run's (browser steps were measured at the default)", async () => {
    const transport = new FakeTransport().enqueue({ json: { action: { elementId: "0-23" } } });
    const llm = new LlmClient({ transport, model: "claude-sonnet-5", reasoning: "high", logger: silent, retry: { maxRetries: 0 } });
    const bridge = createClientLlmBridge({ llm, runId: "run_1", signal: new AbortController().signal, redact: (v) => v });
    await bridge.client.generate(actRequest());
    expect(llm.reasoning).toBe("high");
    expect(transport.requests[0]!.reasoning).toBe("default");
  });
});

```

`packages/stagehand-adapter/src/stagehand-explorer.test.ts` — in `describe("StagehandExplorer.start preconditions and failures", …)` the explorer no longer takes the client; each start does: replace `new StagehandExplorer({ llm })` with `new StagehandExplorer({})` (twice) and `new StagehandExplorer({ llm, connectTimeoutMs: 2_000 })` with `new StagehandExplorer({ connectTimeoutMs: 2_000 })`, and in the three start inputs replace `runId: "r", signal:` with `runId: "r", llm, signal:` (A's `allowDestructive: false` stays where it is).

`packages/stagehand-adapter/src/stagehand-explorer.guardrail.test.ts` (A's) — replace `new StagehandExplorer({ llm, extensionId: "a".repeat(32) })` with `new StagehandExplorer({ extensionId: "a".repeat(32) })`, and in its `explorer.start({ … })` input add `        llm,` after `        runId: "r",`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @platform/testing-engine exec vitest run src/orchestrator/real-stages.test.ts src/exploration/explore-stage.test.ts src/planner/planner.test.ts src/requirement/compiler.test.ts src/reporting/report-builder.test.ts`
Expected: FAIL — the analyze and plan stages still use the client given to `createRealStages` (now none: `TypeError: Cannot read properties of undefined (reading 'generateStructured')`, not `ContractError`); `started.llm` is `undefined` and a run without a client opens the sandbox; the report stage calls the `diagnostics` factory as if it were the diagnostics.

Run: `pnpm --filter @platform/stagehand-adapter exec vitest run src/client-llm.test.ts`
Expected: FAIL — `expected 'high' to be 'default'`.

- [ ] **Step 3: The run's client in the stage context** — in `packages/testing-engine/src/orchestrator/stages.ts` replace the `@platform/contracts` import:

```ts
import type {
  ExplorationOutcome,
  GeneratedTest,
  NormalizedRequirement,
  ProvisionalResult,
  RerunResult,
  StoredTestRunRequest,
  TestEventInput,
  TestPlan,
  TestReport,
} from "@platform/contracts";
```

with:

```ts
import {
  ContractError,
  type ExplorationOutcome,
  type GeneratedTest,
  type NormalizedRequirement,
  type ProvisionalResult,
  type RerunResult,
  type StoredTestRunRequest,
  type TestEventInput,
  type TestPlan,
  type TestReport,
} from "@platform/contracts";
import type { LlmClient } from "@platform/llm";
```

and replace the end of `StageContext`:

```ts
  budgetSignal(ms: number): AbortSignal;
  now(): Date;
}
```

with:

```ts
  budgetSignal(ms: number): AbortSignal;
  now(): Date;
  /**
   * The run's model client: its recorded provider, model and reasoning level (the worker builds one per run).
   * Null only for runs on the fake engine, which makes no model call.
   */
  llm: LlmClient | null;
}

/** The run's model client, for a real stage; a run without one (the fake engine's choice) is a contract error. */
export function requireLlm(ctx: Pick<StageContext, "llm">): LlmClient {
  if (!ctx.llm) throw new ContractError("This run has no model client: the real engine cannot run it");
  return ctx.llm;
}
```

(The import of `LlmClient` is type-only, so `@platform/testing-engine/reporting`, which loads `stages.ts`, still loads no LLM code — the updated guard test checks exactly that.)

- [ ] **Step 4: The stages take the client from the context**

`packages/testing-engine/src/requirement/compiler.ts` — replace `import type { RequirementDraft, StageContext } from "../orchestrator/stages";` with `import { requireLlm, type RequirementDraft, type StageContext } from "../orchestrator/stages";`, and replace:

```ts
/** The real `analyze` stage: compiles the run's requirement with the run's redactor and deadline. */
export function createAnalyzeStage(llm: RequirementLlm): (ctx: StageContext) => Promise<RequirementDraft> {
  return (ctx) =>
    compileRequirement(llm, {
```

with:

```ts
/** The real `analyze` stage: compiles the run's requirement with the run's model client, redactor and deadline. */
export function createAnalyzeStage(): (ctx: StageContext) => Promise<RequirementDraft> {
  return async (ctx) =>
    compileRequirement(requireLlm(ctx), {
```

(`async`: a run without a client rejects the stage's promise rather than throwing synchronously.)

`packages/testing-engine/src/planner/planner.ts` — replace `import type { StageContext } from "../orchestrator/stages";` with `import { requireLlm, type StageContext } from "../orchestrator/stages";`, and replace:

```ts
/** The real `plan` stage: plans with the run's names, action policy, redactor and deadline. */
export function createPlanStage(llm: RequirementLlm): (ctx: StageContext, requirement: NormalizedRequirement) => Promise<TestPlan> {
  return (ctx, requirement) =>
    planTest(llm, {
```

with:

```ts
/** The real `plan` stage: plans with the run's model client, names, action policy, redactor and deadline. */
export function createPlanStage(): (ctx: StageContext, requirement: NormalizedRequirement) => Promise<TestPlan> {
  return async (ctx, requirement) =>
    planTest(requireLlm(ctx), {
```

(`actionPolicyFor(ctx.request)` below stays A's.)

`packages/testing-engine/src/orchestrator/real-stages.ts` — replace `import { createAnalyzeStage, type RequirementLlm } from "../requirement/compiler";` with `import { createAnalyzeStage } from "../requirement/compiler";`; replace:

```ts
export interface RealStageDeps {
  /** Structured-output LLM port shared by the analyze and plan stages. */
  llm: RequirementLlm;
  /** Browser sandbox, explorer and persistence for the explore stage (Task 14). */
```

with:

```ts
/** The model client is not a dependency: every real stage uses the run's own (`StageContext.llm`, requireLlm). */
export interface RealStageDeps {
  /** Browser sandbox, explorer and persistence for the explore stage (Task 14). */
```

and in `createRealStages` replace `    analyze: createAnalyzeStage(deps.llm), // Task 10` with `    analyze: createAnalyzeStage(), // Task 10` and `    plan: createPlanStage(deps.llm), // Task 12` with `    plan: createPlanStage(), // Task 12`.

`packages/testing-engine/src/reporting/report-builder.ts` — in `ReportStageDeps` replace:

```ts
  /** Ruling R37: on when the real engine has an LLM; tests toggle it by passing / omitting it. */
  diagnostics?: Diagnostics;
```

with:

```ts
  /**
   * Ruling R37: on for the real engine, built per run over the run's model client (the worker:
   * `(ctx) => createDiagnostics(requireLlm(ctx))`); tests toggle it by passing / omitting it.
   */
  diagnostics?: (ctx: StageContext) => Diagnostics;
```

and replace `    const diagnose = deps.diagnostics && needsDiagnostics(input.requirement, decided) ? deps.diagnostics : null;` with:

```ts
    const diagnose = deps.diagnostics && needsDiagnostics(input.requirement, decided) ? deps.diagnostics(ctx) : null;
```

`packages/testing-engine/src/exploration/explore-stage.ts` — replace `import type { EngineStages, StageContext } from "../orchestrator/stages";` with `import { requireLlm, type EngineStages, type StageContext } from "../orchestrator/stages";`. In `createExploreStage`, replace:

```ts
  return async (ctx, plan, requirement): Promise<ExplorationOutcome> => {
    const budget = ctx.budgetSignal(ctx.budgets.explorationMs);
```

with:

```ts
  return async (ctx, plan, requirement): Promise<ExplorationOutcome> => {
    // Stagehand's model calls go through the run's client (before any browser starts: a run without one fails here).
    const llm = requireLlm(ctx);
    const budget = ctx.budgetSignal(ctx.budgets.explorationMs);
```

and in the `deps.explorer.start({ … })` input replace `        runId: ctx.runId,` with:

```ts
        runId: ctx.runId,
        llm,
```

(A's `allowDestructive: actionPolicyFor(ctx.request).allowDestructive,` stays after `deadlineAt`.)

- [ ] **Step 5: The explorer gets the client with each start**

`packages/stagehand-adapter/src/browser-explorer.ts` — add `import type { LlmClient } from "@platform/llm";` as the first import, and in `ExplorerStartInput` replace:

```ts
  page: SandboxedPage;
  runId: string;
  signal: AbortSignal;
```

with:

```ts
  page: SandboxedPage;
  runId: string;
  /**
   * The run's model client: Stagehand's calls go through it (redaction, retries, LlmCall records), always at
   * the model's default reasoning level (see client-llm.ts).
   */
  llm: Pick<LlmClient, "model" | "generateJson">;
  signal: AbortSignal;
```

`packages/stagehand-adapter/src/stagehand-explorer.ts` — replace `import { createClientLlmBridge, type ClientLlmBridge, type StructuredLlm } from "./client-llm";` with `import { createClientLlmBridge, type ClientLlmBridge } from "./client-llm";`; replace:

```ts
export interface StagehandExplorerOptions {
  llm: StructuredLlm;
```

with:

```ts
/** Per explorer; the model client comes with each run (`ExplorerStartInput.llm`). */
export interface StagehandExplorerOptions {
```

and in `start`, in `createClientLlmBridge({ … })`, replace `      llm: this.opts.llm,` with `      llm: input.llm,`.

`packages/stagehand-adapter/src/client-llm.ts` — in the bridge's `generateJson({ … })` call, after `      maxTokens: opts.maxTokens,` add:

```ts
      // Browser steps keep the model's own level whatever the run's: each has a 60 s limit and runs many
      // times, and exploration quality was measured (evals) at the default.
      reasoning: "default",
```

- [ ] **Step 6: Update the integration tests (they build stage contexts and explorers)**

`tests/integration/explore-stage.test.ts` — in the setup function, move the three lines

```ts
    const transport = new ScriptedTransport(TARGETS);
    const records: LlmCallRecord[] = [];
    const llm = new LlmClient({ transport, model: MODEL, recordCall: (c) => void records.push(c), logger: silent, retry: { maxRetries: 0 } });
```

from below the `ctx` object to just above `const ctx: StageContext = {`, add `      llm,` as the last property of `ctx` (after `now: () => new Date(),`), and replace `new StagehandExplorer({ llm, connectTimeoutMs: 90_000, extensionId: extension.id })` with `new StagehandExplorer({ connectTimeoutMs: 90_000, extensionId: extension.id })`.

`tests/integration/stagehand-adapter.test.ts` — in the three `new StagehandExplorer(…).start({ … })` calls (in `startSession` and the two tests that start their own session), remove `llm, ` from the constructor options and add `llm,` to the start input right after `runId: RUN_ID,` (A's `allowDestructive: false` stays):

```ts
    const session = await new StagehandExplorer({ connectTimeoutMs: 90_000 }).start({
      page: sandbox,
      runId: RUN_ID,
      llm,
```

```ts
      const session = await new StagehandExplorer({ connectTimeoutMs: 90_000 }).start({ page: browser, runId: RUN_ID, llm, signal: new AbortController().signal, redact, allowDestructive: false });
```

```ts
      const session = await new StagehandExplorer({ connectTimeoutMs: 90_000, operationTimeoutMs: 2_000 }).start({
        page: sandbox,
        runId: RUN_ID,
        llm,
```

`tests/integration/stagehand-smoke.live.test.ts` — move the client block Task 4 left below the `ctx` object:

```ts
    const records: LlmCallRecord[] = [];
    const env = LLM!;
    const choice = resolveEnvLlmChoice(env);
    const llm = new LlmClient({
      transport: createTransport({ provider: choice.provider, apiKey: env.LLM_PROVIDER === "gemini" ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY }),
      model: choice.model,
      reasoning: choice.reasoning,
      logger: silent,
      recordCall: (c) => void records.push(c),
    });
```

to just above `const controller = new AbortController();`, add `      llm,` as the last property of its `ctx` object (after `now: () => new Date(),`), and replace `new StagehandExplorer({ llm, extensionId: extension.id, connectTimeoutMs: 90_000 })` with `new StagehandExplorer({ extensionId: extension.id, connectTimeoutMs: 90_000 })`.

- [ ] **Step 7: The worker, interim** (until Task 10 builds a client per run, every run gets the start-up client)

`apps/worker/src/exploration.ts` — delete `import type { StructuredLlm } from "@platform/stagehand-adapter";`; in `ExplorationDepsInput` delete:

```ts
  /** The LlmClient (the explorer's ClientLLM bridge records its calls as EXPLORING). */
  llm: StructuredLlm;
```

and replace:

```ts
        // Built on first use so the extension id is resolved once, from the loaded extension.
        start: (startInput) => new StagehandExplorer({ llm: input.llm, extensionId: stagehandExtension().id, logger }).start(startInput),
```

with:

```ts
        // Built on first use so the extension id is resolved once, from the loaded extension. The run's model
        // client comes with each start (the ClientLLM bridge records its calls as EXPLORING).
        start: (startInput) => new StagehandExplorer({ extensionId: stagehandExtension().id, logger }).start(startInput),
```

`apps/worker/src/report.ts` — replace `import { createDiagnostics, type DiagnosticsLlm, type ReportStageDeps, type ReportStore, type StageContext } from "@platform/testing-engine";` with `import { createDiagnostics, requireLlm, type ReportStageDeps, type ReportStore, type StageContext } from "@platform/testing-engine";`, and replace:

```ts
/**
 * The real report stage's dependencies (Task 18). Ruling R37: the real engine always has an LLM, so
 * diagnostics are on; they only add notes (statuses are decided first) and a failure only logs a warning.
 */
export function createReportDeps(deps: { db: Database; logger: WorkerLogger; llm: DiagnosticsLlm }): ReportStageDeps {
  return {
    store: (ctx) => createReportStore(deps.db, ctx),
    diagnostics: createDiagnostics(deps.llm),
```

with:

```ts
/**
 * The real report stage's dependencies (Task 18). Ruling R37: the real engine always has an LLM, so
 * diagnostics are on, over the run's model client; they only add notes (statuses are decided first) and a
 * failure only logs a warning.
 */
export function createReportDeps(deps: { db: Database; logger: WorkerLogger }): ReportStageDeps {
  return {
    store: (ctx) => createReportStore(deps.db, ctx),
    diagnostics: (ctx) => createDiagnostics(requireLlm(ctx)),
```

`apps/worker/src/run-context.ts` — in the `ctx` object replace:

```ts
    budgetSignal: (ms) => AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(0, ms))]),
    now,
  };
```

with:

```ts
    budgetSignal: (ms) => AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(0, ms))]),
    now,
    // The real engine's stages get the worker's start-up client (engine.ts) until clients are built per run.
    llm: null,
  };
```

`apps/worker/src/engine.ts` — in the `createExplorationDeps({ … })` call delete the line `    llm,`, and replace:

```ts
  const report = createReportDeps({ db: deps.db, logger: deps.logger, llm });
  return { kind: "real", stages: createRealStages({ llm, exploration, generateTest: createGenerateTestDeps(deps.db, deps.logger), runTest, report }), llm };
}
```

with:

```ts
  const report = createReportDeps({ db: deps.db, logger: deps.logger });
  const stages = createRealStages({ exploration, generateTest: createGenerateTestDeps(deps.db, deps.logger), runTest, report });
  return { kind: "real", stages: withClient(stages, llm), llm };
}

/**
 * Interim, until the worker builds a model client per run: every stage receives the start-up client as the
 * run's (`StageContext.llm`).
 */
function withClient(stages: EngineStages, llm: LlmClient): EngineStages {
  return {
    analyze: (ctx) => stages.analyze({ ...ctx, llm }),
    plan: (ctx, requirement) => stages.plan({ ...ctx, llm }, requirement),
    explore: (ctx, plan, requirement) => stages.explore({ ...ctx, llm }, plan, requirement),
    verify: (ctx, requirement, plan, exploration) => stages.verify({ ...ctx, llm }, requirement, plan, exploration),
    generateTest: (ctx, input) => stages.generateTest({ ...ctx, llm }, input),
    runTest: (ctx, test) => stages.runTest({ ...ctx, llm }, test),
    report: (ctx, input) => stages.report({ ...ctx, llm }, input),
  };
}
```

- [ ] **Step 8: Run the tests and the typecheck**

Run: `pnpm --filter @platform/testing-engine test && pnpm --filter @platform/stagehand-adapter test && pnpm --filter @platform/worker test && pnpm typecheck`
Expected: PASS (the worker's suite is unchanged: every run still gets the start-up client).

Run: `pnpm test:integration tests/integration/explore-stage.test.ts tests/integration/stagehand-adapter.test.ts`
Expected: PASS (real Chromium; scripted model). `pnpm typecheck` does not cover `tests/integration`: these runs are its check (the live smoke is type-checked by its own run with `pnpm test:live` when a key is at hand).

- [ ] **Step 9: Commit**

```bash
git add packages/testing-engine/src/orchestrator/stages.ts packages/testing-engine/src/requirement/compiler.ts packages/testing-engine/src/planner/planner.ts packages/testing-engine/src/orchestrator/real-stages.ts packages/testing-engine/src/reporting/report-builder.ts packages/testing-engine/src/exploration/explore-stage.ts packages/testing-engine/src/orchestrator/real-stages.test.ts packages/testing-engine/src/exploration/explore-stage.test.ts packages/testing-engine/src/exploration/executor.test.ts packages/testing-engine/src/planner/planner.test.ts packages/testing-engine/src/requirement/compiler.test.ts packages/testing-engine/src/reporting/report-builder.test.ts packages/stagehand-adapter/src/browser-explorer.ts packages/stagehand-adapter/src/stagehand-explorer.ts packages/stagehand-adapter/src/client-llm.ts packages/stagehand-adapter/src/client-llm.test.ts packages/stagehand-adapter/src/stagehand-explorer.test.ts packages/stagehand-adapter/src/stagehand-explorer.guardrail.test.ts tests/integration/explore-stage.test.ts tests/integration/stagehand-adapter.test.ts tests/integration/stagehand-smoke.live.test.ts apps/worker/src/engine.ts apps/worker/src/exploration.ts apps/worker/src/report.ts apps/worker/src/run-context.ts
git commit -m "refactor: stages take the run's model client from StageContext.llm

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Worker — both engines, one model client per run

**Files:**
- Create: `apps/worker/src/run-llm.ts`, `apps/worker/src/run-llm.test.ts`
- Modify: `apps/worker/src/engine.ts` (replaced: `createEngines`), `apps/worker/src/engine.test.ts`
- Modify: `apps/worker/src/deps.ts`, `apps/worker/src/run-context.ts`, `apps/worker/src/jobs/analyze-run.ts`, `apps/worker/src/jobs/execute-run.ts`, `apps/worker/src/jobs/finish.ts`, `apps/worker/src/boot.ts`, `apps/worker/src/test-support.ts`
- Modify: `tests/e2e/platform-confirmation.spec.ts`, `tests/e2e/support/stack.ts`
- Modify: `docs/operations.md`, `README.md` ("Real engine (Milestone B)")

**Interfaces:**
- Consumes: `resolveEnvLlmChoice` (Task 2); `PROVIDER_LABELS` (Task 3); `LlmClient` `reasoning`, `createTransport({ provider, apiKey })` (Task 4); `decryptProviderKey`, `ProviderKeyRepository.getEncrypted` (Task 6); `StoredTestRunRequest.llm` (Task 1); `StageContext.llm`, `createRealStages` without `llm`, `createReportDeps({ db, logger })` (Task 9).
- Produces: `run-llm.ts`: `interface RunLlm { choice: LlmChoice; llm: LlmClient | null }`, `interface RunLlmFactory { forRun(run: TestRun): Promise<RunLlm> }`, `type RunLlmEnv`, `interface RunLlmFactoryDeps { db; secretsKey; env; logger; metrics?; transport? }`, `createRunLlmFactory(deps): RunLlmFactory`; `engine.ts`: `interface Engines { fake: EngineStages; real: EngineStages; for(choice: LlmChoice): EngineStages }`, `createEngines(config: EngineConfig, deps: EngineDeps): Engines` (`EngineDeps.storage` required, no `transport`; `EngineConfig` without LLM fields); `WorkerDeps.engines`, `WorkerDeps.runLlm` (replacing `stages`); `RunContextHandle.choice`; `BootOptions.engine: Pick<EngineDeps, "exploration" | "rerun"> & { transport?: LlmTransport }`; test-support: `onlyEngine(stages)`, `FAKE_CHOICE`, `noRunLlm`, `seedRun(h, { llm })`. The worker's start-up log line "using the real test engine" / "using the fake test engine" becomes "test engines ready" (`{ defaults }`).

- [ ] **Step 1: Write the failing tests**

`apps/worker/src/test-support.ts` — replace `import type { FactValue, RunLifecycle, StoredTestRunRequest, TestEvent } from "@platform/contracts";` with `import type { FactValue, LlmChoice, RunLifecycle, StoredTestRunRequest, TestEvent } from "@platform/contracts";`; after `import { silentLogger, type WorkerDeps } from "./deps";` add:

```ts
import type { Engines } from "./engine";
import type { RunLlmFactory } from "./run-llm";
```

before `export interface WorkerHarness {` add:

```ts
/** Engines that give every run `stages`, whatever its model choice (most tests exercise one engine). */
export function onlyEngine(stages: EngineStages): Engines {
  return { fake: stages, real: stages, for: () => stages };
}

/** The fake engine's choice, with no model client, for every run. */
export const FAKE_CHOICE: LlmChoice = { provider: "fake", model: "fake", reasoning: "default" };
export const noRunLlm: RunLlmFactory = { forRun: async () => ({ choice: FAKE_CHOICE, llm: null }) };

```

in `WorkerHarness` replace `  deps(stages: EngineStages, overrides?: Partial<WorkerDeps>): WorkerDeps;` with:

```ts
  /** Every run on `stages` with no model client, unless `overrides` sets `engines` / `runLlm`. */
  deps(stages: EngineStages, overrides?: Partial<WorkerDeps>): WorkerDeps;
```

in `createHarness`'s `deps` replace `      stages,` with:

```ts
      engines: onlyEngine(stages),
      runLlm: noRunLlm,
```

and give `seedRun` the run's choice — replace:

```ts
  opts: { lifecycle?: RunLifecycle; options?: Partial<StoredTestRunRequest["options"]>; secrets?: Record<string, string> } = {},
```

with:

```ts
  opts: {
    lifecycle?: RunLifecycle;
    options?: Partial<StoredTestRunRequest["options"]>;
    secrets?: Record<string, string>;
    /** The run's recorded model choice; unset, a run created before model choice (the environment's). */
    llm?: LlmChoice;
  } = {},
```

and `    request: request(opts.options, Object.keys(secrets)),` with:

```ts
    request: { ...request(opts.options, Object.keys(secrets)), ...(opts.llm ? { llm: opts.llm } : {}) },
```

Create `apps/worker/src/run-llm.test.ts`:

```ts
import { ModelProviderError, type LlmChoice, type LlmKeyProvider } from "@platform/contracts";
import { LlmCallRepository, ProviderKeyRepository, RunRepository, schema } from "@platform/db";
import { TEST_TENANT_ID } from "@platform/db/testing";
import { FakeTransport, type LlmClient } from "@platform/llm";
import { encryptProviderKey } from "@platform/security";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { silentLogger } from "./deps";
import { analyzeRunJob } from "./jobs/analyze-run";
import { createRunLlmFactory, type RunLlmEnv } from "./run-llm";
import { SECRETS_KEY, createFakeStages, createHarness, eventsOf, seedRun, type WorkerHarness } from "./test-support";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());
afterEach(async () => {
  vi.unstubAllGlobals();
  await h.tdb.db.delete(schema.llmProviderKeys);
});

/** LLM_PROVIDER=fake with no keys: runs without a recorded choice use the fake engine. */
const ENV: RunLlmEnv = { LLM_PROVIDER: "fake", LLM_MODEL: "claude-sonnet-5" };
const OPUS_HIGH: LlmChoice = { provider: "anthropic", model: "claude-opus-5-5", reasoning: "high" };
const GEMINI_LITE_LOW: LlmChoice = { provider: "gemini", model: "gemini-3.5-flash-lite", reasoning: "low" };

const factory = (env: RunLlmEnv = ENV, transport?: FakeTransport) =>
  createRunLlmFactory({ db: h.tdb.db, secretsKey: SECRETS_KEY, env, logger: silentLogger, ...(transport ? { transport } : {}) });
const saveKey = (provider: LlmKeyProvider, apiKey: string, secretsKey = SECRETS_KEY) =>
  new ProviderKeyRepository(h.tdb.db).set(TEST_TENANT_ID, provider, encryptProviderKey(apiKey, { tenantId: TEST_TENANT_ID, provider }, secretsKey));
const ping = (llm: LlmClient, runId: string) =>
  llm.generateJson({
    system: "",
    messages: [{ role: "user", content: "ping" }],
    jsonSchema: { type: "object" },
    stage: "PLANNING",
    runId,
    signal: new AbortController().signal,
    redact: (v) => v,
  });

/** Gemini's generateContent, answered locally; records each request's API key header and body. */
function stubGemini() {
  const sent: { key: string | null; body: { generationConfig: Record<string, unknown> } }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push({ key: new Headers(init.headers).get("x-goog-api-key"), body: JSON.parse(String(init.body)) });
    const reply = {
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }], role: "model" }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 300, totalTokenCount: 1400 },
    };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
  return sent;
}

describe("createRunLlmFactory: one model client per run", () => {
  it("builds the client from the run's recorded choice (provider, model, reasoning); its calls land in llm_calls under that model", async () => {
    const transport = new FakeTransport().enqueue({ json: { ok: true }, usage: { inputTokens: 1000, outputTokens: 100 } });
    const run = await seedRun(h, { llm: OPUS_HIGH });

    const { choice, llm } = await factory({ ...ENV, ANTHROPIC_API_KEY: "sk-ant-env" }, transport).forRun(run);
    await ping(llm!, run.id);

    expect(choice).toEqual(OPUS_HIGH);
    expect([llm!.model, llm!.reasoning]).toEqual(["claude-opus-5-5", "high"]);
    expect(transport.requests[0]).toMatchObject({ model: "claude-opus-5-5", reasoning: "high" });
    expect(await new LlmCallRepository(h.tdb.db).listByRun(run.id)).toMatchObject([{ stage: "PLANNING", model: "claude-opus-5-5", status: "SUCCESS" }]);
  });

  it("a run without a recorded choice (created before model choice) uses the environment's, as the API resolves it", async () => {
    const env: RunLlmEnv = { LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.5-flash-lite", GEMINI_THINKING_LEVEL: "low", GEMINI_API_KEY: "gm-env" };
    const { choice, llm } = await factory(env, new FakeTransport()).forRun(await seedRun(h));
    expect(choice).toEqual(GEMINI_LITE_LOW);
    expect(llm!.reasoning).toBe("low");
  });

  it("the fake engine's choice has no client", async () => {
    const fake: LlmChoice = { provider: "fake", model: "fake", reasoning: "default" };
    expect(await factory().forRun(await seedRun(h, { llm: fake }))).toEqual({ choice: fake, llm: null });
    expect(await factory().forRun(await seedRun(h))).toEqual({ choice: fake, llm: null });
  });

  it("the key saved in Settings wins over the environment's: it reaches Gemini with the run's thinking level, priced as Gemini", async () => {
    const sent = stubGemini();
    await saveKey("gemini", "gm-saved-in-settings");
    const run = await seedRun(h, { llm: GEMINI_LITE_LOW });

    const { llm } = await factory({ ...ENV, GEMINI_API_KEY: "gm-from-env" }).forRun(run);
    await ping(llm!, run.id);

    expect(sent[0]!.key).toBe("gm-saved-in-settings");
    expect(sent[0]!.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    // Thinking tokens are priced as output: 1000 × $0.30 + 400 × $2.50 per MTok.
    expect(await new LlmCallRepository(h.tdb.db).listByRun(run.id)).toMatchObject([
      { provider: "gemini", model: "gemini-3.5-flash-lite", inputTokens: 1000, outputTokens: 400, estimatedCostUsd: 0.0013, status: "SUCCESS" },
    ]);
  });

  it("without a saved key, the environment's (trimmed)", async () => {
    const sent = stubGemini();
    const run = await seedRun(h, { llm: GEMINI_LITE_LOW });
    await ping((await factory({ ...ENV, GEMINI_API_KEY: " gm-from-env\n" }).forRun(run)).llm!, run.id);
    expect(sent[0]!.key).toBe("gm-from-env");
  });

  it("no key in Settings or the environment → ModelProviderError naming the fix", async () => {
    const err = await factory().forRun(await seedRun(h, { llm: OPUS_HIGH })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect((err as Error).message).toBe("No API key for Anthropic: add one in Settings");
    const gemini = await factory().forRun(await seedRun(h, { llm: GEMINI_LITE_LOW })).catch((e: unknown) => e);
    expect((gemini as Error).message).toBe("No API key for Google Gemini: add one in Settings");
  });

  it("a saved key that can't be decrypted (SECRETS_ENCRYPTION_KEY rotated) → ModelProviderError asking for it again, even with an environment key", async () => {
    await saveKey("anthropic", "sk-ant-under-the-old-key", Buffer.alloc(32, 1));
    const err = await factory({ ...ENV, ANTHROPIC_API_KEY: "sk-ant-env" }).forRun(await seedRun(h, { llm: OPUS_HIGH })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect((err as Error).message).toBe("The saved Anthropic key can't be read (was SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings");
  });

  it("the injected test transport serves every run (the E2E scripted model), after the same key checks", async () => {
    const transport = new FakeTransport().enqueue({ json: { ok: true } });
    await saveKey("gemini", "gm-saved");
    const run = await seedRun(h, { llm: { provider: "gemini", model: "gemini-3.8-flash", reasoning: "default" } });
    const { llm } = await factory(ENV, transport).forRun(run);
    await ping(llm!, run.id);
    expect(transport.requests[0]!.model).toBe("gemini-3.8-flash");
    await expect(factory(ENV, transport).forRun(await seedRun(h, { llm: OPUS_HIGH }))).rejects.toBeInstanceOf(ModelProviderError);
  });

  it("LLM_PROVIDER=openai stops the worker at start-up: not implemented in V1", () => {
    expect(() => factory({ LLM_PROVIDER: "openai", LLM_MODEL: "gpt-x" })).toThrow(/LLM_PROVIDER=openai is not implemented in V1/);
  });
});

describe("a run whose model client can't be built", () => {
  it.each([
    ["no key anywhere", async () => {}, "No API key for Anthropic: add one in Settings"],
    [
      "a saved key that can't be decrypted",
      async () => void (await saveKey("anthropic", "sk-ant-under-the-old-key", Buffer.alloc(32, 1))),
      "The saved Anthropic key can't be read (was SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings",
    ],
  ])("%s → ERRORED / MODEL_PROVIDER with that message, before any model call", async (_what, arrange, message) => {
    await arrange();
    const transport = new FakeTransport();
    const run = await seedRun(h, { llm: OPUS_HIGH, secrets: { password: "pw-123456" } });

    await analyzeRunJob(h.deps(createFakeStages(), { runLlm: factory(ENV, transport) }), run.id);

    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect([after.lifecycle, after.errorCategory, after.errorMessage]).toEqual(["ERRORED", "MODEL_PROVIDER", message]);
    expect((await eventsOf(h, run.id)).find((e) => e.type === "run.errored")?.payload).toEqual({ category: "MODEL_PROVIDER", message });
    expect(transport.requests).toEqual([]);
  });
});
```

`apps/worker/src/engine.test.ts` — the real-engine tests move from `createEngine` to the per-run wiring:

1. Imports: add `  LlmSettingsRepository,` to the `@platform/db` import (after `LlmCallRepository,`); replace `import { FakeTransport } from "@platform/llm";` with:

```ts
import { TEST_TENANT_ID } from "@platform/db/testing";
import { FakeTransport, type LlmTransport } from "@platform/llm";
```

replace `import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";` with `import { afterAll, beforeAll, describe, expect, it } from "vitest";`, `import { createEngine } from "./engine";` with `import { createEngines, type EngineDeps } from "./engine";`, and `import { createHarness, eventsOf, fakeExploration, seedRun, type WorkerHarness } from "./test-support";` with:

```ts
import { createRunLlmFactory, type RunLlmEnv } from "./run-llm";
import { SECRETS_KEY, createHarness, eventsOf, fakeExploration, seedRun, type WorkerHarness } from "./test-support";
```

2. After the `realDeps` helper add:

```ts
/**
 * The worker as boot.ts wires it: both engines, and each run's model client from its choice (runs seeded
 * without one use `env`'s) on the scripted `transport`.
 */
function wire(env: RunLlmEnv, { transport, ...deps }: EngineDeps & { transport?: LlmTransport }) {
  const engines = createEngines({}, deps);
  const runLlm = createRunLlmFactory({ db: h.tdb.db, secretsKey: SECRETS_KEY, env, logger: deps.logger, ...(transport ? { transport } : {}) });
  return { engines, deps: () => h.deps(engines.real, { engines, runLlm }) };
}
```

3. Replace `describe("createEngine (Ruling R7)", () => {` and its first four tests ("LLM_PROVIDER=fake keeps the full fake engine", "LLM_PROVIDER=fake persists its generated test, so the run's report can show it", "LLM_PROVIDER=openai fails fast at startup", "LLM_PROVIDER=gemini runs the real engine on Gemini with the configured key, model and thinking level" — the last two now live in `run-llm.test.ts`) with:

```ts
describe("createEngines (Ruling R7: both engines, chosen per run)", () => {
  it("a run whose choice is the fake engine runs the fake stages; any other choice, the real ones", () => {
    const { engines } = wire(REAL, realDeps(new FakeTransport()).deps);
    expect(engines.fake).not.toBe(engines.real);
    expect(engines.for({ provider: "fake", model: "fake", reasoning: "default" })).toBe(engines.fake);
    expect(engines.for({ provider: "anthropic", model: "claude-sonnet-5", reasoning: "high" })).toBe(engines.real);
    expect(engines.for({ provider: "gemini", model: "gemini-3.8-flash", reasoning: "default" })).toBe(engines.real);
  });

  it("LLM_PROVIDER=fake: a run without a model choice runs the fake engine, which persists its generated test for the report", async () => {
    const engine = wire({ LLM_PROVIDER: "fake", LLM_MODEL: "claude-sonnet-5" }, realDeps(new FakeTransport(), { fake: { stepDelayMs: 0, explorationSteps: 4 } }).deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });

    await executeRunJob(engine.deps(), run.id);

    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("COMPLETED");
    const stored = await new GeneratedTestRepository(h.tdb.db).findByRun(run.id);
    expect(stored).toMatchObject({ compiledCriteria: ["AC-1", "AC-2"], notCompiled: [] });
    expect(stored!.source).toContain("@playwright/test");
    const generated = (await eventsOf(h, run.id)).find((e) => e.type === "test.generated")!;
    expect(generated.payload).toMatchObject({ compiledCriteria: stored!.compiledCriteria });
    expect(await new LlmCallRepository(h.tdb.db).listByRun(run.id)).toEqual([]);
  });

  it("each run uses its own choice: a fake-engine run and a Claude Opus run side by side, on the Opus model and level", async () => {
    const transport = new FakeTransport().enqueue({ json: planned }, noDiagnostics);
    const engine = wire(REAL, realDeps(transport, { fake: { stepDelayMs: 0, explorationSteps: 2 } }).deps);
    const fakeRun = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 }, llm: { provider: "fake", model: "fake", reasoning: "default" } });
    const opusRun = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 }, llm: { provider: "anthropic", model: "claude-opus-5-5", reasoning: "low" } });

    await executeRunJob(engine.deps(), fakeRun.id);
    await executeRunJob(engine.deps(), opusRun.id);

    expect(await new LlmCallRepository(h.tdb.db).listByRun(fakeRun.id)).toEqual([]);
    expect((await new LlmCallRepository(h.tdb.db).listByRun(opusRun.id))[0]).toMatchObject({ stage: "PLANNING", model: "claude-opus-5-5" });
    expect(transport.requests[0]).toMatchObject({ model: "claude-opus-5-5", reasoning: "low" });
  });

  it("a run without a recorded choice (created before model choice) runs on the environment's model, never the defaults saved in Settings", async () => {
    await new LlmSettingsRepository(h.tdb.db).upsertDefaults(TEST_TENANT_ID, { model: "claude-opus-5-5", reasoning: "high" });
    const transport = new FakeTransport().enqueue({ json: planned }, noDiagnostics);
    const engine = wire(REAL, realDeps(transport).deps);
    const run = await seedRun(h, { lifecycle: "PLANNING", options: { maxRunSeconds: 600 } });

    await executeRunJob(engine.deps(), run.id);

    const calls = await new LlmCallRepository(h.tdb.db).listByRun(run.id);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(["claude-sonnet-5"]));
    expect(transport.requests.every((r) => r.reasoning === "default")).toBe(true);
  });
```

4. Delete the test "the real engine needs artifact storage (fails fast at startup)" (`EngineDeps.storage` is now required by type).

5. In every remaining test of the file: `createEngine(REAL, ` → `wire(REAL, ` (12 places), `h.deps(engine.stages)` → `engine.deps()` (12 places), and delete the line `expect(engine.kind).toBe("real");` (in "a real provider compiles criteria with the LLM, …").

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @platform/worker exec vitest run src/run-llm.test.ts src/engine.test.ts`
Expected: FAIL — `Failed to load url ./run-llm` (both files import it).

- [ ] **Step 3: One model client per run** — create `apps/worker/src/run-llm.ts`:

```ts
import { resolveEnvLlmChoice, type Env } from "@platform/config";
import { ModelProviderError, type LlmChoice, type LlmKeyProvider } from "@platform/contracts";
import { LlmCallRepository, ProviderKeyRepository, type Database, type TestRun } from "@platform/db";
import { LlmClient, PROVIDER_LABELS, createTransport, type LlmTransport } from "@platform/llm";
import { decryptProviderKey } from "@platform/security";
import type { WorkerLogger } from "./deps";
import { recordLlmCall, type WorkerMetrics } from "./metrics";

/** A run's model: its recorded choice (or the environment's), and the client its stages use (StageContext.llm). */
export interface RunLlm {
  choice: LlmChoice;
  /** Null for the fake engine's choice: it makes no model call. */
  llm: LlmClient | null;
}

export interface RunLlmFactory {
  /**
   * The run's model client. Throws ModelProviderError, with a message naming the fix, when the chosen
   * provider has no key or its saved key can't be decrypted.
   */
  forRun(run: TestRun): Promise<RunLlm>;
}

/** The LLM_* environment: the choice for runs that recorded none, and the server's provider keys. */
export type RunLlmEnv = Pick<Env, "LLM_PROVIDER" | "LLM_MODEL"> & Partial<Pick<Env, "GEMINI_THINKING_LEVEL" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY">>;

export interface RunLlmFactoryDeps {
  db: Database;
  /** SECRETS_ENCRYPTION_KEY: opens the keys saved in Settings. */
  secretsKey: Buffer;
  env: RunLlmEnv;
  logger: WorkerLogger;
  metrics?: WorkerMetrics;
  /** Test seam (the E2E scripted model): every run's client uses this transport, after the same key checks. */
  transport?: LlmTransport;
}

const ENV_KEYS = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" } as const;

/**
 * One model client per run, from its recorded choice (`request.llm`); a run created before model choice uses
 * the environment's, resolved as the API resolves it (resolveEnvLlmChoice). The key is the one saved in
 * Settings, decrypted here (the only place a saved key is ever read), else the environment's. Every call is
 * recorded in `llm_calls` and the worker's metrics. Throws for LLM_PROVIDER=openai, which stops the worker
 * at start-up.
 */
export function createRunLlmFactory(deps: RunLlmFactoryDeps): RunLlmFactory {
  const environment = resolveEnvLlmChoice(deps.env);
  const keys = new ProviderKeyRepository(deps.db);
  const calls = new LlmCallRepository(deps.db);

  async function keyFor(tenantId: string, provider: LlmKeyProvider): Promise<string> {
    const label = PROVIDER_LABELS[provider];
    const saved = await keys.getEncrypted(tenantId, provider);
    if (saved) {
      try {
        return decryptProviderKey(saved, { tenantId, provider }, deps.secretsKey);
      } catch (err) {
        deps.logger.warn({ err, tenantId, provider }, "saved provider key could not be decrypted");
        throw new ModelProviderError(`The saved ${label} key can't be read (was SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings`);
      }
    }
    const fromEnvironment = deps.env[ENV_KEYS[provider]]?.trim();
    if (fromEnvironment) return fromEnvironment;
    throw new ModelProviderError(`No API key for ${label}: add one in Settings`);
  }

  return {
    async forRun(run) {
      const choice = run.request.llm ?? environment;
      if (choice.provider === "fake") return { choice, llm: null };
      const apiKey = await keyFor(run.tenantId, choice.provider);
      const llm = new LlmClient({
        transport: deps.transport ?? createTransport({ provider: choice.provider, apiKey }),
        model: choice.model,
        reasoning: choice.reasoning,
        logger: deps.logger,
        recordCall: async (call) => {
          if (deps.metrics) recordLlmCall(deps.metrics, call);
          await calls.create(call);
        },
        onRecordError: (err, call) => deps.logger.warn({ err, runId: call.runId }, "failed to record LLM call"),
      });
      return { choice, llm };
    },
  };
}
```

- [ ] **Step 4: Both engines** — replace `apps/worker/src/engine.ts` with:

```ts
import os from "node:os";
import path from "node:path";
import type { Env } from "@platform/config";
import type { LlmChoice } from "@platform/contracts";
import type { Database } from "@platform/db";
import type { ArtifactStorage } from "@platform/storage";
import {
  createFakeStages,
  createRealStages,
  type EngineStages,
  type ExploreStageDeps,
  type FakeEngineOptions,
  type RunTestStageDeps,
  type WorkspaceConfig,
} from "@platform/testing-engine";
import type { WorkerLogger } from "./deps";
import { createExplorationDeps } from "./exploration";
import { createGenerateTestDeps } from "./generated-test";
import type { WorkerMetrics } from "./metrics";
import { createReportDeps } from "./report";
import { createRunTestDeps } from "./rerun";

/** What the engines read from the environment. The model is not here: it comes with each run (run-llm.ts). */
export type EngineConfig = Partial<
  Pick<Env, "TARGET_PRIVATE_ALLOWLIST" | "ARTIFACT_RETENTION_DAYS" | "SECRET_ARTIFACT_RETENTION_DAYS" | "RUNNER_WORKSPACE_DIR" | "RUNNER_NODE_MODULES_DIR">
>;

/** Where reruns get their workspaces (Ruling R32): RUNNER_WORKSPACE_DIR / RUNNER_NODE_MODULES_DIR, with defaults. */
export function rerunWorkspaceConfig(config: Pick<EngineConfig, "RUNNER_WORKSPACE_DIR" | "RUNNER_NODE_MODULES_DIR">): WorkspaceConfig {
  return {
    baseDir: config.RUNNER_WORKSPACE_DIR ?? path.join(os.tmpdir(), "platform-runs"),
    nodeModulesDir: config.RUNNER_NODE_MODULES_DIR,
  };
}

/** Both engines, built once at start-up; each run uses the one its model choice names. */
export interface Engines {
  fake: EngineStages;
  real: EngineStages;
  /** Ruling R7: the fake engine for the `fake` choice (no model, no key), the real one for any other. */
  for(choice: LlmChoice): EngineStages;
}

export interface EngineDeps {
  db: Database;
  logger: WorkerLogger;
  fake?: FakeEngineOptions;
  /** Artifact storage for exploration screenshots and rerun evidence. */
  storage: ArtifactStorage;
  /** Test seams for the real explore stage (sandbox, explorer, recorder). */
  exploration?: Partial<ExploreStageDeps>;
  /** Test seams for the real rerun stage (proxy, runner child process, workspace, evidence store). */
  rerun?: Partial<RunTestStageDeps>;
  /** Prometheus metrics (sandbox sessions, egress blocks, artifact uploads). */
  metrics?: WorkerMetrics;
}

/**
 * Ruling R7, per run: the fake engine (demo and compose work without a key) and the real one, where every
 * stage is real (analyze, plan, explore, verify, generate test, rerun, report — with LLM diagnostics, Ruling
 * R37) and makes its model calls through the run's own client (StageContext.llm, built by run-llm.ts).
 */
export function createEngines(config: EngineConfig, deps: EngineDeps): Engines {
  // The fake test is persisted like the real one, so the report (read by the API) includes it.
  const fake = createFakeStages({ generatedTestStore: createGenerateTestDeps(deps.db).store, ...deps.fake });
  const retention = {
    artifactRetentionDays: config.ARTIFACT_RETENTION_DAYS ?? 30,
    secretArtifactRetentionDays: config.SECRET_ARTIFACT_RETENTION_DAYS ?? 7,
  };
  const privateAllowlist = config.TARGET_PRIVATE_ALLOWLIST ?? [];
  const exploration = createExplorationDeps({
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    metrics: deps.metrics,
    config: { privateAllowlist, ...retention },
    ...(deps.exploration ? { overrides: deps.exploration } : {}),
  });
  const workspace = rerunWorkspaceConfig(config);
  const runTest = createRunTestDeps({
    db: deps.db,
    storage: deps.storage,
    logger: deps.logger,
    metrics: deps.metrics,
    config: {
      privateAllowlist,
      ...retention,
      workspaceDir: workspace.baseDir,
      nodeModulesDir: workspace.nodeModulesDir,
    },
    ...(deps.rerun ? { overrides: deps.rerun } : {}),
  });
  const report = createReportDeps({ db: deps.db, logger: deps.logger });
  const real = createRealStages({ exploration, generateTest: createGenerateTestDeps(deps.db, deps.logger), runTest, report });
  return { fake, real, for: (choice) => (choice.provider === "fake" ? fake : real) };
}
```

- [ ] **Step 5: Each run's context carries its choice and client**

`apps/worker/src/deps.ts` — replace `import type { EngineStages } from "@platform/testing-engine";` with nothing (delete the line); after `import type { CancelWatcher } from "./cancel-watcher";` add `import type { Engines } from "./engine";`; after `import type { WorkerMetrics } from "./metrics";` add `import type { RunLlmFactory } from "./run-llm";`; in `WorkerDeps` replace `  stages: EngineStages;` with:

```ts
  /** Both engines; each run uses the one its model choice names (`engines.for(choice)`). */
  engines: Engines;
  /** Builds each run's model client from its recorded choice (createRunContext). */
  runLlm: RunLlmFactory;
```

`apps/worker/src/run-context.ts` — replace `import { isTerminalLifecycle } from "@platform/contracts";` with `import { isTerminalLifecycle, type LlmChoice } from "@platform/contracts";`; in `RunContextHandle` after `  ports: RunPorts;` add:

```ts
  /** The run's model choice: it picks the run's engine (`deps.engines.for(choice)`). */
  choice: LlmChoice;
```

at the top of `createRunContext`'s body (before `const now = deps.now ?? (() => new Date());`) add:

```ts
  // The run's model client, from its recorded choice. A missing or unreadable provider key fails here, before
  // anything starts: the job ends the run ERRORED / MODEL_PROVIDER with the message naming the fix (finish.ts).
  const { choice, llm } = await deps.runLlm.forRun(run);
```

replace Task 9's interim lines

```ts
    now,
    // The real engine's stages get the worker's start-up client (engine.ts) until clients are built per run.
    llm: null,
  };
```

with:

```ts
    now,
    llm,
  };
```

and in the returned handle, after `    ports,` add `    choice,`.

`apps/worker/src/jobs/analyze-run.ts` — replace `      await runAnalysis(handle.ctx, handle.ports, deps.stages);` with `      await runAnalysis(handle.ctx, handle.ports, deps.engines.for(handle.choice));`.

`apps/worker/src/jobs/execute-run.ts` — replace `      const { verdict } = await runExecution(handle.ctx, handle.ports, deps.stages);` with `      const { verdict } = await runExecution(handle.ctx, handle.ports, deps.engines.for(handle.choice));`.

`apps/worker/src/jobs/finish.ts` — replace `import { CancelledError, errorCategoryOf, errorMessageOf } from "@platform/testing-engine";` with `import { CancelledError, ModelProviderError, errorCategoryOf, errorMessageOf } from "@platform/testing-engine";`, and replace:

```ts
/**
 * The run context itself could not be built (e.g. secrets fail to decrypt, DB/Redis error).
 * End the run as ERRORED so it doesn't sit in QUEUED / PLANNING forever.
 */
export async function failBeforeContext(deps: WorkerDeps, run: TestRun, err: unknown): Promise<void> {
  const category = errorCategoryOf(err);
  const message = "Run could not be started by the worker";
```

with:

```ts
/**
 * The run context itself could not be built (e.g. the run's model has no usable key, secrets fail to
 * decrypt, DB/Redis error). End the run as ERRORED so it doesn't sit in QUEUED / PLANNING forever.
 */
export async function failBeforeContext(deps: WorkerDeps, run: TestRun, err: unknown): Promise<void> {
  const category = errorCategoryOf(err);
  // The run's model client could not be built (run-llm.ts): its message is a template naming the fix. Anything
  // else gets a fixed message; the details stay in the log.
  const message = err instanceof ModelProviderError ? err.message : "Run could not be started by the worker";
```

- [ ] **Step 6: Boot builds both engines and the per-run factory** — in `apps/worker/src/boot.ts` replace the imports and `BootOptions`:

```ts
import { createLogger, createRunLogRegistry, loadEnvOrExit } from "@platform/config";
import { createDb, ensureTenant, runMigrations } from "@platform/db";
import { createRunQueue } from "@platform/event-bus";
import { createArtifactStorage } from "@platform/storage";
import { writeFileSync } from "node:fs";
import { Redis } from "ioredis";
import { CancelWatcher } from "./cancel-watcher";
import type { WorkerLogger } from "./deps";
import { createEngine, rerunWorkspaceConfig, type EngineDeps } from "./engine";
import { stagehandExtension } from "./exploration";
import { createWorkerMetrics, startMetricsServer } from "./metrics";
import { preflightBrowserSandbox, preflightRunner } from "./sandbox/preflight";
import { startWorkers } from "./worker";

export interface BootOptions {
  /** Test seams (E2E): a scripted model transport and explorer instead of the provider and Stagehand. */
  engine?: Pick<EngineDeps, "transport" | "exploration" | "rerun">;
}
```

with:

```ts
import { createLogger, createRunLogRegistry, loadEnvOrExit, resolveEnvLlmChoice } from "@platform/config";
import { createDb, ensureTenant, runMigrations } from "@platform/db";
import { createRunQueue } from "@platform/event-bus";
import type { LlmTransport } from "@platform/llm";
import { createArtifactStorage } from "@platform/storage";
import { writeFileSync } from "node:fs";
import { Redis } from "ioredis";
import { CancelWatcher } from "./cancel-watcher";
import type { WorkerLogger } from "./deps";
import { createEngines, rerunWorkspaceConfig, type EngineDeps } from "./engine";
import { stagehandExtension } from "./exploration";
import { createWorkerMetrics, startMetricsServer } from "./metrics";
import { createRunLlmFactory } from "./run-llm";
import { preflightBrowserSandbox, preflightRunner } from "./sandbox/preflight";
import { startWorkers } from "./worker";

export interface BootOptions {
  /**
   * Test seams (E2E): a scripted model transport (every run's client uses it, after the usual key checks) and
   * explorer instead of the provider and Stagehand.
   */
  engine?: Pick<EngineDeps, "exploration" | "rerun"> & { transport?: LlmTransport };
}
```

replace everything from `  // Ruling R7: LLM_PROVIDER=fake → the deterministic fake engine; otherwise real stages as they land` through `  const stages = engine.stages;` with:

```ts
  // Each run's model comes from its recorded choice (Settings, the new-test form), or from LLM_* for runs
  // without one. Throws here for LLM_PROVIDER=openai (not built in V1): the worker stops at start-up.
  const { transport, ...seams } = opts.engine ?? {};
  const runLlm = createRunLlmFactory({ db: handle.db, secretsKey: env.secretsKey, env, logger, metrics, ...(transport ? { transport } : {}) });
  // Ruling R7, per run: both engines, built once; a run whose choice is the fake engine runs the fake stages.
  const engines = createEngines(env, {
    db: handle.db,
    logger,
    storage,
    metrics,
    fake: { stepDelayMs: Number(process.env.FAKE_ENGINE_STEP_DELAY_MS ?? 500), explorationSteps: 4 },
    ...seams,
  });
  logger.info({ defaults: resolveEnvLlmChoice(env) }, "test engines ready");
  for (let attempt = 1; ; attempt++) {
    try {
      await storage.ensureReady();
      break;
    } catch (err) {
      if (attempt >= 10) throw err;
      logger.warn({ err, attempt }, "artifact storage not ready; retrying");
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  // Launch + close the sandboxed Chromium once. A failure is logged (never fatal): analyze/plan keep
  // working and exploring runs end ERRORED / BROWSER_PROVIDER.
  await preflightBrowserSandbox({ logger, resolveExtension: stagehandExtension });
  // The rerun's runner: @playwright/test resolves and the workspace dir is writable. Logged, never
  // fatal: reruns end ERRORED and criteria fall back to their exploration evidence.
  await preflightRunner({ logger, workspace: rerunWorkspaceConfig(env) });
```

and in `startWorkers({ … })` replace `      stages,` with:

```ts
      engines,
      runLlm,
```

(The storage wait and both preflights now always run: any run may choose a real model, whatever `LLM_PROVIDER` says.)

- [ ] **Step 7: The E2E harness** — `tests/e2e/platform-confirmation.spec.ts`: replace `        stages: {} as WorkerDeps["stages"],` with:

```ts
        engines: {} as WorkerDeps["engines"],
        runLlm: {} as WorkerDeps["runLlm"],
```

`tests/e2e/support/stack.ts` — the API now resolves each new run's model from its own `LLM_*` variables, so it gets the worker's (as compose's `x-app-env` gives both). Replace:

```ts
  // CI: the scripted model stands in for the transport, so any real provider name and key will do.
  const workerLlm = mode === "live" ? liveLlmEnv() : { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-e2e-scripted-not-a-key" };
```

with:

```ts
  // CI: the scripted model stands in for the transport, so any real provider name and key will do. The API gets
  // the same LLM_* variables (as compose's x-app-env gives both): it resolves each new run's model from them.
  const llmEnv = mode === "live" ? liveLlmEnv() : { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-e2e-scripted-not-a-key" };
```

`    const api = launch("api", { LLM_PROVIDER: "fake" }, { port: apiPort, target: 3001 });` with `    const api = launch("api", llmEnv, { port: apiPort, target: 3001 });`, and `      { ...workerLlm, E2E_MODE: mode },` with `      { ...llmEnv, E2E_MODE: mode },`.

- [ ] **Step 8: Docs**

`docs/operations.md`:

In the Topology table replace the `worker` and PostgreSQL rows:

```markdown
| `worker` × N | PostgreSQL, Redis, S3, the LLM provider; runs each run's sandboxed Chromium and Playwright runner as child processes | 9464: `/metrics` (`WORKER_METRICS_PORT`, `0` disables it) |
| PostgreSQL | — | runs, events, criteria, results, artifacts metadata, encrypted secrets |
```

with:

```markdown
| `worker` × N | PostgreSQL, Redis, S3, the model providers (Anthropic, Gemini); runs each run's sandboxed Chromium and Playwright runner as child processes | 9464: `/metrics` (`WORKER_METRICS_PORT`, `0` disables it) |
| PostgreSQL | — | runs, events, criteria, results, artifacts metadata, encrypted run secrets, and the model settings: default model and the provider API keys saved in Settings (encrypted, long-lived) |
```

After the paragraph "The API and the worker port 9464 must stay on a private network. …" add:

```markdown
Give the API and every worker the same `LLM_*` variables and provider keys (compose's `x-app-env` does). The API
decides from them which model a new test uses and whether its provider has a key; the worker then builds that
run's model client from the key saved in Settings or its own environment key. If they differ, a test can be
accepted and then end `ERRORED / MODEL_PROVIDER` ("No API key for Anthropic: add one in Settings"). Keys saved in
Settings avoid the question: both read them from the database.
```

In "Worker network policy" replace:

```markdown
- **Allow** the worker to reach: its PostgreSQL, Redis and S3 endpoints; the LLM provider (`api.anthropic.com:443`,
  or `generativelanguage.googleapis.com:443` with `LLM_PROVIDER=gemini`); DNS; and public internet on TCP 80/443 for
  targets.
- With `LLM_PROVIDER=gemini`, use a `GEMINI_API_KEY` from a billing-enabled Google project: on the Gemini API's free
  tier, Google may use prompts and responses (here: redacted page content and screenshots) to improve its products.
```

with:

```markdown
- **Allow** the worker to reach: its PostgreSQL, Redis and S3 endpoints; the model providers its tests use
  (`api.anthropic.com:443` for Claude models, `generativelanguage.googleapis.com:443` for Gemini models — each test
  picks its model in Settings or the new-test form, so allow both unless one provider is never used); DNS; and
  public internet on TCP 80/443 for targets.
- For Gemini models, use an API key (Settings or `GEMINI_API_KEY`) from a billing-enabled Google project: on the
  Gemini API's free tier, Google may use prompts and responses (here: redacted page content and screenshots) to
  improve its products.
```

In "Rotating `SECRETS_ENCRYPTION_KEY`" replace:

```markdown
3. Deploy the new key to the API **and** every worker at the same time.
4. Reopen.
```

with:

```markdown
3. Deploy the new key to the API **and** every worker at the same time.
4. Enter again every provider key saved in Settings → AI providers ("Save key"). Keys that come from the
   environment (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) need nothing.
5. Reopen.
```

and after the paragraph that ends "Keep the key in a secret manager, never in compose files or images." add:

```markdown
Provider API keys saved in Settings are encrypted with the same key but are long-lived, so a drain does not clear
them. Until one is entered again, every test on that provider ends `ERRORED / MODEL_PROVIDER` with "The saved
Anthropic key can't be read (was SECRETS_ENCRYPTION_KEY rotated?): enter it again in Settings" (Gemini: "Google
Gemini"), even when the environment also holds a key for it: a saved key takes precedence, so remove it in
Settings to fall back to the environment's.
```

`README.md` ("Real engine (Milestone B)") — the API now picks each new test's model from its own `LLM_*` variables, so it needs the worker's. Replace:

```bash
# terminal 1
set -a; . ./.env; set +a
pnpm db:migrate
pnpm --filter @platform/api dev

# terminal 2
set -a; . ./.env; set +a
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @platform/worker dev
# or, on Gemini (LLM_MODEL= drops .env's Claude model for gemini-3.8-flash):
# LLM_PROVIDER=gemini GEMINI_API_KEY=... LLM_MODEL= pnpm --filter @platform/worker dev
# expect "using the real test engine", "browser sandbox preflight passed" and "rerun runner preflight passed" in its log
```

with:

```bash
# terminal 1 — the API picks each new test's model from the same LLM_* values as the worker
set -a; . ./.env; set +a
pnpm db:migrate
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @platform/api dev

# terminal 2
set -a; . ./.env; set +a
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @platform/worker dev
# or, on Gemini, in both terminals (LLM_MODEL= drops .env's Claude model for gemini-3.8-flash):
# LLM_PROVIDER=gemini GEMINI_API_KEY=... LLM_MODEL= pnpm --filter @platform/api dev    (and @platform/worker)
# expect "test engines ready", "browser sandbox preflight passed" and "rerun runner preflight passed" in the worker's log
```

- [ ] **Step 9: Run the tests, the typecheck and the E2E suite**

Run: `pnpm --filter @platform/worker test && pnpm typecheck`
Expected: PASS.

Run: `pnpm test:e2e`
Expected: PASS (the API and the worker share the scripted-model environment; every run records `anthropic / claude-sonnet-5` and the scripted transport serves it).

- [ ] **Step 10: Commit**

```bash
git add apps/worker/src/run-llm.ts apps/worker/src/run-llm.test.ts apps/worker/src/engine.ts apps/worker/src/engine.test.ts apps/worker/src/deps.ts apps/worker/src/run-context.ts apps/worker/src/jobs/analyze-run.ts apps/worker/src/jobs/execute-run.ts apps/worker/src/jobs/finish.ts apps/worker/src/boot.ts apps/worker/src/test-support.ts tests/e2e/platform-confirmation.spec.ts tests/e2e/support/stack.ts docs/operations.md README.md
git commit -m "feat: the worker builds each run's model client from its recorded choice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Web — the Settings page (AI providers, defaults for new tests)

**Files:**
- Modify: `apps/web/lib/api.ts` (three calls), `apps/web/lib/proxy.ts` (allow-list), `apps/web/app/api/[...path]/route.test.ts`
- Modify: `apps/web/components/AppNav.tsx`, `apps/web/components/AppNav.test.tsx`
- Create: `apps/web/app/settings/page.tsx`, `apps/web/components/LlmSettings.tsx`, `apps/web/components/LlmSettings.test.tsx`, `apps/web/components/ModelOptions.tsx`, `apps/web/components/llm-format.ts`, `apps/web/components/llm-format.test.ts`
- Modify: `apps/web/test/fixtures.ts` (`llmSettingsFixture`), `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `LlmSettingsViewSchema`, `LlmSettingsView`, `LlmDefaultsInput`, `LlmKeyProvider`, `LlmProvider`, `ReasoningLevel` (Task 1), `TestRunSummary["llm"]` (Task 8); `GET /v1/settings/llm`, `PUT /v1/settings/llm`, `PUT /v1/settings/llm/keys/:provider` (Task 7).
- Produces: `getLlmSettings(): Promise<LlmSettingsView>`, `saveLlmDefaults(defaults: LlmDefaultsInput): Promise<LlmSettingsView>`, `saveProviderKey(provider: LlmKeyProvider, apiKey: string | null): Promise<LlmSettingsView>` (`lib/api.ts`); `<LlmSettings />`; `<ModelOptions models />`; `components/llm-format.ts`: `type CatalogEntry`, `LEVEL_LABEL`, `modelDefaultLabel(model)`, `llmChoiceText(llm)`, `priceText(price)`, `modelGroups(models)`; `llmSettingsFixture(patch?)` (`test/fixtures.ts`).

- [ ] **Step 1: Write the failing tests**

`apps/web/test/fixtures.ts` — replace `import { TestReportSchema, type CriterionResult, type NormalizedRequirement, type TestReport, type TestRunSummary } from "@platform/contracts";` with:

```ts
import {
  LlmSettingsViewSchema,
  TestReportSchema,
  type CriterionResult,
  type LlmSettingsView,
  type NormalizedRequirement,
  type TestReport,
  type TestRunSummary,
} from "@platform/contracts";
```

and add before `export const json = …`:

```ts
/**
 * `GET /v1/settings/llm` with nothing saved: LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY on the server, no
 * Gemini key, the fake engine offered (development).
 */
export const llmSettingsFixture = (patch: Partial<LlmSettingsView> = {}): LlmSettingsView =>
  LlmSettingsViewSchema.parse({
    defaults: { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "default", source: "environment", available: true },
    providers: [
      { provider: "anthropic", label: "Anthropic", key: { source: "environment", updatedAt: null } },
      { provider: "gemini", label: "Google Gemini", key: { source: null, updatedAt: null } },
    ],
    models: [
      { provider: "anthropic", id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "medium", price: { inputUsdPerMTok: 4, outputUsdPerMTok: 20 }, available: true },
      { provider: "anthropic", id: "claude-sonnet-5", label: "Claude Sonnet 5", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "high", price: { inputUsdPerMTok: 2, outputUsdPerMTok: 10 }, available: true },
      { provider: "anthropic", id: "claude-haiku-4-5", label: "Claude Haiku 4.5", reasoningLevels: ["default"], defaultLevel: null, price: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 }, available: true },
      { provider: "gemini", id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoningLevels: ["default", "low", "medium", "high"], defaultLevel: "medium", price: { inputUsdPerMTok: 0.75, outputUsdPerMTok: 3.75 }, available: false },
      { provider: "gemini", id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", reasoningLevels: ["default", "minimal", "low", "medium", "high"], defaultLevel: "minimal", price: { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 }, available: false },
      { provider: "fake", id: "fake", label: "Fake engine (development)", reasoningLevels: ["default"], defaultLevel: null, price: null, available: true },
    ],
    ...patch,
  });

```

`apps/web/app/api/[...path]/route.test.ts` — add to the "forwards %s %s" table (after the `…/artifacts/art_1/url?reveal=true` row):

```ts
    ["GET", "/api/v1/settings/llm", GET],
    ["PUT", "/api/v1/settings/llm", PUT],
    ["PUT", "/api/v1/settings/llm/keys/anthropic", PUT],
    ["PUT", "/api/v1/settings/llm/keys/gemini", PUT],
```

and to the "rejects %s %s with 404 and never forwards it" table (after the `…/artifacts/a/b/url` row):

```ts
    ["POST", "/api/v1/settings/llm", POST],
    ["GET", "/api/v1/settings/llm/keys/anthropic", GET], // keys are write-only
    ["PUT", "/api/v1/settings/llm/keys/openai", PUT],
    ["PUT", "/api/v1/settings/llm/keys/anthropic/extra", PUT],
    ["GET", "/api/v1/settings", GET],
```

`apps/web/components/AppNav.test.tsx` — add as the first test of `describe("AppNav", …)`:

```tsx
  it("links Test runs, Settings and New test, in that order", () => {
    pathname = "/runs";
    render(<AppNav />);
    expect(screen.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Test runs", "/runs"],
      ["Settings", "/settings"],
      ["New test", "/runs/new"],
    ]);
  });

```

and the row `    ["/settings", ["Settings"]],` to the `it.each` table, before `["/somewhere-else", []]`.

Create `apps/web/components/llm-format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { llmSettingsFixture } from "../test/fixtures";
import { llmChoiceText, modelDefaultLabel, modelGroups, priceText } from "./llm-format";

describe("llm-format", () => {
  it("names a run's model and reasoning", () => {
    expect(llmChoiceText({ provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "medium" })).toBe("Claude Sonnet 5 · medium reasoning");
    expect(llmChoiceText({ provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "default" })).toBe("Claude Sonnet 5 · model default");
  });

  it("says what a model's default level is", () => {
    expect(modelDefaultLabel({ defaultLevel: "high" })).toBe("Model default (high)");
    expect(modelDefaultLabel({ defaultLevel: null })).toBe("Model default (no reasoning)");
    expect(modelDefaultLabel(undefined)).toBe("Model default");
  });

  it("prices per million tokens", () => {
    expect(priceText({ inputUsdPerMTok: 2, outputUsdPerMTok: 10 })).toBe("$2.00 input · $10.00 output per million tokens");
    expect(priceText(null)).toBe("No price on record for this model");
  });

  it("groups the models by provider, Development last and only when offered", () => {
    const { models } = llmSettingsFixture();
    expect(modelGroups(models).map((g) => [g.label, g.models.length])).toEqual([
      ["Anthropic", 3],
      ["Google Gemini", 2],
      ["Development", 1],
    ]);
    expect(modelGroups(models.filter((m) => m.provider !== "fake")).map((g) => g.label)).toEqual(["Anthropic", "Google Gemini"]);
  });
});
```

Create `apps/web/components/LlmSettings.test.tsx`:

```tsx
import type { LlmSettingsView } from "@platform/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json, llmSettingsFixture } from "../test/fixtures";
import { LlmSettings } from "./LlmSettings";

const SETTINGS = "/api/v1/settings/llm";

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;
function routeFetch(routes: Record<string, Handler>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body));
const card = (name: string) => screen.getByRole("form", { name });
const options = (select: HTMLElement) => within(select).getAllByRole("option").map((o) => o.textContent);

/** Anthropic's key saved in Settings (Gemini: none), as the API reports it. */
const anthropicSaved = (): LlmSettingsView =>
  llmSettingsFixture({
    providers: [
      { provider: "anthropic", label: "Anthropic", key: { source: "settings", updatedAt: new Date().toISOString() } },
      { provider: "gemini", label: "Google Gemini", key: { source: null, updatedAt: null } },
    ],
  });

describe("LlmSettings: AI providers", () => {
  it("shows each provider's key status (the server's, or none) and a write-only password field", async () => {
    routeFetch({ [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()) });
    render(<LlmSettings />);
    expect(await screen.findByRole("form", { name: "Anthropic" })).toHaveTextContent("Using the server's key (ANTHROPIC_API_KEY)");
    expect(card("Google Gemini")).toHaveTextContent("No key");
    expect(within(card("Anthropic")).queryByRole("button", { name: /remove saved key/i })).not.toBeInTheDocument();
    const field = within(card("Google Gemini")).getByLabelText(/api key/i);
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
  });

  it("saves a key: the field is cleared as soon as the request is sent, and the status follows the answer", async () => {
    const user = userEvent.setup();
    let answer!: (r: Response) => void;
    const saved = llmSettingsFixture({
      providers: [
        { provider: "anthropic", label: "Anthropic", key: { source: "environment", updatedAt: null } },
        { provider: "gemini", label: "Google Gemini", key: { source: "settings", updatedAt: new Date().toISOString() } },
      ],
    });
    const fetch = routeFetch({
      [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()),
      [`PUT ${SETTINGS}/keys/gemini`]: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    render(<LlmSettings />);
    const field = within(await screen.findByRole("form", { name: "Google Gemini" })).getByLabelText(/api key/i);
    await user.type(field, "AIza-Typed-Key-123");
    await user.click(within(card("Google Gemini")).getByRole("button", { name: "Save key" }));

    expect(field).toHaveValue(""); // while the request is still pending
    answer(json(200, saved));
    await waitFor(() => expect(card("Google Gemini")).toHaveTextContent(/Key saved · updated Today/));
    expect(within(card("Google Gemini")).getByRole("status")).toHaveTextContent("Key saved.");
    const put = fetch.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(bodyOf(put[1])).toEqual({ apiKey: "AIza-Typed-Key-123" });
    expect(document.body.innerHTML).not.toContain("AIza-Typed-Key-123");
  });

  it("a rejected key shows the server's message on the field, which stays cleared", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()),
      [`PUT ${SETTINGS}/keys/anthropic`]: () =>
        json(400, {
          code: "VALIDATION_FAILED",
          message: "Request validation failed",
          issues: [{ path: ["apiKey"], message: "An API key is one line of printable ASCII characters without spaces" }],
        }),
    });
    render(<LlmSettings />);
    const field = within(await screen.findByRole("form", { name: "Anthropic" })).getByLabelText(/api key/i);
    await user.type(field, "sk ant spaced");
    await user.click(within(card("Anthropic")).getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(field).toHaveAccessibleDescription(/printable ASCII characters without spaces/);
    expect(field).toHaveValue("");
  });

  it("a request that never reaches the server still clears the field, and says so on it", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()),
      [`PUT ${SETTINGS}/keys/gemini`]: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    render(<LlmSettings />);
    const field = within(await screen.findByRole("form", { name: "Google Gemini" })).getByLabelText(/api key/i);
    await user.type(field, "AIza-Lost-Key");
    await user.click(within(card("Google Gemini")).getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(field).toHaveAccessibleDescription(/could not reach the server/i));
    expect(field).toHaveValue("");
  });

  it("an empty field is not sent", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({ [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()) });
    render(<LlmSettings />);
    await user.click(within(await screen.findByRole("form", { name: "Anthropic" })).getByRole("button", { name: "Save key" }));
    expect(within(card("Anthropic")).getByLabelText(/api key/i)).toHaveAccessibleDescription("Enter the API key.");
    expect(fetch).toHaveBeenCalledTimes(1); // the GET only
  });

  it("removes a saved key after an inline confirmation", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({
      [`GET ${SETTINGS}`]: () => json(200, anthropicSaved()),
      [`PUT ${SETTINGS}/keys/anthropic`]: () => json(200, llmSettingsFixture()),
    });
    render(<LlmSettings />);
    const anthropic = await screen.findByRole("form", { name: "Anthropic" });
    expect(anthropic).toHaveTextContent(/Key saved · updated/);

    await user.click(within(anthropic).getByRole("button", { name: "Remove saved key" }));
    await user.click(within(anthropic).getByRole("button", { name: "Keep key" }));
    expect(fetch).toHaveBeenCalledTimes(1);

    await user.click(within(anthropic).getByRole("button", { name: "Remove saved key" }));
    const confirm = within(anthropic).getByRole("group", { name: "Remove the saved Anthropic key?" });
    await user.click(within(confirm).getByRole("button", { name: "Yes, remove key" }));

    await waitFor(() => expect(card("Anthropic")).toHaveTextContent("Using the server's key (ANTHROPIC_API_KEY)"));
    expect(bodyOf(fetch.mock.calls[1]![1])).toEqual({ apiKey: null });
    expect(within(card("Anthropic")).getByRole("status")).toHaveTextContent("Saved key removed.");
  });
});

describe("LlmSettings: defaults for new tests", () => {
  it("groups the models by provider; a provider without a key disables its models, labelled 'add a key'", async () => {
    routeFetch({ [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()) });
    render(<LlmSettings />);
    const model = await screen.findByLabelText("Model");
    expect(model).toHaveValue("claude-sonnet-5");
    expect(within(model).getAllByRole("group").map((g) => g.getAttribute("label"))).toEqual(["Anthropic", "Google Gemini", "Development"]);
    expect(within(model).getByRole("option", { name: "Gemini 3.8 Flash — add a key" })).toBeDisabled();
    expect(within(model).getByRole("option", { name: "Claude Opus 5.5" })).toBeEnabled();
  });

  it("the reasoning options follow the model, the first reading 'Model default (<level>)'; a level the new model lacks falls back to it", async () => {
    const user = userEvent.setup();
    routeFetch({ [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()) });
    render(<LlmSettings />);
    const reasoning = await screen.findByLabelText("Reasoning");
    expect(options(reasoning)).toEqual(["Model default (high)", "Low", "Medium", "High"]);
    await user.selectOptions(reasoning, "high");
    await user.selectOptions(screen.getByLabelText("Model"), "claude-haiku-4-5");
    expect(options(reasoning)).toEqual(["Model default (no reasoning)"]);
    expect(reasoning).toHaveValue("default");
  });

  it("shows the selected model's price per million tokens", async () => {
    const user = userEvent.setup();
    routeFetch({ [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()) });
    render(<LlmSettings />);
    const model = await screen.findByLabelText("Model");
    expect(model).toHaveAccessibleDescription("$2.00 input · $10.00 output per million tokens");
    await user.selectOptions(model, "claude-opus-5-5");
    expect(model).toHaveAccessibleDescription("$4.00 input · $20.00 output per million tokens");
  });

  it("saves the defaults; a 422 lands on the field it names", async () => {
    const user = userEvent.setup();
    let puts = 0;
    const saved = llmSettingsFixture({
      defaults: { provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5", reasoning: "medium", source: "settings", available: true },
    });
    const fetch = routeFetch({
      [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()),
      [`PUT ${SETTINGS}`]: () =>
        puts++ === 0
          ? json(422, {
              code: "MODEL_NOT_AVAILABLE",
              message: "Claude Opus 5.5 takes the reasoning levels default, low, medium, high, not medium",
              issues: [{ path: ["defaults", "reasoning"], message: "Claude Opus 5.5 takes the reasoning levels default, low, medium, high, not medium" }],
            })
          : json(200, saved),
    });
    render(<LlmSettings />);
    expect(await screen.findByText(/come from the server's environment/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Model"), "claude-opus-5-5");
    await user.selectOptions(screen.getByLabelText("Reasoning"), "medium");
    await user.click(screen.getByRole("button", { name: "Save defaults" }));

    await waitFor(() => expect(screen.getByLabelText("Reasoning")).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByLabelText("Reasoning")).toHaveAccessibleDescription(/not medium/);
    expect(bodyOf(fetch.mock.calls[1]![1])).toEqual({ defaults: { model: "claude-opus-5-5", reasoning: "medium" } });

    await user.click(screen.getByRole("button", { name: "Save defaults" }));
    expect(await screen.findByText(/Defaults saved/)).toBeInTheDocument();
    expect(screen.queryByText(/come from the server's environment/)).not.toBeInTheDocument();
  });

  it("warns that new tests will be refused when the defaults are unavailable (their key was removed)", async () => {
    routeFetch({
      [`GET ${SETTINGS}`]: () =>
        json(
          200,
          llmSettingsFixture({
            defaults: { provider: "gemini", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoning: "low", source: "settings", available: false },
          }),
        ),
    });
    render(<LlmSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/New tests will be refused.*Gemini 3\.8 Flash/);
    expect(screen.queryByText(/come from the server's environment/)).not.toBeInTheDocument();
  });

  it("an environment model outside the catalog is not preselected: the user chooses one before saving", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({
      [`GET ${SETTINGS}`]: () =>
        json(
          200,
          llmSettingsFixture({
            defaults: { provider: "anthropic", model: "claude-opus-5", label: "claude-opus-5", reasoning: "default", source: "environment", available: true },
          }),
        ),
    });
    render(<LlmSettings />);
    const model = await screen.findByLabelText("Model");
    expect(model).toHaveValue("");
    expect(model).toHaveAccessibleDescription(/claude-opus-5\) is not offered here/);
    expect(screen.getByLabelText("Reasoning")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save defaults" }));
    expect(model).toHaveAccessibleDescription(/Choose a model\./);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a failed load says so, and Try again loads it", async () => {
    const user = userEvent.setup();
    let gets = 0;
    routeFetch({ [`GET ${SETTINGS}`]: () => (gets++ === 0 ? json(500, { code: "INTERNAL", message: "Internal server error" }) : json(200, llmSettingsFixture())) });
    render(<LlmSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings couldn't be loaded");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Model")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @platform/web exec vitest run route.test AppNav llm-format LlmSettings`
Expected: FAIL — the proxy answers 404 for the settings paths; there is no Settings link; `Failed to load url ./llm-format` and `./LlmSettings`.

- [ ] **Step 3: The API calls and the proxy's allow-list**

`apps/web/lib/api.ts` — add `LlmSettingsViewSchema,` to the `@platform/contracts` import (after `CreateTestRunResponseSchema,`) and `type LlmDefaultsInput,`, `type LlmKeyProvider,`, `type LlmSettingsView,` (after `type CreateTestRunResponse,`); after `confirmCriteria` add:

```ts

const SETTINGS = "/api/v1/settings/llm";

/** Settings → AI providers and defaults: key statuses (never a key), the defaults, and the offered models. */
export const getLlmSettings = (): Promise<LlmSettingsView> => request(LlmSettingsViewSchema, SETTINGS);

/** Saves the defaults for new tests; 422 MODEL_NOT_AVAILABLE when the model or level can't be used. */
export const saveLlmDefaults = (defaults: LlmDefaultsInput): Promise<LlmSettingsView> =>
  request(LlmSettingsViewSchema, SETTINGS, { method: "PUT", body: { defaults } });

/** Saves (or, with null, removes) a provider's API key. The answer never contains it. */
export const saveProviderKey = (provider: LlmKeyProvider, apiKey: string | null): Promise<LlmSettingsView> =>
  request(LlmSettingsViewSchema, `${SETTINGS}/keys/${provider}`, { method: "PUT", body: { apiKey } });
```

`apps/web/lib/proxy.ts` — add to the allow-list, after the `…/artifacts/${ID}/url$` entry:

```ts
  { method: "GET", pattern: /^\/v1\/settings\/llm$/, query: [] },
  { method: "PUT", pattern: /^\/v1\/settings\/llm$/, query: [] },
  { method: "PUT", pattern: /^\/v1\/settings\/llm\/keys\/(?:anthropic|gemini)$/, query: [] },
```

(Keys are write-only, so no `GET` on `…/keys/…` is allowed through.)

- [ ] **Step 4: The Settings link** — in `apps/web/components/AppNav.tsx`, in `isCurrent` add after the `/runs/new` line:

```ts
  if (href === "/settings") return pathname === "/settings";
```

replace the doc comment `/** The header's navigation: the run history, and "New test" as the one call to action at its far end. */` with `/** The header's navigation: the run history, Settings, and "New test" as the one call to action at its far end. */`, and add between the "Test runs" link and the "New test" link:

```tsx
      <a className="nav-link" href="/settings" aria-current={current("/settings")}>
        Settings
      </a>
```

- [ ] **Step 5: Shared formatting and the grouped model options**

Create `apps/web/components/llm-format.ts`:

```ts
import type { LlmProvider, LlmSettingsView, ReasoningLevel, TestRunSummary } from "@platform/contracts";

export type CatalogEntry = LlmSettingsView["models"][number];

/** A reasoning level other than the model's default, as the selects show it. */
export const LEVEL_LABEL: Record<Exclude<ReasoningLevel, "default">, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** The first reasoning option: what "default" means for this model ("Model default (high)"). */
export function modelDefaultLabel(model: Pick<CatalogEntry, "defaultLevel"> | undefined): string {
  if (!model) return "Model default";
  return `Model default (${model.defaultLevel ?? "no reasoning"})`;
}

/** How a run's model reads on the run page and in the report: "Claude Sonnet 5 · medium reasoning". */
export function llmChoiceText(llm: NonNullable<TestRunSummary["llm"]>): string {
  return `${llm.label} · ${llm.reasoning === "default" ? "model default" : `${llm.reasoning} reasoning`}`;
}

/** "$2.00 input · $10.00 output per million tokens". */
export function priceText(price: CatalogEntry["price"]): string {
  if (!price) return "No price on record for this model";
  return `$${price.inputUsdPerMTok.toFixed(2)} input · $${price.outputUsdPerMTok.toFixed(2)} output per million tokens`;
}

const GROUPS: readonly (readonly [LlmProvider, string])[] = [
  ["anthropic", "Anthropic"],
  ["gemini", "Google Gemini"],
  ["fake", "Development"],
];

/** The offered models by provider, in catalog order: Anthropic, Google Gemini, then Development (the fake engine) when offered. */
export function modelGroups(models: readonly CatalogEntry[]): { provider: LlmProvider; label: string; models: CatalogEntry[] }[] {
  return GROUPS.map(([provider, label]) => ({ provider, label, models: models.filter((m) => m.provider === provider) })).filter((g) => g.models.length > 0);
}
```

Create `apps/web/components/ModelOptions.tsx`:

```tsx
import type { CatalogEntry } from "./llm-format";
import { modelGroups } from "./llm-format";

/** The offered models as <optgroup>s by provider; a model whose provider has no key is disabled ("add a key"). */
export function ModelOptions({ models }: { models: readonly CatalogEntry[] }) {
  return (
    <>
      {modelGroups(models).map((group) => (
        <optgroup key={group.provider} label={group.label}>
          {group.models.map((m) => (
            <option key={m.id} value={m.id} disabled={!m.available}>
              {m.available ? m.label : `${m.label} — add a key`}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
```

- [ ] **Step 6: The Settings page**

Create `apps/web/components/LlmSettings.tsx`:

```tsx
"use client";

import type { LlmKeyProvider, LlmSettingsView, ReasoningLevel } from "@platform/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { ApiRequestError, getLlmSettings, saveLlmDefaults, saveProviderKey } from "../lib/api";
import { Icon } from "./Icon";
import { LEVEL_LABEL, modelDefaultLabel, priceText } from "./llm-format";
import { ModelOptions } from "./ModelOptions";
import { formatWhen } from "./report-format";

type State = { status: "loading" } | { status: "ready"; view: LlmSettingsView } | { status: "error"; message: string };
type ProviderView = LlmSettingsView["providers"][number];

/** The server's environment variable for each provider's key. */
const ENV_VAR: Record<LlmKeyProvider, string> = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };

const messageOf = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? (err.issues?.[0]?.message ?? err.message) : err instanceof Error ? err.message : fallback;

/**
 * Settings → AI providers (a write-only key per provider) and the defaults for new tests
 * (spec 2026-09-28-llm-settings-design.md, section 7). Every save answers with the whole view, which
 * replaces the one shown.
 */
export function LlmSettings() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    getLlmSettings().then(
      (view) => live && setState({ status: "ready", view }),
      (err: unknown) => live && setState({ status: "error", message: messageOf(err, "Something went wrong.") }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Loading settings…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="banner banner-error">
        <Icon name="warning" />
        <div>
          <p className="banner-title">Settings couldn&apos;t be loaded</p>
          <p>{state.message}</p>
          <div className="actions">
            <button type="button" className="button button-secondary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { view } = state;
  const show = (next: LlmSettingsView) => setState({ status: "ready", view: next });
  return (
    <div className="stack-lg">
      <section className="stack" aria-labelledby="providers-title">
        <div className="section-head">
          <h2 id="providers-title" className="section-title">
            AI providers
          </h2>
          <p className="muted">Keys are stored encrypted and never shown again. A key saved here is used instead of the server&apos;s.</p>
        </div>
        <div className="settings-grid">
          {view.providers.map((p) => (
            <ProviderKeyCard key={p.provider} provider={p} onSaved={show} />
          ))}
        </div>
      </section>
      <DefaultsForm view={view} onSaved={show} />
    </div>
  );
}

function ProviderKeyCard({ provider, onSaved }: { provider: ProviderView; onSaved: (view: LlmSettingsView) => void }) {
  const id = `key-${provider.provider}`;
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function send(apiKey: string | null) {
    setPending(true);
    setError(null);
    setNotice(null);
    // The key leaves the page as soon as the request is sent, whatever the answer (as new-test secrets do).
    setValue("");
    try {
      onSaved(await saveProviderKey(provider.provider, apiKey));
      setNotice(apiKey === null ? "Saved key removed." : "Key saved.");
      setConfirming(false);
    } catch (err) {
      setError(messageOf(err, "The key couldn't be saved. Please try again."));
    } finally {
      setPending(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!value.trim()) {
      setError("Enter the API key.");
      return;
    }
    void send(value);
  };

  const { key } = provider;
  return (
    <form className="card stack-tight" aria-labelledby={`${id}-title`} onSubmit={onSubmit} noValidate>
      <h3 id={`${id}-title`} className="card-title">
        {provider.label}
      </h3>
      <p className="key-status">
        {key.source === "settings" && key.updatedAt ? (
          <>
            <Icon name="check" /> Key saved · updated {formatWhen(key.updatedAt)}
          </>
        ) : key.source === "environment" ? (
          <>
            <Icon name="info" /> Using the server&apos;s key (<code>{ENV_VAR[provider.provider]}</code>)
          </>
        ) : (
          <>
            <Icon name="warning" /> No key
          </>
        )}
      </p>
      <div className="field">
        <label htmlFor={id}>
          API key<span className="visually-hidden"> for {provider.label}</span>
        </label>
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        {error && (
          <p id={`${id}-error`} className="field-error">
            <Icon name="error" /> {error}
          </p>
        )}
      </div>
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          Save key
        </button>
        {key.source === "settings" && !confirming && (
          <button type="button" className="button button-quiet" onClick={() => setConfirming(true)} disabled={pending}>
            Remove saved key
          </button>
        )}
      </div>
      {confirming && (
        <div role="group" aria-labelledby={`${id}-remove`} className="banner banner-warning">
          <Icon name="warning" />
          <div>
            <p id={`${id}-remove`} className="banner-title">
              Remove the saved {provider.label} key?
            </p>
            <p>Tests then use the server&apos;s key, if it has one; without any key, tests on {provider.label} models are refused.</p>
            <div className="actions">
              <button type="button" className="button button-danger" onClick={() => void send(null)} disabled={pending}>
                Yes, remove key
              </button>
              <button type="button" className="button button-secondary" onClick={() => setConfirming(false)}>
                Keep key
              </button>
            </div>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="hint">
          {notice}
        </p>
      )}
    </form>
  );
}

function DefaultsForm({ view, onSaved }: { view: LlmSettingsView; onSaved: (view: LlmSettingsView) => void }) {
  // An environment model outside the catalog is not offered here: the user chooses one.
  const offered = view.models.some((m) => m.id === view.defaults.model);
  const [model, setModel] = useState(offered ? view.defaults.model : "");
  const [reasoning, setReasoning] = useState<ReasoningLevel>(offered ? view.defaults.reasoning : "default");
  const [errors, setErrors] = useState<{ model?: string; reasoning?: string }>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const selected = view.models.find((m) => m.id === model);

  const chooseModel = (id: string) => {
    setModel(id);
    // A level the new model does not take falls back to its default.
    if (!view.models.find((m) => m.id === id)?.reasoningLevels.includes(reasoning)) setReasoning("default");
    setErrors({});
    setNotice(null);
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!model) {
      setErrors({ model: "Choose a model." });
      return;
    }
    setPending(true);
    setErrors({});
    setNotice(null);
    try {
      onSaved(await saveLlmDefaults({ model, reasoning }));
      setNotice("Defaults saved. New tests use them; tests already created keep their model.");
    } catch (err) {
      const field = err instanceof ApiRequestError && err.issues?.[0]?.path.at(-1) === "reasoning" ? "reasoning" : "model";
      setErrors({ [field]: messageOf(err, "The defaults couldn't be saved. Please try again.") });
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card stack" aria-labelledby="defaults-title" onSubmit={onSubmit} noValidate>
      <div className="section-head">
        <h2 id="defaults-title" className="section-title">
          Defaults for new tests
        </h2>
        <p className="muted">The new-test form can pick another model or level for one test.</p>
      </div>
      {view.defaults.source === "environment" && (
        <p className="hint">
          <Icon name="info" /> These defaults come from the server&apos;s environment (<code>LLM_PROVIDER</code>, <code>LLM_MODEL</code>) until you
          save your own.
        </p>
      )}
      {!view.defaults.available && (
        <div role="alert" className="banner banner-warning">
          <Icon name="warning" />
          <div>
            <p className="banner-title">New tests will be refused</p>
            <p>The default model ({view.defaults.label}) has no API key. Add its provider&apos;s key above, or choose another model.</p>
          </div>
        </div>
      )}
      <div className="field-pair">
        <div className="field">
          <label htmlFor="defaults-model">Model</label>
          <select
            id="defaults-model"
            value={model}
            onChange={(e) => chooseModel(e.target.value)}
            aria-invalid={errors.model ? true : undefined}
            aria-describedby={errors.model ? "defaults-model-price defaults-model-error" : "defaults-model-price"}
          >
            {!model && (
              <option value="" disabled>
                Choose a model
              </option>
            )}
            <ModelOptions models={view.models} />
          </select>
          <p id="defaults-model-price" className="hint">
            {selected ? priceText(selected.price) : `The server's default model (${view.defaults.label}) is not offered here.`}
          </p>
          {errors.model && (
            <p id="defaults-model-error" className="field-error">
              <Icon name="error" /> {errors.model}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="defaults-reasoning">Reasoning</label>
          <select
            id="defaults-reasoning"
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value as ReasoningLevel)}
            disabled={!selected}
            aria-invalid={errors.reasoning ? true : undefined}
            aria-describedby={errors.reasoning ? "defaults-reasoning-error" : undefined}
          >
            {(selected?.reasoningLevels ?? ["default"]).map((level) => (
              <option key={level} value={level}>
                {level === "default" ? modelDefaultLabel(selected) : LEVEL_LABEL[level]}
              </option>
            ))}
          </select>
          {errors.reasoning && (
            <p id="defaults-reasoning-error" className="field-error">
              <Icon name="error" /> {errors.reasoning}
            </p>
          )}
        </div>
      </div>
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          Save defaults
        </button>
        {notice && (
          <p role="status" className="hint">
            {notice}
          </p>
        )}
      </div>
    </form>
  );
}
```

Create `apps/web/app/settings/page.tsx`:

```tsx
import type { Metadata } from "next";
import { LlmSettings } from "../../components/LlmSettings";

export const metadata: Metadata = { title: "Settings" };

/** Settings: the AI providers' API keys and the model new tests use by default. */
export default function SettingsPage() {
  return (
    <div className="stack-lg">
      <div className="title-block">
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">AI providers and models</h1>
        <p className="page-lede">
          The keys the platform uses to reach each AI provider, and the model new tests run on. Changes apply to new tests only.
        </p>
      </div>
      <LlmSettings />
    </div>
  );
}
```

Append to `apps/web/app/globals.css`:

```css

/* ---------- Settings (AI providers and defaults) ---------- */

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: 16px;
}
.settings-grid > .card {
  margin: 0;
}
.key-status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 0.875rem;
}
.key-status code {
  font-family: var(--mono);
  font-size: 0.8125rem;
}
```

- [ ] **Step 7: Run the web tests and the typecheck**

Run: `pnpm --filter @platform/web test && pnpm --filter @platform/web typecheck`
Expected: PASS.

- [ ] **Step 8: Check it in the browser**

With the UI against a local API (README "Develop locally": the API from this branch, e.g. on :3011 with `LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-local-not-a-key`, and `next dev` on :3002), open http://localhost:3002/settings at 1280 px and 375 px. Expected: "Settings" is current in the header; Anthropic reads "Using the server's key (ANTHROPIC_API_KEY)", Google Gemini "No key", and the Gemini models are disabled ("add a key"). Save a made-up Gemini key (`AIza-local-test-key`): the field empties at once, the card reads "Key saved · updated …" and the Gemini models become selectable; after a reload the key is in neither the page source nor the Network panel's responses. "Remove saved key" → "Yes, remove key" brings back "No key". Choose Claude Opus 5.5 / Medium and "Save defaults": the environment note goes away. No horizontal page scroll at 375 px.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/api.ts apps/web/lib/proxy.ts "apps/web/app/api/[...path]/route.test.ts" apps/web/components/AppNav.tsx apps/web/components/AppNav.test.tsx apps/web/app/settings/page.tsx apps/web/components/LlmSettings.tsx apps/web/components/LlmSettings.test.tsx apps/web/components/ModelOptions.tsx apps/web/components/llm-format.ts apps/web/components/llm-format.test.ts apps/web/test/fixtures.ts apps/web/app/globals.css
git commit -m "feat: Settings page for AI provider keys and the default model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Web — a test's own model and level; the run's model on the run page and in the report

**Files:**
- Modify: `apps/web/components/NewTestForm.tsx`, `apps/web/components/NewTestForm.test.tsx`
- Modify: `apps/web/components/RunView.tsx`, `apps/web/components/RunReport.tsx`, `apps/web/components/ReportSummary.tsx`, `apps/web/components/RunView.test.tsx`

**Interfaces:**
- Consumes: `CreateTestRunRequestSchema.llm` (`LlmOverride`), `TestRunSummary.llm` (Task 8); `getLlmSettings`, `ModelOptions`, `LEVEL_LABEL`, `llmChoiceText`, `llmSettingsFixture` (Task 11).
- Produces: the new-test form's Model and Reasoning selects (request body `llm` only for what was changed); `RunReport` and `ReportSummary` take `llm?: TestRunSummary["llm"]`; the run page's model chip.

- [ ] **Step 1: Write the failing tests**

`apps/web/components/NewTestForm.test.tsx` — the form now loads the model catalog on mount; stub that call so `fetch` still sees only the run requests (A's tests, which count `fetch` calls and read the first body, stay as they are). Replace `import { json, requirementFixture, summaryFixture } from "../test/fixtures";` with:

```ts
import { getLlmSettings } from "../lib/api";
import { json, llmSettingsFixture, requirementFixture, summaryFixture } from "../test/fixtures";
```

after `vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));` add:

```ts
// The model catalog loads on mount; stubbing it here keeps `fetch` (and its call order) for the run requests.
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), getLlmSettings: vi.fn() }));
```

replace `beforeEach(() => push.mockReset());` with:

```ts
beforeEach(() => {
  push.mockReset();
  vi.mocked(getLlmSettings).mockResolvedValue(llmSettingsFixture());
});
```

and append at the end of the file (after A's `describe("NewTestForm — destructive actions", …)`):

```tsx
describe("NewTestForm: model and reasoning (Advanced options)", () => {
  const created = () => json(202, { runId: "run_3", lifecycle: "QUEUED", eventsUrl: "/v1/test-runs/run_3/events" });
  const openAdvanced = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByText(/advanced options/i));

  it("offers the default model first, then the catalog by provider; a model whose provider has no key is disabled", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<NewTestForm />);
    await openAdvanced(user);
    const model = screen.getByLabelText("Model");
    await waitFor(() => expect(model).toBeEnabled());
    expect(within(model).getAllByRole("option")[0]).toHaveTextContent("Default — Claude Sonnet 5");
    expect(within(model).getAllByRole("group").map((g) => g.getAttribute("label"))).toEqual(["Anthropic", "Google Gemini", "Development"]);
    expect(within(model).getByRole("option", { name: "Gemini 3.8 Flash — add a key" })).toBeDisabled();
  });

  it.each([
    ["nothing changed: no llm at all", {}, undefined],
    ["a model", { model: "claude-opus-5-5" }, { model: "claude-opus-5-5" }],
    ["a level for the default model", { reasoning: "high" }, { reasoning: "high" }],
    ["both", { model: "claude-opus-5-5", reasoning: "low" }, { model: "claude-opus-5-5", reasoning: "low" }],
  ] as const)("the body carries llm only for what was changed: %s", async (_what, pick, expected) => {
    const user = userEvent.setup();
    const fetch = mockFetch(created());
    render(<NewTestForm />);
    await fillValid(user);
    await openAdvanced(user);
    await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled());
    if ("model" in pick) await user.selectOptions(screen.getByLabelText("Model"), pick.model);
    if ("reasoning" in pick) await user.selectOptions(screen.getByLabelText("Reasoning"), pick.reasoning);
    await user.click(screen.getByRole("button", { name: /start test/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(bodyOf(fetch).llm).toEqual(expected);
  });

  it("the reasoning options are the chosen model's; a level it lacks goes back to Default", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<NewTestForm />);
    await openAdvanced(user);
    const reasoning = screen.getByLabelText("Reasoning");
    await waitFor(() => expect(reasoning).toBeEnabled());
    expect(within(reasoning).getAllByRole("option").map((o) => o.textContent)).toEqual(["Default", "Low", "Medium", "High"]);
    await user.selectOptions(reasoning, "high");
    await user.selectOptions(screen.getByLabelText("Model"), "claude-haiku-4-5");
    expect(within(reasoning).getAllByRole("option").map((o) => o.textContent)).toEqual(["Default"]);
    expect(reasoning).toHaveValue("");
  });

  it("when the catalog can't be loaded, the selects give way to a notice and the default model is used", async () => {
    const user = userEvent.setup();
    vi.mocked(getLlmSettings).mockRejectedValue(new Error("down"));
    const fetch = mockFetch(created());
    render(<NewTestForm />);
    await openAdvanced(user);
    expect(await screen.findByText("Model choices couldn't be loaded; the default model will be used.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /start test/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(bodyOf(fetch)).not.toHaveProperty("llm");
  });

  it("a 422 MODEL_NOT_AVAILABLE on the model lands on the Model field, opening Advanced options", async () => {
    const user = userEvent.setup();
    mockFetch(
      json(422, {
        code: "MODEL_NOT_AVAILABLE",
        message: "Add a Google Gemini API key in Settings",
        issues: [{ path: ["llm", "model"], message: "Add a Google Gemini API key in Settings" }],
      }),
    );
    render(<NewTestForm />);
    await fillValid(user);
    await openAdvanced(user);
    await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled());
    await user.selectOptions(screen.getByLabelText("Model"), "claude-opus-5-5");
    await user.click(screen.getByText(/advanced options/i)); // collapse it again
    await user.click(screen.getByRole("button", { name: /start test/i }));

    const model = screen.getByLabelText("Model");
    await waitFor(() => expect(model).toHaveAttribute("aria-invalid", "true"));
    expect(model).toHaveAccessibleDescription(/Add a Google Gemini API key in Settings/);
    expect(model.closest("details")).toHaveAttribute("open");
    expect(push).not.toHaveBeenCalled();
  });

  it("a 422 MODEL_NOT_AVAILABLE at the defaults is a banner that links to Settings", async () => {
    const user = userEvent.setup();
    mockFetch(
      json(422, {
        code: "MODEL_NOT_AVAILABLE",
        message: "Add an Anthropic API key in Settings: the default model (Claude Sonnet 5) needs it",
        issues: [{ path: ["llm"], message: "Add an Anthropic API key in Settings: the default model (Claude Sonnet 5) needs it" }],
      }),
    );
    render(<NewTestForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /start test/i }));
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/The default model can't be used.*Add an Anthropic API key in Settings/);
    expect(within(banner).getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/settings");
  });

  it("the Advanced options summary names an overridden model and level", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<NewTestForm />);
    const summary = screen.getByText(/advanced options/i).closest("summary")!;
    await user.click(summary);
    await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled());
    expect(summary).toHaveTextContent("40 steps · 5 min · rerun on");
    await user.selectOptions(screen.getByLabelText("Model"), "claude-opus-5-5");
    expect(summary).toHaveTextContent("Claude Opus 5.5 · 40 steps · 5 min · rerun on");
    await user.selectOptions(screen.getByLabelText("Reasoning"), "high");
    expect(summary).toHaveTextContent("Claude Opus 5.5 · high reasoning · 40 steps · 5 min · rerun on");
  });
});
```

`apps/web/components/RunView.test.tsx` — add after the test that ends with `expect(screen.queryByRole("link", { name: /run again/i })).not.toBeInTheDocument();`:

```tsx
  it("shows the run's model and reasoning as a meta chip, and repeats it on the report's cost card; nothing for runs without a recorded choice", async () => {
    const llm = { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "medium" } as const;
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "COMPLETED", verdict: "FAILED", llm })),
      [`GET ${RUN}/report`]: () => json(200, reportFixture()),
    });
    const { unmount } = render(<RunView runId="run_1" />);
    await screen.findByRole("heading", { name: /verdict: failed/i });
    expect(screen.getByText("Claude Sonnet 5 · medium reasoning", { selector: ".run-meta .meta-chip" })).toHaveTextContent(/Model:/);
    expect(screen.getByRole("group", { name: /estimated model cost/i })).toHaveTextContent("Claude Sonnet 5 · medium reasoning");
    unmount();

    routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING", llm: { ...llm, reasoning: "default" } })) });
    const second = render(<RunView runId="run_1" />);
    expect(await screen.findByText("Claude Sonnet 5 · model default")).toBeInTheDocument();
    second.unmount();

    routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING", llm: null })) });
    render(<RunView runId="run_1" />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/model default|reasoning/)).not.toBeInTheDocument();
  });

```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @platform/web exec vitest run NewTestForm RunView`
Expected: FAIL — no "Model" / "Reasoning" fields (`Unable to find a label with the text of: Model`), no `llm` in the body, no model chip or cost-card line. A's destructive-actions tests and the older form tests still pass.

- [ ] **Step 3: The form's model choice** — in `apps/web/components/NewTestForm.tsx`:

Replace:

```ts
  type CreateTestRunRequestInput,
} from "@platform/contracts";
```

with:

```ts
  type CreateTestRunRequestInput,
  type LlmOverride,
  type LlmSettingsView,
  type ReasoningLevel,
} from "@platform/contracts";
```

replace `import { ApiRequestError, createRun, getCriteria, getRun } from "../lib/api";` with `import { ApiRequestError, createRun, getCriteria, getLlmSettings, getRun } from "../lib/api";`, and after `import { Icon, type IconName } from "./Icon";` add:

```ts
import { LEVEL_LABEL } from "./llm-format";
import { ModelOptions } from "./ModelOptions";
```

Replace:

```ts
interface Banner {
  title: string;
  message: string;
}
```

with:

```ts
interface Banner {
  title: string;
  message: string;
  link?: { href: string; label: string };
}
/** The model catalog and defaults (GET /v1/settings/llm), for the Model and Reasoning selects. */
type Catalog = { status: "loading" } | { status: "ready"; view: LlmSettingsView } | { status: "failed" };
```

In `fid`, replace:

```ts
  option: (name: string) => `options-${name}`,
};
```

with:

```ts
  option: (name: string) => `options-${name}`,
  llm: (name: "model" | "reasoning") => `llm-${name}`,
};
```

Add before `function build(`:

```ts
/** The body's `llm`: only what the user changed from the defaults ("" = the default). */
function llmOverride(model: string, reasoning: ReasoningLevel | ""): LlmOverride | undefined {
  if (!model && !reasoning) return undefined;
  return { ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) };
}

/** "Claude Opus 5.5 · high reasoning": the overridden model and level, for the Advanced options summary. */
function llmSummary(catalog: Catalog, model: string, reasoning: ReasoningLevel | ""): string | null {
  const label = model && catalog.status === "ready" ? (catalog.view.models.find((m) => m.id === model)?.label ?? model) : null;
  return [label, reasoning ? `${reasoning} reasoning` : null].filter(Boolean).join(" · ") || null;
}

```

In `NewTestForm`, after `  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);` add:

```ts
  /** This run's model and level ("" = the default: Settings, else the server's environment). */
  const [llmModel, setLlmModel] = useState("");
  const [llmReasoning, setLlmReasoning] = useState<ReasoningLevel | "">("");
  const [catalog, setCatalog] = useState<Catalog>({ status: "loading" });
  useEffect(() => {
    let live = true;
    getLlmSettings().then(
      (view) => live && setCatalog({ status: "ready", view }),
      () => live && setCatalog({ status: "failed" }),
    );
    return () => {
      live = false;
    };
  }, []);
```

add right before `  async function onSubmit(e: FormEvent) {` (after A's destructive-actions helpers):

```ts
  /** The model the Reasoning select describes: the one chosen, else the default one (when it is in the catalog). */
  const effectiveModel = catalog.status === "ready" ? catalog.view.models.find((m) => m.id === (llmModel || catalog.view.defaults.model)) : undefined;
  const levels = (effectiveModel?.reasoningLevels ?? []).filter((l): l is Exclude<ReasoningLevel, "default"> => l !== "default");
  const chooseModel = (id: string) => {
    setLlmModel(id);
    const next = catalog.status === "ready" ? catalog.view.models.find((m) => m.id === (id || catalog.view.defaults.model)) : undefined;
    // A level the newly chosen model does not take goes back to Default.
    if (llmReasoning && !next?.reasoningLevels.includes(llmReasoning)) setLlmReasoning("");
  };

```

In `onSubmit`, after `    const { errors: errs, body } = build(targetUrl, requirement, environment, data, secrets, options);` add:

```ts
    const llm = llmOverride(llmModel, llmReasoning);
    if (llm) body.llm = llm;
```

(before `keyFor(body)`, so a changed model also gets a new Idempotency-Key). In the error handling, add before `      } else if (err.code === "TOO_MANY_ACTIVE_RUNS") {`:

```ts
      } else if (err.code === "MODEL_NOT_AVAILABLE") {
        const field = err.issues?.[0]?.path[1];
        if (field === "model" || field === "reasoning") {
          const next = { [fid.llm(field)]: err.message };
          setErrors(next);
          focusFirstError(next);
        } else {
          // The defaults are at fault (e.g. their provider's key was removed): only Settings can fix that.
          setBanner({ title: "The default model can't be used", message: err.message, link: { href: "/settings", label: "Open Settings" } });
        }
```

In the error banner, replace `              <p>{banner.message}</p>` with:

```tsx
              <p>{banner.message}</p>
              {banner.link && (
                <p>
                  <a href={banner.link.href}>{banner.link.label}</a>
                </p>
              )}
```

In the "Advanced options" `FormSection`, replace (the `summary` line as A left it):

```tsx
          description="Step and time limits, the Playwright test, confirmation and extra hosts."
          summary={optionsSummary(options)}
        >
```

with:

```tsx
          description="Model and reasoning, step and time limits, the Playwright test, confirmation and extra hosts."
          summary={[llmSummary(catalog, llmModel, llmReasoning), optionsSummary(options)].filter(Boolean).join(" · ")}
        >
          {catalog.status === "failed" ? (
            <p className="hint">
              <Icon name="info" /> Model choices couldn&apos;t be loaded; the default model will be used.
            </p>
          ) : (
            <div className="field-pair">
              <div className="field">
                <label htmlFor={fid.llm("model")}>Model</label>
                <select
                  id={fid.llm("model")}
                  value={llmModel}
                  onChange={(e) => chooseModel(e.target.value)}
                  disabled={catalog.status !== "ready"}
                  aria-invalid={errors[fid.llm("model")] ? true : undefined}
                  aria-describedby={describedBy(fid.llm("model"))}
                >
                  <option value="">{catalog.status === "ready" ? `Default — ${catalog.view.defaults.label}` : "Default"}</option>
                  {catalog.status === "ready" && <ModelOptions models={catalog.view.models} />}
                </select>
                {fieldError(fid.llm("model"))}
              </div>
              <div className="field">
                <label htmlFor={fid.llm("reasoning")}>Reasoning</label>
                <select
                  id={fid.llm("reasoning")}
                  value={llmReasoning}
                  onChange={(e) => setLlmReasoning(e.target.value as ReasoningLevel | "")}
                  disabled={catalog.status !== "ready"}
                  aria-invalid={errors[fid.llm("reasoning")] ? true : undefined}
                  aria-describedby={describedBy(fid.llm("reasoning"))}
                >
                  <option value="">Default</option>
                  {levels.map((level) => (
                    <option key={level} value={level}>
                      {LEVEL_LABEL[level]}
                    </option>
                  ))}
                </select>
                {fieldError(fid.llm("reasoning"))}
              </div>
            </div>
          )}

```

(The Reasoning select offers the default model's levels until a model is chosen, since the API accepts `llm.reasoning` alone for the defaults' model; a default model outside the catalog offers only "Default".)

- [ ] **Step 4: The run's model on the run page and in the report**

`apps/web/components/RunView.tsx` — add `import { llmChoiceText } from "./llm-format";` after the `./format` import; inside `<div className="run-meta">`, right before `<span className="meta-text">` (after the website chip and A's destructive chip) add:

```tsx
              {summary.llm && (
                <span className="meta-chip" title={summary.llm.model}>
                  <Icon name="sliders" />
                  <span className="visually-hidden">Model: </span>
                  {llmChoiceText(summary.llm)}
                </span>
              )}
```

and in `<RunReport … />` add `            llm={summary.llm}` after `            runId={runId}`.

`apps/web/components/RunReport.tsx` — replace `import type { CancelReason, TestReport } from "@platform/contracts";` with `import type { CancelReason, TestReport, TestRunSummary } from "@platform/contracts";`; in `Props` after `  cancelReason?: CancelReason | null;` add:

```ts
  /** The run's model and reasoning, from its summary (null: a run created before model choice). */
  llm?: TestRunSummary["llm"];
```

replace `export function RunReport({ runId, artifacts, steps, cancelReason = null, fallback }: Props) {` with `export function RunReport({ runId, artifacts, steps, cancelReason = null, llm = null, fallback }: Props) {`, and `      <ReportSummary report={report} cancelReason={cancelReason} />` with `      <ReportSummary report={report} cancelReason={cancelReason} llm={llm} />`.

`apps/web/components/ReportSummary.tsx` — replace `import type { CancelReason, RunVerdict, TestReport } from "@platform/contracts";` with `import type { CancelReason, RunVerdict, TestReport, TestRunSummary } from "@platform/contracts";`; add `import { llmChoiceText } from "./llm-format";` after the `./format` import; in `Props` after `  cancelReason: CancelReason | null;` add:

```ts
  /** Not part of the report either: the run's model and reasoning, from its summary. */
  llm?: TestRunSummary["llm"];
```

replace `export function ReportSummary({ report, cancelReason }: Props) {` with `export function ReportSummary({ report, cancelReason, llm = null }: Props) {`, and in the "Estimated model cost" `Stat`, before its `<p className="stat-sub">` add:

```tsx
          {llm && <p className="stat-sub">{llmChoiceText(llm)}</p>}
```

- [ ] **Step 5: Run the web tests and the typecheck**

Run: `pnpm --filter @platform/web test && pnpm --filter @platform/web typecheck`
Expected: PASS (every earlier form test, A's included, runs with the stubbed catalog).

- [ ] **Step 6: Check it in the browser**

Same local stack as Task 11 (a worker from this branch too). On http://localhost:3002/runs/new open "Advanced options": "Model" starts with "Default — Claude Sonnet 5" (or the saved default), then the Anthropic / Google Gemini / Development groups; pick Claude Opus 5.5 and "High": the collapsed summary reads "Claude Opus 5.5 · high reasoning · …". Pick a Gemini model with no Gemini key: impossible (disabled, "add a key"). Start a test on "Fake engine (development)": the run page shows the chip "Fake engine (development) · model default". At 375 px the chip wraps without horizontal scroll.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/NewTestForm.tsx apps/web/components/NewTestForm.test.tsx apps/web/components/RunView.tsx apps/web/components/RunReport.tsx apps/web/components/ReportSummary.tsx apps/web/components/RunView.test.tsx
git commit -m "feat: pick a test's model and reasoning level; the run page shows the run's model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: E2E — a run on a model chosen for it; README; full verification

**Files:**
- Create: `tests/e2e/platform-settings.spec.ts`
- Modify: `tests/e2e/support/client.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above; the E2E stack's shared `LLM_*` environment (Task 10).
- Produces: `api(stack).call(…)` also returns `text` (the raw body); `api(stack).llmSettings()`, `api(stack).putProviderKey(provider, apiKey)`; `db(stack).llmCalls(runId)`, `db(stack).settingsRows()`.

- [ ] **Step 1: Write the spec** — create `tests/e2e/platform-settings.spec.ts`:

```ts
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db, logs, secretForms } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
/** The Gemini key this spec saves: printable ASCII, unique per suite run, never a real key. */
const GEMINI_KEY = `AIza-e2e-${randomBytes(12).toString("hex")}`;

afterAll(async () => {
  await client.putProviderKey("gemini", null); // no saved key outlives this spec
  await store.close();
});

// CI mode only: the scripted model answers for any provider, while live mode's environment may hold a real
// Gemini key (then nothing would be refused).
describe.runIf(stack.mode === "ci")("AI provider settings: a run on a model chosen for it (spec 2026-09-28-llm-settings-design.md)", () => {
  it("a Gemini model is refused until a key exists; with the key saved in Settings the run records its choice, its calls carry that model, and the key is nowhere", async () => {
    const body = {
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.cart,
      options: { autoConfirmCriteria: true },
      llm: { model: "gemini-3.8-flash", reasoning: "low" },
    };

    const refused = await client.call("POST", "/v1/test-runs", body);
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({
      code: "MODEL_NOT_AVAILABLE",
      issues: [{ path: ["llm", "model"], message: "Add a Google Gemini API key in Settings" }],
    });

    const saved = await client.putProviderKey("gemini", GEMINI_KEY);
    expect(saved.status).toBe(200);
    expect(saved.json.providers).toContainEqual({ provider: "gemini", label: "Google Gemini", key: { source: "settings", updatedAt: expect.any(String) } });

    const runId = await client.create(body);
    expect(await client.finished(runId)).toMatchObject({
      lifecycle: "COMPLETED",
      llm: { provider: "gemini", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoning: "low" },
    });
    const calls = await store.llmCalls(runId);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(["gemini-3.8-flash"]));

    // Keys are write-only: no settings answer contains it (raw bodies).
    const view = await client.llmSettings();
    for (const text of [saved.text, view.text]) expect(text).not.toContain(GEMINI_KEY);

    // ...and no form of it is in the database, the events or the logs. Each source really holds this run / key.
    const settingsRows = await store.settingsRows();
    expect(settingsRows).toContain('"provider":"gemini"');
    const sources = { "DB rows": `${await store.rowsOf(runId)}\n${settingsRows}`, events: JSON.stringify(await store.events(runId)), logs: logs(stack) };
    for (const text of Object.values(sources)) expect(text).toContain(runId);
    const forms = secretForms(GEMINI_KEY);
    for (const [where, text] of Object.entries(sources)) {
      for (const form of forms) expect(text, `${where} contain ${JSON.stringify(form)}`).not.toContain(form);
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm test:e2e tests/e2e/platform-settings.spec.ts`
Expected: FAIL — `client.putProviderKey is not a function` (the 422 assertion before it passes: Tasks 7–10 are in place).

- [ ] **Step 3: The client helpers** — in `tests/e2e/support/client.ts`:

Replace `import { ArtifactRepository, EventRepository, GeneratedTestRepository, SecretRepository, createDb } from "@platform/db";` with:

```ts
import { ArtifactRepository, EventRepository, GeneratedTestRepository, LlmCallRepository, SecretRepository, createDb } from "@platform/db";
```

in `call` replace `    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };` with:

```ts
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null, text };
```

after the `artifactUrl: …` entry of the `api` object add:

```ts
    llmSettings: () => call("GET", "/v1/settings/llm"),
    putProviderKey: (provider: "anthropic" | "gemini", apiKey: string | null) => call("PUT", `/v1/settings/llm/keys/${provider}`, { apiKey }),
```

and after `secretsActive: …` in the `db` object add:

```ts
    llmCalls: (runId: string) => new LlmCallRepository(handle.db).listByRun(runId),
    /** The Settings tables' rows (saved defaults, encrypted provider keys), as JSON text. */
    async settingsRows(): Promise<string> {
      const rows = await handle.db.execute<{ j: string }>(
        sql`SELECT row_to_json(s)::text AS j FROM llm_settings s UNION ALL SELECT row_to_json(k)::text AS j FROM llm_provider_keys k`,
      );
      return rows.rows.map((r) => r.j).join("\n");
    },
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm test:e2e tests/e2e/platform-settings.spec.ts`
Expected: PASS.

- [ ] **Step 5: README** — the Settings feature, the `LLM_*` variables as defaults, the deviation.

In "Run everything with Docker" replace:

```markdown
The compose stack runs the **fake** engine (`LLM_PROVIDER=fake`). The `worker` image bundles Playwright's
Chromium (matching the workspace's `playwright-core` pin) and its OS dependencies under `/ms-playwright`, and the
`worker` service runs with the seccomp profile that lets Chromium's sandbox start (`infra/seccomp/worker.json`)
and an init process that reaps the browsers' helpers. For the real engine, set `LLM_PROVIDER=anthropic` and
`ANTHROPIC_API_KEY`, or `LLM_PROVIDER=gemini` and `GEMINI_API_KEY`, in `infra/compose/.env`.
```

with:

```markdown
The compose stack's default model is the **fake** engine (`LLM_PROVIDER=fake`). The `worker` image bundles Playwright's
Chromium (matching the workspace's `playwright-core` pin) and its OS dependencies under `/ms-playwright`, and the
`worker` service runs with the seccomp profile that lets Chromium's sandbox start (`infra/seccomp/worker.json`)
and an init process that reaps the browsers' helpers. For the real engine, open **Settings**
(http://localhost:3000/settings), save an Anthropic or Google Gemini API key and choose the default model (see
[Settings](#settings-ai-providers-and-models)); or set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`, or
`LLM_PROVIDER=gemini` and `GEMINI_API_KEY`, in `infra/compose/.env` — the `LLM_*` variables are the defaults while
Settings hold none.
```

In "Tests", after the paragraph that ends "so set `LLM_MODEL=` (empty) for the provider's default." add:

```markdown
They read only the environment: the keys and defaults saved in Settings apply to the platform's tests, not to
these tools.
```

Add before `## Deviations from the plan`:

```markdown
### Settings: AI providers and models

**Settings** in the header (`/settings`) holds, for the tenant, what the platform's tests run on:

- **AI providers**: one API key per provider (Anthropic, Google Gemini), stored encrypted (AES-256-GCM with
  `SECRETS_ENCRYPTION_KEY`) and never shown again: the page says only "Key saved · updated …", "Using the server's
  key (`ANTHROPIC_API_KEY`)" or "No key". A key saved here is used instead of the server's; "Remove saved key" falls
  back to it.
- **Defaults for new tests**: the model (grouped by provider; a provider without a key has its models disabled,
  "add a key"), its reasoning level ("Model default (…)", or low / medium / high — and minimal on the Gemini Flash
  models), and the selected model's price per million tokens.

A test can pick another model or level under the new-test form's Advanced options. Each run records the provider,
model and reasoning level it was created with, in this order: the test's own choice, else the defaults saved in
Settings, else the environment (`LLM_PROVIDER`, `LLM_MODEL` or the provider's default model, and
`GEMINI_THINKING_LEVEL` for Gemini). Changing Settings never changes a run already created; the run page shows the
run's model ("Claude Sonnet 5 · medium reasoning"). A test whose provider has no key, or whose model or level is not
offered, is refused when it is submitted (`422 MODEL_NOT_AVAILABLE`, naming the fix). The fake engine ("Fake engine
(development)") is offered only outside production. Over the API: `GET /v1/settings/llm`, `PUT /v1/settings/llm`
with `{ "defaults": { "model", "reasoning" } }`, `PUT /v1/settings/llm/keys/{anthropic|gemini}` with
`{ "apiKey": "…" }` (`null` removes it), and `llm: { model?, reasoning? }` on `POST /v1/test-runs`. The API and the
worker must share the `LLM_*` variables (see [`docs/operations.md`](docs/operations.md)).
```

In "Deviations from the plan", replace the end of the "**Anthropic and Gemini are the V1 providers.**" bullet, `The model is set with `LLM_MODEL` (default `claude-sonnet-5`, or `gemini-3.8-flash` for Gemini).`, with:

```markdown
Each test's model comes from Settings or the new-test form; `LLM_MODEL` (default `claude-sonnet-5`, or `gemini-3.8-flash` for Gemini) is the default while Settings hold none.
```

and append to the list (after A's "Destructive actions on production" bullet):

```markdown
- **The model client is built per run** (spec `docs/superpowers/specs/2026-09-28-llm-settings-design.md`). The plan's worker built one `LlmClient` at start-up from `LLM_*`. Now the worker builds both engines at start-up and, for each run, a client from the provider, model and reasoning level the run recorded when it was created (`request.llm`; runs created before this change use `LLM_*`), with the key saved in Settings, else the environment's. The storage check and the browser and runner preflights therefore always run at start-up (the log says "test engines ready"). The reasoning level applies to requirement analysis, planning and report diagnostics; Stagehand's browser steps keep the model's default level. Claude Fable 5.1 and Opus 5.5 go through Anthropic's beta Messages API with server-side refusal fallback (`server-side-fallback-2026-07-01`): a call a fallback model answered is recorded and priced under that model.
```

In "Layout", replace `apps/web                     Next.js UI: new test, criteria review, live progress (Task 19); report, run history (Task 20); server-side API proxy in app/api/[...path]` with:

```text
apps/web                     Next.js UI: new test, criteria review, live progress (Task 19); report, run history (Task 20); Settings (AI provider keys, default model); server-side API proxy in app/api/[...path]
```

and `packages/llm                 provider-neutral LLM client (redaction, retries, LlmCall records), Anthropic and Gemini adapters` with:

```text
packages/llm                 provider-neutral LLM client (redaction, retries, LlmCall records, reasoning level), Anthropic and Gemini adapters, the model catalog
```

- [ ] **Step 6: Full verification**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm test`
Expected: PASS (every package: contracts, config, security, llm, db, event-bus, storage, api, worker, testing-engine, stagehand-adapter, web).

Run: `pnpm test:integration`
Expected: PASS.

Run: `pnpm test:e2e`
Expected: PASS (the whole CI-mode suite, `platform-settings.spec.ts` included).

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/platform-settings.spec.ts tests/e2e/support/client.ts README.md
git commit -m "test: E2E run on a model chosen for it with a key saved in Settings; README documents Settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
