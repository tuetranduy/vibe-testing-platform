import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDemoShop, type RunningDemoShop } from "@platform/demo-shop";
import { createTestDatabase, type TestDatabase } from "@platform/db/testing";
import { Redis } from "ioredis";
import { launchProcess } from "./process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface E2EStack {
  mode: "ci" | "live";
  apiUrl: string;
  apiToken: string;
  shopUrl: string;
  databaseUrl: string;
  redisUrl: string;
  workerMetricsUrl: string;
  logDir: string;
  runnerDir: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function until(what: string, check: () => Promise<boolean> | boolean, timeoutMs: number, proc?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) throw new Error(`${what}: process exited with ${proc.exitCode}`);
    if (await Promise.resolve().then(check).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what}: not ready after ${timeoutMs} ms`);
}

/**
 * The real platform on this machine: a fresh database, Redis logical DB, MinIO bucket, the demo
 * shop (in-process, loopback, test endpoints on), and the API and worker as child processes (their
 * logs in `logDir`). A failure part-way through stops what already started, then rethrows.
 */
export async function startStack(): Promise<{ stack: E2EStack; stop(): Promise<void> }> {
  const mode = process.env.E2E_MODE === "live" ? "live" : "ci";
  if (mode === "live" && !process.env.ANTHROPIC_API_KEY) throw new Error("E2E_MODE=live needs ANTHROPIC_API_KEY");
  const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), "platform-e2e-")));
  const logDir = path.join(work, "logs");
  const runnerDir = path.join(work, "runs");
  mkdirSync(logDir);
  const stops: (() => Promise<void> | void)[] = [() => rmSync(work, { recursive: true, force: true })];
  const stop = async () => {
    for (const fn of stops.splice(0).reverse()) await Promise.resolve().then(fn).catch(() => {});
  };

  try {
    const db: TestDatabase = await createTestDatabase();
    stops.push(() => db.drop());

    const redisUrl = process.env.E2E_REDIS_URL ?? "redis://localhost:6379/14";
    const redis = new Redis(redisUrl);
    await redis.flushdb();
    redis.disconnect();

    const shop: RunningDemoShop = await startDemoShop({ testEndpoints: true });
    stops.push(() => shop.close());

    const apiPort = await freePort();
    const metricsPort = await freePort();
    const apiToken = `e2e-${randomBytes(12).toString("hex")}`;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "test",
      DATABASE_URL: db.url,
      REDIS_URL: redisUrl,
      ARTIFACT_STORAGE_TYPE: "s3",
      ARTIFACT_BUCKET: `platform-e2e-${randomBytes(4).toString("hex")}`,
      S3_ENDPOINT: process.env.E2E_S3_ENDPOINT ?? "http://localhost:9000",
      S3_ACCESS_KEY_ID: "s3admin",
      S3_SECRET_ACCESS_KEY: "s3admin-secret",
      BROWSER_MODE: "local",
      API_TOKEN: apiToken,
      API_PORT: String(apiPort),
      DEFAULT_TENANT_ID: "t_default",
      SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      MAX_ACTIVE_RUNS_PER_TENANT: "10",
      TARGET_PRIVATE_ALLOWLIST: `127.0.0.1:${shop.port}`,
      RUNNER_WORKSPACE_DIR: runnerDir,
      WORKER_METRICS_PORT: String(metricsPort),
      WORKER_CONCURRENCY: "2",
      LOG_LEVEL: "info",
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    };

    const launch = (name: string, entry: string, extra: Record<string, string>): ChildProcess => {
      const launched = launchProcess({ name, entry, cwd: ROOT, env: { ...env, ...extra }, logDir });
      stops.push(launched.stop);
      return launched.child;
    };

    const api = launch("api", "apps/api/src/main.ts", { LLM_PROVIDER: "fake" });
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    await until("API", async () => (await fetch(`${apiUrl}/healthz`)).ok, 60_000, api);

    const worker = launch("worker", "tests/e2e/support/worker-main.ts", {
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: mode === "live" ? process.env.ANTHROPIC_API_KEY! : "sk-e2e-scripted-not-a-key",
      ...(process.env.LLM_MODEL ? { LLM_MODEL: process.env.LLM_MODEL } : {}),
      E2E_MODE: mode,
    });
    const workerLog = path.join(logDir, "worker.log");
    await until("worker", () => readFileSync(workerLog, "utf8").includes('"msg":"worker started"'), 120_000, worker);

    return {
      stack: {
        mode,
        apiUrl,
        apiToken,
        shopUrl: shop.url,
        databaseUrl: db.url,
        redisUrl,
        workerMetricsUrl: `http://127.0.0.1:${metricsPort}/metrics`,
        logDir,
        runnerDir,
      },
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
