import os from "node:os";
import path from "node:path";
import { z } from "zod";

const intWithDefault = (def: number, min = 1, max = 1_000_000) =>
  z.coerce.number().int().min(min).max(max).default(def);

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
    S3_REGION: z.string().default("us-east-1"),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    LLM_PROVIDER: z.enum(["fake", "anthropic", "openai"]),
    /** Model id for the configured provider (see @platform/llm pricing for known ids). */
    LLM_MODEL: z.string().min(1).default("claude-sonnet-5"),
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
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
    if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "is required when LLM_PROVIDER=anthropic" });
    }
    if (env.LLM_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["OPENAI_API_KEY"], message: "is required when LLM_PROVIDER=openai" });
    }
  })
  .transform((env) => ({ ...env, secretsKey: decodeKey(env.SECRETS_ENCRYPTION_KEY)! }));

export type Env = z.output<typeof EnvSchema>;

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

/** Parse and validate the environment. Throws EnvValidationError listing every bad key. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ key: String(i.path[0] ?? "(root)"), message: i.message }));
    throw new EnvValidationError(issues);
  }
  return result.data;
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
