import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";

export interface LaunchOptions {
  /** Log file name (`<logDir>/<name>.log`). */
  name: string;
  /** TypeScript entry, relative to `cwd`. */
  entry: string;
  cwd: string;
  env: Record<string, string>;
  logDir: string;
  /** Grace after SIGTERM before SIGKILL. */
  killAfterMs?: number;
}

export interface LaunchedProcess {
  child: ChildProcess;
  /** SIGTERM, then SIGKILL after the grace; resolves once the process has exited. */
  stop(): Promise<void>;
}

/**
 * Runs a TypeScript entry as a child process with its output in a log file. One process
 * (`node --import tsx`, not the tsx CLI, which runs the entry in a grandchild it only forwards
 * SIGTERM/SIGINT to) in its own process group, so the SIGKILL fallback reaches the process doing
 * the work and anything it started, not just a wrapper.
 */
export function launchProcess(opts: LaunchOptions): LaunchedProcess {
  const log = createWriteStream(path.join(opts.logDir, `${opts.name}.log`));
  const child = spawn(process.execPath, ["--import", "tsx", opts.entry], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      /* the group is already gone */
    }
  };
  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.pid === undefined || exited()) return resolve();
      child.once("exit", () => {
        signalGroup("SIGKILL"); // leftovers of the group (e.g. a browser the process started)
        resolve();
      });
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), opts.killAfterMs ?? 10_000).unref();
    });
  return { child, stop };
}
