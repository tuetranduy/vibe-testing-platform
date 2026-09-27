import os from "node:os";
import path from "node:path";
import { z } from "zod";

const intWithDefault = (def: number, min = 1, max = 1_000_000) =>
  z.coerce.number().int().min(min).max(max).default(def);

/** An optional variable that is unset when empty: compose passes an unset `${VAR:-}` as "" (Ruling R54). */
const emptyAsUnset = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const LLM_PROVIDERS = ["fake", "anthropic", "gemini", "openai"] as const;

/** The model used when LLM_MODEL is unset: Gemini's for gemini, otherwise Claude's (the fake engine ignores it). */
export function defaultLlmModel(provider: (typeof LLM_PROVIDERS)[number]): string {
  return provider === "gemini" ? "gemini-3.8-flash" : "claude-sonnet-5";
}

/** The LLM settings: part of the full environment, and all that `loadLiveLlmEnv` reads. */
const LlmFields = z.object({
  LLM_PROVIDER: z.enum(LLM_PROVIDERS),
  /** Model id for the configured provider (see @platform/llm pricing for known ids); unset: `defaultLlmModel`. */
  LLM_MODEL: emptyAsUnset(z.string().min(1)),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  /** Gemini's thinking level (thinking tokens count against a call's output limit); unset: the model's default. */
  GEMINI_THINKING_LEVEL: emptyAsUnset(z.enum(["minimal", "low", "medium", "high"])),
  OPENAI_API_KEY: z.string().optional(),
});
type LlmFields = z.output<typeof LlmFields>;

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
  const other = env.LLM_PROVIDER === "gemini" ? "anthropic" : "gemini";
  if (env.LLM_MODEL?.startsWith(MODEL_PREFIXES[other])) {
    ctx.addIssue({
      code: "custom",
      path: ["LLM_MODEL"],
      message: `${env.LLM_MODEL} is not a ${env.LLM_PROVIDER} model (leave LLM_MODEL empty for ${defaultLlmModel(env.LLM_PROVIDER)})`,
    });
  }
}

const withDefaultModel = <T extends LlmFields>(env: T) => ({ ...env, LLM_MODEL: env.LLM_MODEL ?? defaultLlmModel(env.LLM_PROVIDER) });

/** An absolute directory other than the filesystem root (it is created, and runs below it are deleted). */
const absoluteDir = z
  .string()
  .min(1)
  .refine((v) => path.isAbsolute(v) && path.resolve(v) !== path.parse(path.resolve(v)).root, "must be an absolute directory (not /)");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    ARTIFACT_STORAGE_TYPE: z.enum(["local", "s3"]),
    ARTIFACT_BUCKET: z.string().min(1),
    ARTIFACT_LOCAL_DIR: z.string().default("./.artifacts"),
    S3_ENDPOINT: z.string().optional(),
    /**
     * Endpoint that signed artifact URLs are presigned against, when S3_ENDPOINT isn't reachable
     * from the browser (compose: S3_ENDPOINT=http://s3:9000, S3_PUBLIC_ENDPOINT=http://localhost:9000).
     */
    S3_PUBLIC_ENDPOINT: emptyAsUnset(
      z.string().refine((v) => /^https?:\/\/[^/\s]+/i.test(v) && URL.canParse(v), "must be an http(s) URL"),
    ),
    S3_REGION: z.string().default("us-east-1"),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    ...LlmFields.shape,
    BROWSER_MODE: z.literal("local"),
    API_TOKEN: z.string().min(16, "API_TOKEN must be at least 16 characters"),
    DEFAULT_TENANT_ID: z.string().min(1),
    SECRETS_ENCRYPTION_KEY: z.string().min(1),
    MAX_ACTIVE_RUNS_PER_TENANT: intWithDefault(3),
    CONFIRMATION_TTL_HOURS: intWithDefault(24),
    ANALYSIS_TIMEOUT_SECONDS: intWithDefault(120),
    WORKER_CONCURRENCY: intWithDefault(2),
    ARTIFACT_RETENTION_DAYS: intWithDefault(30),
    SECRET_ARTIFACT_RETENTION_DAYS: intWithDefault(7),
    API_PORT: intWithDefault(3001, 1, 65535),
    /** The worker's Prometheus endpoint (`GET /metrics`); 0 disables it. */
    WORKER_METRICS_PORT: intWithDefault(9464, 0, 65535),
    API_URL: z.string().default("http://localhost:3001"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    /**
     * Playwright rerun (Ruling R32): per-run workspaces are `<dir>/<runId>/`, deleted and recreated
     * for each rerun and removed after its evidence is uploaded. `/work/runs` in the Docker image.
     */
    RUNNER_WORKSPACE_DIR: absoluteDir.default(path.join(os.tmpdir(), "platform-runs")),
    /**
     * The `node_modules` directory that holds `@playwright/test` (the runner image's pre-installed
     * one); each workspace's `node_modules` links to it. Default: resolved at runtime from the
     * worker's own `@playwright/test` install.
     */
    RUNNER_NODE_MODULES_DIR: absoluteDir.optional(),
    TARGET_PRIVATE_ALLOWLIST: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  })
  .superRefine((env, ctx) => {
    const key = decodeKey(env.SECRETS_ENCRYPTION_KEY);
    if (!key) {
      ctx.addIssue({
        code: "custom",
        path: ["SECRETS_ENCRYPTION_KEY"],
        message: "must be base64 that decodes to exactly 32 bytes",
      });
    }
    if (env.NODE_ENV === "production" && env.TARGET_PRIVATE_ALLOWLIST.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["TARGET_PRIVATE_ALLOWLIST"],
        message: "is not allowed in production",
      });
    }
    if (env.NODE_ENV === "production" && env.LLM_PROVIDER === "fake") {
      ctx.addIssue({ code: "custom", path: ["LLM_PROVIDER"], message: "fake provider is not allowed in production" });
    }
    if (env.ARTIFACT_STORAGE_TYPE === "s3") {
      for (const k of ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
        if (!env[k]) ctx.addIssue({ code: "custom", path: [k], message: "is required when ARTIFACT_STORAGE_TYPE=s3" });
      }
    }
    checkLlmSettings(env, ctx);
  })
  .transform((env) => ({ ...withDefaultModel(env), secretsKey: decodeKey(env.SECRETS_ENCRYPTION_KEY)! }));

