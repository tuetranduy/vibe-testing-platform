import { execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLiveLlmEnv } from "@platform/config";
import { startDemoShop, type RunningDemoShop } from "@platform/demo-shop";
import { createTestDatabase, type TestDatabase } from "@platform/db/testing";
import { Redis } from "ioredis";
import { launchComposeService, launchProcess, type LaunchedProcess } from "./process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const COMPOSE_FILE = path.join(ROOT, "infra/compose/docker-compose.yml");

export interface E2EStack {
  mode: "ci" | "live";
  /** Where the API and worker run: child processes here, or containers of the compose services. */
  platform: "local" | "compose";
  apiUrl: string;
  apiToken: string;
  /** The bootstrap administrator the API creates at start (V1.1 F1). */
  admin: { email: string; password: string };
  /** The demo shop as this process reaches it (its test endpoints). */
  shopUrl: string;
  /** The demo shop as the platform reaches it: the base of every run's target URL. */
  targetUrl: string;
  databaseUrl: string;
  redisUrl: string;
  workerMetricsUrl: string;
  logDir: string;
  /** RUNNER_WORKSPACE_DIR as the worker sees it. */
  runnerDir: string;
  /** The worker's container (platform `compose`), else null. */
  workerContainer: string | null;
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

/** Runs a command to completion with its output in `logFile`; rejects (naming the log) on failure. */
function runLogged(file: string, args: string[], logFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile);
    const child = execFile(file, args, { maxBuffer: 256 * 1024 * 1024 }, (err) => {
      log.end();
      if (err) reject(new Error(`${file} ${args.join(" ")} failed; see ${logFile}`));
      else resolve();
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
  });
}

/** `url` with another host and port: how a container on the compose network reaches the same service. */
function viaHost(url: string, host: string, port: number): string {
  const u = new URL(url);
  u.hostname = host;
  u.port = String(port);
  return u.toString();
}

/**
 * E2E_MODE=live: the worker's real provider — LLM_PROVIDER=gemini or deepseek, or anthropic when unset or fake —
 * with its model and settings, and only that provider's key. Throws naming what is missing or wrong.
 */
function liveLlmEnv(): Record<string, string> {
  const llm = loadLiveLlmEnv();
  if ("missingKey" in llm) throw new Error(`E2E_MODE=live needs ${llm.missingKey}`);
  if (llm.LLM_PROVIDER === "gemini") {
    return {
      LLM_PROVIDER: "gemini",
      LLM_MODEL: llm.LLM_MODEL,
      GEMINI_API_KEY: llm.GEMINI_API_KEY!,
      ...(llm.GEMINI_THINKING_LEVEL ? { GEMINI_THINKING_LEVEL: llm.GEMINI_THINKING_LEVEL } : {}),
    };
  }
  if (llm.LLM_PROVIDER === "deepseek") {
    return { LLM_PROVIDER: "deepseek", LLM_MODEL: llm.LLM_MODEL, DEEPSEEK_API_KEY: llm.DEEPSEEK_API_KEY! };
  }
  return { LLM_PROVIDER: "anthropic", LLM_MODEL: llm.LLM_MODEL, ANTHROPIC_API_KEY: llm.ANTHROPIC_API_KEY! };
}

/**
 * The real platform on this machine: a fresh database, Redis logical DB, S3 bucket, the demo shop
 * (in-process, loopback, test endpoints on), and the API and worker — as child processes, or with
 * E2E_PLATFORM=compose as containers of the compose `api` and `worker` services (their images built
 * from this checkout, the worker with the compose file's seccomp profile), which reach the shop as
 * `host.docker.internal`. Logs go to `logDir`. A failure part-way through stops what already started,
 * then rethrows.
 */
