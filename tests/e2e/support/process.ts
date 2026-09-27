import { execFile, spawn, type ChildProcess } from "node:child_process";
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

export interface ComposeServiceOptions {
  composeFile: string;
  service: string;
  /** Container name (unique per stack). */
  name: string;
  /** Passed by name (`-e KEY`), so no value appears on a command line. */
  env: Record<string, string>;
  /** `docker compose run -p` values, e.g. `127.0.0.1:4100:3001`. */
  publish: string[];
  /** Replaces the service's command. */
  command?: string[];
  logDir: string;
  /** Grace after SIGTERM (`docker stop --time`). */
  stopAfterS?: number;
}

/**
 * A compose service as a one-off container (`docker compose run --rm`): the service's image, network
 * and security options, with this stack's environment. Its output goes to `<logDir>/<service>.log`.
 * Stopping goes through `docker stop` (SIGTERM, then SIGKILL after the grace): a signal to the CLI
 * does not reliably reach the container.
 */
export function launchComposeService(opts: ComposeServiceOptions): LaunchedProcess {
  const log = createWriteStream(path.join(opts.logDir, `${opts.service}.log`));
  const args = [
    ...["compose", "-f", opts.composeFile, "run", "--rm", "--no-deps", "-T", "--name", opts.name],
    ...opts.publish.flatMap((p) => ["-p", p]),
    ...Object.keys(opts.env).flatMap((key) => ["-e", key]),
    opts.service,
    ...(opts.command ?? []),
  ];
  const child = spawn("docker", args, { env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  const docker = (...a: string[]) => new Promise<void>((resolve) => execFile("docker", a, { timeout: 60_000 }, () => resolve()));
  const stop = async () => {
    await docker("stop", "--time", String(opts.stopAfterS ?? 10), opts.name);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 15_000).unref();
      });
    }
    await docker("rm", "--force", opts.name); // `--rm` normally did this already
  };
  return { child, stop };
}
