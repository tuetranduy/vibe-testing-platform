import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv, loadLiveLlmEnv } from "./env";

const validEnv: Record<string, string | undefined> = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/platform",
  REDIS_URL: "redis://localhost:6379",
  ARTIFACT_STORAGE_TYPE: "local",
  ARTIFACT_BUCKET: "artifacts",
  ARTIFACT_LOCAL_DIR: "/tmp/artifacts",
  LLM_PROVIDER: "fake",
  BROWSER_MODE: "local",
  API_TOKEN: "dev-token-0123456789abcdef",
  DEFAULT_TENANT_ID: "t_default",
  SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("loadEnv", () => {
  it("SURVEY_TIMEOUT_SECONDS: the survey's hard deadline, 180 by default", () => {
    expect(loadEnv(validEnv).SURVEY_TIMEOUT_SECONDS).toBe(180);
    expect(loadEnv({ ...validEnv, SURVEY_TIMEOUT_SECONDS: "60" }).SURVEY_TIMEOUT_SECONDS).toBe(60);
    expect(() => loadEnv({ ...validEnv, SURVEY_TIMEOUT_SECONDS: "0" })).toThrow(/SURVEY_TIMEOUT_SECONDS/);
  });

  it("parses a valid environment and applies defaults", () => {
    const env = loadEnv(validEnv);
    expect(env.MAX_ACTIVE_RUNS_PER_TENANT).toBe(3);
    expect(env.CONFIRMATION_TTL_HOURS).toBe(24);
    expect(env.ANALYSIS_TIMEOUT_SECONDS).toBe(120);
    expect(env.WORKER_CONCURRENCY).toBe(2);
    expect(env.ARTIFACT_RETENTION_DAYS).toBe(30);
    expect(env.SECRET_ARTIFACT_RETENTION_DAYS).toBe(7);
    expect(env.TARGET_PRIVATE_ALLOWLIST).toEqual([]);
    expect(env.secretsKey).toHaveLength(32);
  });

  it("fails fast when DATABASE_URL is missing", () => {
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it("lists every bad key in the error", () => {
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: undefined, REDIS_URL: undefined })).toThrow(/DATABASE_URL[\s\S]*REDIS_URL|REDIS_URL[\s\S]*DATABASE_URL/);
  });

  it("rejects the example SECRETS_ENCRYPTION_KEY and API_TOKEN in production, but not in development", () => {
    const strongKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString("base64");
    const prod = { ...validEnv, NODE_ENV: "production", LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k", SECRETS_ENCRYPTION_KEY: strongKey };
    expect(() => loadEnv(prod)).not.toThrow();
    const allZero = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(() => loadEnv({ ...prod, SECRETS_ENCRYPTION_KEY: allZero })).toThrow(/SECRETS_ENCRYPTION_KEY: looks like a placeholder/);
    expect(() => loadEnv({ ...prod, API_TOKEN: "dev-api-token-change-me-please" })).toThrow(/API_TOKEN: is the development default/);
    expect(() => loadEnv({ ...validEnv, SECRETS_ENCRYPTION_KEY: allZero, API_TOKEN: "dev-api-token-change-me-please" })).not.toThrow();
  });

  it("sessions and the bootstrap admin (V1.1): defaults, both-or-neither, no dev password in production", () => {
    expect(loadEnv(validEnv).SESSION_TTL_HOURS).toBe(12);
    expect(loadEnv(validEnv).BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(loadEnv({ ...validEnv, BOOTSTRAP_ADMIN_EMAIL: "", BOOTSTRAP_ADMIN_PASSWORD: "" }).BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(() => loadEnv({ ...validEnv, BOOTSTRAP_ADMIN_EMAIL: "a@example.com" })).toThrow(/BOOTSTRAP_ADMIN_PASSWORD: set BOOTSTRAP_ADMIN_EMAIL and/);
    expect(() => loadEnv({ ...validEnv, BOOTSTRAP_ADMIN_EMAIL: "a@example.com", BOOTSTRAP_ADMIN_PASSWORD: "short" })).toThrow(/at least 10/);
    const dev = { ...validEnv, BOOTSTRAP_ADMIN_EMAIL: "admin@example.com", BOOTSTRAP_ADMIN_PASSWORD: "admin-password-change-me" };
    expect(() => loadEnv(dev)).not.toThrow();
    const strongKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString("base64");
    const prod = { ...dev, NODE_ENV: "production", LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k", SECRETS_ENCRYPTION_KEY: strongKey };
    expect(() => loadEnv(prod)).toThrow(/BOOTSTRAP_ADMIN_PASSWORD: is the development default/);
    expect(() => loadEnv({ ...prod, BOOTSTRAP_ADMIN_PASSWORD: "a real long passphrase" })).not.toThrow();
    expect(() => loadEnv({ ...validEnv, SESSION_TTL_HOURS: "0" })).toThrow(/SESSION_TTL_HOURS/);
  });

  it("rejects TARGET_PRIVATE_ALLOWLIST in production", () => {
    expect(() =>
      loadEnv({ ...validEnv, NODE_ENV: "production", TARGET_PRIVATE_ALLOWLIST: "demo-shop:4000" }),
    ).toThrow(/TARGET_PRIVATE_ALLOWLIST/);
  });

  it("parses TARGET_PRIVATE_ALLOWLIST outside production", () => {
    const env = loadEnv({ ...validEnv, TARGET_PRIVATE_ALLOWLIST: "demo-shop:4000, localhost:4000" });
    expect(env.TARGET_PRIVATE_ALLOWLIST).toEqual(["demo-shop:4000", "localhost:4000"]);
  });

  it("requires a 32-byte SECRETS_ENCRYPTION_KEY", () => {
    expect(() => loadEnv({ ...validEnv, SECRETS_ENCRYPTION_KEY: "short" })).toThrow(/SECRETS_ENCRYPTION_KEY/);
    expect(() =>
      loadEnv({ ...validEnv, SECRETS_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/SECRETS_ENCRYPTION_KEY/);
  });

  it("requires S3 settings when ARTIFACT_STORAGE_TYPE=s3", () => {
    expect(() => loadEnv({ ...validEnv, ARTIFACT_STORAGE_TYPE: "s3" })).toThrow(/S3_ENDPOINT|S3_ACCESS_KEY_ID/);
    const env = loadEnv({
      ...validEnv,
      ARTIFACT_STORAGE_TYPE: "s3",
      S3_ENDPOINT: "http://localhost:9000",
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "minio",
      S3_SECRET_ACCESS_KEY: "minio-secret",
    });
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it("S3_PUBLIC_ENDPOINT is optional; set, it must be an http(s) URL; empty means unset (Ruling R54)", () => {
    expect(loadEnv(validEnv).S3_PUBLIC_ENDPOINT).toBeUndefined();
    expect(loadEnv({ ...validEnv, S3_PUBLIC_ENDPOINT: "" }).S3_PUBLIC_ENDPOINT).toBeUndefined();
    expect(loadEnv({ ...validEnv, S3_PUBLIC_ENDPOINT: "http://localhost:9000" }).S3_PUBLIC_ENDPOINT).toBe(
      "http://localhost:9000",
    );
    expect(loadEnv({ ...validEnv, S3_PUBLIC_ENDPOINT: "https://files.example.com" }).S3_PUBLIC_ENDPOINT).toBe(
      "https://files.example.com",
    );
    expect(() => loadEnv({ ...validEnv, S3_PUBLIC_ENDPOINT: "localhost:9000" })).toThrow(/S3_PUBLIC_ENDPOINT/);
    expect(() => loadEnv({ ...validEnv, S3_PUBLIC_ENDPOINT: "ftp://localhost:9000" })).toThrow(/S3_PUBLIC_ENDPOINT/);
  });

  it("provider keys are optional for anthropic and gemini: Settings may hold them (compose passes an unset key as empty)", () => {
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic" }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "" }).LLM_PROVIDER).toBe("gemini");
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" }).ANTHROPIC_API_KEY).toBe("sk-test");
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-test" }).GEMINI_API_KEY).toBe("gm-test");
  });

  it("LLM_PROVIDER=openai still needs OPENAI_API_KEY (resolveEnvLlmChoice then refuses it: not built in V1)", () => {
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
  });

  it("LLM_MODEL defaults to the provider's model, can be overridden, and is unset when empty (compose)", () => {
    expect(loadEnv(validEnv).LLM_MODEL).toBe("claude-sonnet-5");
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" }).LLM_MODEL).toBe("claude-sonnet-5");
    const gemini = { ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-test" };
    expect(loadEnv(gemini).LLM_MODEL).toBe("gemini-3.8-flash");
    expect(loadEnv({ ...gemini, LLM_MODEL: "" }).LLM_MODEL).toBe("gemini-3.8-flash");
    expect(loadEnv({ ...gemini, LLM_MODEL: "gemini-3.1-pro-preview" }).LLM_MODEL).toBe("gemini-3.1-pro-preview");
    expect(loadEnv({ ...validEnv, LLM_MODEL: "claude-opus-5" }).LLM_MODEL).toBe("claude-opus-5");
  });

  it("rejects the other provider's model, e.g. a leftover LLM_MODEL=claude-… with LLM_PROVIDER=gemini", () => {
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-test", LLM_MODEL: "claude-sonnet-5" })).toThrow(
      /LLM_MODEL: claude-sonnet-5 is not a gemini model/,
    );
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test", LLM_MODEL: "gemini-3.8-flash" })).toThrow(
      /LLM_MODEL/,
    );
    // The fake engine ignores the model.
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "fake", LLM_MODEL: "gemini-3.8-flash" }).LLM_MODEL).toBe("gemini-3.8-flash");
  });

  it("rejects a provider key that can't be an HTTP header value, without printing the key", () => {
    let message = "";
    try {
      loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-secret\nkey" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/GEMINI_API_KEY/);
    expect(message).not.toContain("gm-secret");
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant\u0000x" })).toThrow(/ANTHROPIC_API_KEY/);
    // Surrounding whitespace is dropped from header values, so such a key keeps working, as before.
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-test\n" }).GEMINI_API_KEY).toBe("gm-test\n");
  });

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

  it("GEMINI_THINKING_LEVEL is optional (empty means unset) and must be a Gemini level", () => {
    expect(loadEnv(validEnv).GEMINI_THINKING_LEVEL).toBeUndefined();
    expect(loadEnv({ ...validEnv, GEMINI_THINKING_LEVEL: "" }).GEMINI_THINKING_LEVEL).toBeUndefined();
    expect(loadEnv({ ...validEnv, GEMINI_THINKING_LEVEL: "low" }).GEMINI_THINKING_LEVEL).toBe("low");
    expect(() => loadEnv({ ...validEnv, GEMINI_THINKING_LEVEL: "extreme" })).toThrow(/GEMINI_THINKING_LEVEL/);
  });

  it("disallows the fake LLM provider in production", () => {
    expect(() => loadEnv({ ...validEnv, NODE_ENV: "production" })).toThrow(/LLM_PROVIDER/);
  });

  it("rejects a short API_TOKEN", () => {
    expect(() => loadEnv({ ...validEnv, API_TOKEN: "abc" })).toThrow(/API_TOKEN/);
  });

  it("Playwright rerun workspace: RUNNER_WORKSPACE_DIR defaults under the OS temp dir; RUNNER_NODE_MODULES_DIR is optional (Ruling R32)", () => {
    const env = loadEnv(validEnv);
    expect(env.RUNNER_WORKSPACE_DIR).toBe(path.join(os.tmpdir(), "platform-runs"));
    expect(env.RUNNER_NODE_MODULES_DIR).toBeUndefined();
    const docker = loadEnv({ ...validEnv, RUNNER_WORKSPACE_DIR: "/work/runs", RUNNER_NODE_MODULES_DIR: "/opt/runner/node_modules" });
    expect(docker.RUNNER_WORKSPACE_DIR).toBe("/work/runs");
    expect(docker.RUNNER_NODE_MODULES_DIR).toBe("/opt/runner/node_modules");
  });

  it("rejects relative runner directories (the workspace is deleted and recreated per run)", () => {
    expect(() => loadEnv({ ...validEnv, RUNNER_WORKSPACE_DIR: "work/runs" })).toThrow(/RUNNER_WORKSPACE_DIR/);
    expect(() => loadEnv({ ...validEnv, RUNNER_WORKSPACE_DIR: "/" })).toThrow(/RUNNER_WORKSPACE_DIR/);
    expect(() => loadEnv({ ...validEnv, RUNNER_NODE_MODULES_DIR: "./node_modules" })).toThrow(/RUNNER_NODE_MODULES_DIR/);
  });
});

describe("loadLiveLlmEnv (evals, live tests and the live gate: a real provider, no database)", () => {
  it("LLM_PROVIDER picks anthropic or gemini; unset or fake (a shell set up for the fake worker) means anthropic, as before", () => {
    expect(loadLiveLlmEnv({ ANTHROPIC_API_KEY: "sk-test" })).toMatchObject({ LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-sonnet-5" });
    expect(loadLiveLlmEnv({ LLM_PROVIDER: "", ANTHROPIC_API_KEY: "sk-test" })).toMatchObject({ LLM_PROVIDER: "anthropic" });
    expect(loadLiveLlmEnv({ LLM_PROVIDER: "fake", LLM_MODEL: "claude-opus-5", ANTHROPIC_API_KEY: "sk-test" })).toMatchObject({
      LLM_PROVIDER: "anthropic",
      LLM_MODEL: "claude-opus-5",
    });
    expect(loadLiveLlmEnv({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-test", GEMINI_THINKING_LEVEL: "low" })).toEqual({
      LLM_PROVIDER: "gemini",
      LLM_MODEL: "gemini-3.8-flash",
      GEMINI_API_KEY: "gm-test",
      GEMINI_THINKING_LEVEL: "low",
    });
    expect(() => loadLiveLlmEnv({ LLM_PROVIDER: "gemni", GEMINI_API_KEY: "gm-test" })).toThrow(/LLM_PROVIDER/);
    expect(() => loadLiveLlmEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" })).toThrow(/LLM_PROVIDER/);
  });

  it("names the key to set when it is unset; any other problem throws, as loadEnv would", () => {
    expect(loadLiveLlmEnv({ LLM_PROVIDER: "fake" })).toEqual({ missingKey: "ANTHROPIC_API_KEY" });
    expect(loadLiveLlmEnv({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "sk-test" })).toEqual({ missingKey: "GEMINI_API_KEY" });
    expect(() => loadLiveLlmEnv({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-test", GEMINI_THINKING_LEVEL: "hi" })).toThrow(/GEMINI_THINKING_LEVEL/);
    expect(() => loadLiveLlmEnv({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "gm-test", LLM_MODEL: "claude-sonnet-5" })).toThrow(/LLM_MODEL/);
  });
});
