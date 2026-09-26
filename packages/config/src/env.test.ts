import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

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

  it("requires provider keys for real LLM providers", () => {
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadEnv({ ...validEnv, LLM_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(loadEnv({ ...validEnv, LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" }).LLM_PROVIDER).toBe("anthropic");
  });

  it("LLM_MODEL defaults to claude-sonnet-5 and can be overridden", () => {
    expect(loadEnv(validEnv).LLM_MODEL).toBe("claude-sonnet-5");
    expect(loadEnv({ ...validEnv, LLM_MODEL: "claude-opus-5" }).LLM_MODEL).toBe("claude-opus-5");
    expect(() => loadEnv({ ...validEnv, LLM_MODEL: "" })).toThrow(/LLM_MODEL/);
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
