import { execFile, spawn } from "node:child_process";
import path from "node:path";
import type { RunnerProcessInput, RunnerProcessResult, SpawnRunner } from "@platform/testing-engine";
import type { WorkerLogger } from "../deps";

/**
 * The Playwright runner's child process (Task 17, Ruling R32): implements testing-engine's spawn
 * port. The worker's Node runs the Playwright CLI in the rerun workspace:
 *
 * - environment allow-list: this run's `SECRET_<NAME>` variables, `PATH`, Playwright's own
 *   `PLAYWRIGHT_BROWSERS_PATH`, and `TMPDIR` pointed into the workspace. Nothing else of the
 *   worker's environment (no DATABASE_URL, API_TOKEN, SECRETS_ENCRYPTION_KEY, provider keys,
 *   NODE_OPTIONS, or PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK, which would let loopback
 *   bypass the egress proxy);
 * - its own process group (`detached`), so an abort SIGKILLs the runner and everything in its group
 *   at once. Playwright starts Chromium in a group of its own; Chromium exits when its pipe to the
 *   runner closes, and as a safety net every process whose command line mentions the workspace (its
 *   profile lives in the workspace's TMPDIR) is killed with its group once the runner is gone;
 * - the port resolves once the child has exited (bounded: `killTimeoutMs` after a kill), and rejects
 *   only when the child cannot be started.
 */

const SECRET_ENV = /^SECRET_[A-Z][A-Z0-9_]{0,31}$/;
/** Playwright's own variables the child may inherit (where the browsers are installed). */
const PLAYWRIGHT_PASSTHROUGH = ["PLAYWRIGHT_BROWSERS_PATH"] as const;
const DEFAULT_KILL_TIMEOUT_MS = 5_000;
const STDERR_TAIL = 4_000;

/** The child's whole environment. Throws if the runner passes anything but `SECRET_<NAME>`. */
export function runnerEnv(secretEnv: Record<string, string>, tmpDir: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  for (const key of Object.keys(secretEnv)) {
    if (!SECRET_ENV.test(key)) throw new Error(`Only SECRET_<NAME> variables may be passed to the Playwright runner, got ${JSON.stringify(key)}`);
  }
  const env: Record<string, string> = {};
  if (source.PATH !== undefined) env.PATH = source.PATH;
  for (const key of PLAYWRIGHT_PASSTHROUGH) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.TMPDIR = tmpDir;
  return { ...env, ...secretEnv };
}

export interface RunnerSpawnOptions {
  logger: Pick<WorkerLogger, "warn">;
  /** How long to wait for the killed process group to exit. */
  killTimeoutMs?: number;
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

let psWarned = false;

/** SIGKILLs the process group of every process whose command line mentions `needle`. Best effort. */
async function killMentioning(needle: string, logger: Pick<WorkerLogger, "warn">): Promise<void> {
  const listing = await new Promise<string | null>((resolve) => {
    execFile("ps", ["-Ao", "pid=,pgid=,args="], { timeout: 2_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
  if (listing === null) {
    if (!psWarned) logger.warn({}, "could not list processes (is `ps` installed?) to check for a leftover Playwright browser");
    psWarned = true;
    return;
  }
  for (const line of listing.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[3]!.includes(needle)) continue;
    const pid = Number(m[1]);
    const pgid = Number(m[2]);
    if (pid === process.pid || pgid === process.pid) continue;
    killGroup(pgid);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export function createRunnerSpawn(opts: RunnerSpawnOptions): SpawnRunner {
  const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  return async (input: RunnerProcessInput): Promise<RunnerProcessResult> => {
    const env = runnerEnv(input.env, input.tmpDir);
    if (input.signal.aborted) return { exitCode: null, signal: "SIGKILL" };

    const child = spawn(process.execPath, [input.cliPath, ...input.args], {
      cwd: input.cwd,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });

    const exited = new Promise<RunnerProcessResult>((resolve, reject) => {
      child.once("error", reject); // could not be started
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    let markAborted = () => {};
    const aborted = new Promise<"aborted">((resolve) => (markAborted = () => resolve("aborted")));
    const onAbort = () => {
      if (child.pid !== undefined) killGroup(child.pid);
      markAborted();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const first = await Promise.race([exited, aborted]);
      if (first === "aborted") return await boundedExit(exited, killTimeoutMs);
      if (first.exitCode !== 0 && first.exitCode !== 1) {
        opts.logger.warn({ exitCode: first.exitCode, signal: first.signal, stderr: stderrTail }, "Playwright runner exited abnormally");
      }
      return first;
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      child.stderr?.destroy();
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) killGroup(child.pid);
      // Safety net: nothing started from this workspace (the runner, its Chromium) outlives the rerun.
      // With the separator, run_1's workspace never matches run_10's.
      await killMentioning(input.cwd.endsWith(path.sep) ? input.cwd : input.cwd + path.sep, opts.logger);
    }
  };
}

/** The child's exit, or a SIGKILL result once `ms` have passed (the group was already killed). */
async function boundedExit(exited: Promise<RunnerProcessResult>, ms: number): Promise<RunnerProcessResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<RunnerProcessResult>((resolve) => {
    timer = setTimeout(() => resolve({ exitCode: null, signal: "SIGKILL" }), ms);
  });
  try {
    return await Promise.race([exited.catch(() => ({ exitCode: null, signal: "SIGKILL" })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