export async function startStack(): Promise<{ stack: E2EStack; stop(): Promise<void> }> {
  const mode = process.env.E2E_MODE === "live" ? "live" : "ci";
  const platform = process.env.E2E_PLATFORM === "compose" ? "compose" : "local";
  // CI: the scripted model stands in for the transport, so any real provider name and key will do. The API gets
  // the same LLM_* variables (as compose's x-app-env gives both): it resolves each new run's model from them.
  const llmEnv = mode === "live" ? liveLlmEnv() : { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-e2e-scripted-not-a-key" };
  const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), "platform-e2e-")));
  const logDir = path.join(work, "logs");
  mkdirSync(logDir);
  const stops: (() => Promise<void> | void)[] = [() => rmSync(work, { recursive: true, force: true })];
  const stop = async () => {
    for (const fn of stops.splice(0).reverse()) await Promise.resolve().then(fn).catch(() => {});
  };

  try {
    if (platform === "compose") {
      // The containers must run this checkout: build (cached when nothing changed).
      await runLogged("docker", ["compose", "-f", COMPOSE_FILE, "build", "api", "worker", "runner"], path.join(logDir, "build.log"));
    }

    const db: TestDatabase = await createTestDatabase();
    stops.push(() => db.drop());

    const redisUrl = process.env.E2E_REDIS_URL ?? "redis://localhost:6379/14";
    const redis = new Redis(redisUrl);
    await redis.flushdb();
    redis.disconnect();

    const shop: RunningDemoShop = await startDemoShop({ testEndpoints: true });
    stops.push(() => shop.close());
    // Docker Desktop forwards host.docker.internal to this machine, loopback included.
    const targetUrl = platform === "compose" ? `http://host.docker.internal:${shop.port}` : shop.url;

    const apiPort = await freePort();
    const metricsPort = await freePort();
    const apiToken = `e2e-${randomBytes(12).toString("hex")}`;
    const admin = { email: "admin@e2e.test", password: `admin-${randomBytes(9).toString("hex")}` };
    const s3Endpoint = process.env.E2E_S3_ENDPOINT ?? "http://localhost:9000";
    const runnerDir = platform === "compose" ? "/work/runs" : path.join(work, "runs");
    const env: Record<string, string> = {
      NODE_ENV: "test",
      DATABASE_URL: platform === "compose" ? viaHost(db.url, "postgres", 5432) : db.url,
      REDIS_URL: platform === "compose" ? viaHost(redisUrl, "redis", 6379) : redisUrl,
      ARTIFACT_STORAGE_TYPE: "s3",
      ARTIFACT_BUCKET: `platform-e2e-${randomBytes(4).toString("hex")}`,
      S3_ENDPOINT: platform === "compose" ? viaHost(s3Endpoint, "s3", 9000) : s3Endpoint,
      // Signed artifact URLs are opened by this process.
      ...(platform === "compose" ? { S3_PUBLIC_ENDPOINT: s3Endpoint } : {}),
      S3_ACCESS_KEY_ID: "s3admin",
      S3_SECRET_ACCESS_KEY: "s3admin-secret",
      BROWSER_MODE: "local",
      API_TOKEN: apiToken,
      BOOTSTRAP_ADMIN_EMAIL: admin.email,
      BOOTSTRAP_ADMIN_PASSWORD: admin.password,
      API_PORT: platform === "compose" ? "3001" : String(apiPort),
      DEFAULT_TENANT_ID: "t_default",
      SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      MAX_ACTIVE_RUNS_PER_TENANT: "10",
      // A schedule may fire every minute, so the suite-schedule E2E waits at most one (V1.2 F3).
      SCHEDULE_MIN_INTERVAL_MINUTES: "1",
      TARGET_PRIVATE_ALLOWLIST: new URL(targetUrl).host,
      RUNNER_WORKSPACE_DIR: runnerDir,
      WORKER_METRICS_PORT: platform === "compose" ? "9464" : String(metricsPort),
      WORKER_CONCURRENCY: "2",
      LOG_LEVEL: "info",
      ...(platform === "local"
        ? {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
          }
        : {}),
    };

    const suffix = randomBytes(4).toString("hex");
    const launch = (service: "api" | "worker", extra: Record<string, string>, published: { port: number; target: number }): LaunchedProcess => {
      const launched =
        platform === "compose"
          ? launchComposeService({
              composeFile: COMPOSE_FILE,
              service,
              name: `platform-e2e-${service}-${suffix}`,
              env: { ...env, ...extra },
              publish: [`127.0.0.1:${published.port}:${published.target}`],
              ...(service === "worker" ? { command: ["node", "--import", "tsx", "tests/e2e/support/worker-main.ts"] } : {}),
              logDir,
            })
          : launchProcess({
              name: service,
              entry: service === "api" ? "apps/api/src/main.ts" : "tests/e2e/support/worker-main.ts",
              cwd: ROOT,
              env: { ...env, ...extra },
              logDir,
            });
      stops.push(launched.stop);
      return launched;
    };

    const api = launch("api", llmEnv, { port: apiPort, target: 3001 });
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    await until("API", async () => (await fetch(`${apiUrl}/healthz`)).ok, 120_000, api.child);

    // Platform `compose`: reruns run in the runner service's container (KI-029), as in the compose stack.
    let runnerEnv: Record<string, string> = {};
    if (platform === "compose") {
      const runnerToken = `e2e-runner-${randomBytes(12).toString("hex")}`;
      const runnerName = `platform-e2e-runner-${suffix}`;
      const runner = launchComposeService({
        composeFile: COMPOSE_FILE,
        service: "runner",
        name: runnerName,
        env: { RUNNER_TOKEN: runnerToken, RUNNER_WORKSPACE_DIR: runnerDir, LOG_LEVEL: "info" },
        publish: [],
        logDir,
      });
      stops.push(runner.stop);
      await until("runner", () => readFileSync(path.join(logDir, "runner.log"), "utf8").includes('"msg":"runner listening"'), 120_000, runner.child);
      runnerEnv = { RUNNER_URL: `http://${runnerName}:3100`, RUNNER_TOKEN: runnerToken };
    }

    const worker = launch(
      "worker",
      { ...llmEnv, E2E_MODE: mode, ...runnerEnv },
      { port: metricsPort, target: 9464 },
    );
    const workerLog = path.join(logDir, "worker.log");
    await until("worker", () => readFileSync(workerLog, "utf8").includes('"msg":"worker started"'), 120_000, worker.child);

    return {
      stack: {
        mode,
        platform,
        apiUrl,
        apiToken,
        admin,
        shopUrl: shop.url,
        targetUrl,
        databaseUrl: db.url,
        redisUrl,
        workerMetricsUrl: `http://127.0.0.1:${metricsPort}/metrics`,
        logDir,
        runnerDir,
        workerContainer: platform === "compose" ? `platform-e2e-worker-${suffix}` : null,
      },
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