export type Env = z.output<typeof EnvSchema>;

const LlmEnvSchema = LlmFields.superRefine(checkLlmSettings).transform(withDefaultModel);

export type LiveLlmEnv = Omit<z.output<typeof LlmEnvSchema>, "LLM_PROVIDER"> & { LLM_PROVIDER: "anthropic" | "gemini" };

function decodeKey(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, "base64");
  return buf.length === 32 ? buf : null;
}

export class EnvValidationError extends Error {
  constructor(public readonly issues: { key: string; message: string }[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i.key}: ${i.message}`).join("\n")}`);
    this.name = "EnvValidationError";
  }
}

function parse<T extends z.ZodType>(schema: T, source: Record<string, string | undefined>): z.output<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ key: String(i.path[0] ?? "(root)"), message: i.message }));
    throw new EnvValidationError(issues);
  }
  return result.data;
}

/** Parse and validate the environment. Throws EnvValidationError listing every bad key. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return parse(EnvSchema, source);
}

/**
 * The LLM settings of the tools that need a real model and no database (evals, `@live` tests, the
 * live E2E gate), validated as `loadEnv` does. LLM_PROVIDER picks anthropic or gemini; unset or
 * `fake` (a shell set up for the fake worker) means anthropic, as before Gemini existed. When the
 * provider's API key is unset, returns its variable instead (the tools explain or skip); any other
 * problem throws EnvValidationError.
 */
export function loadLiveLlmEnv(
  source: Record<string, string | undefined> = process.env,
): LiveLlmEnv | { missingKey: "ANTHROPIC_API_KEY" | "GEMINI_API_KEY" } {
  const requested = source.LLM_PROVIDER || "fake";
  const provider = requested === "fake" ? "anthropic" : requested;
  if (provider !== "anthropic" && provider !== "gemini") {
    throw new EnvValidationError([{ key: "LLM_PROVIDER", message: `must be anthropic or gemini here (unset or fake: anthropic), not ${requested}` }]);
  }
  const keyVar = PROVIDER_KEYS[provider];
  if (!source[keyVar]) return { missingKey: keyVar };
  return parse(LlmEnvSchema, { ...source, LLM_PROVIDER: provider }) as LiveLlmEnv;
}

/** For process entrypoints: load env or print the bad keys and exit(1). */
export function loadEnvOrExit(source: Record<string, string | undefined> = process.env): Env {
  try {
    return loadEnv(source);
  } catch (err) {
    if (err instanceof EnvValidationError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
