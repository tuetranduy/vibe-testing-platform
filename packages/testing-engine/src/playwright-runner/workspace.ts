import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { CONFIG_FILE, SPEC_FILE } from "./config-template";

/**
 * The rerun workspace (Task 17, Ruling R32): `<baseDir>/<runId>/`, deleted and recreated for every
 * rerun, removed once its evidence is uploaded.
 *
 *   run.spec.ts, helpers.ts, run-data.json   the generated test (Task 16)
 *   playwright.config.js                     config-template.ts
 *   package.json                             `"type": "commonjs"`: run.spec.ts imports run-data.json
 *                                            without an import attribute, which only CommonJS allows
 *   node_modules → <runner node_modules>     the runner's pre-installed @playwright/test (the runner
 *                                            image's in production; the worker's own install locally)
 *   tmp/                                     the child's TMPDIR (Chromium's profile lives there, so
 *                                            it is deleted with the workspace)
 *
 * `baseDir` comes from config (RUNNER_WORKSPACE_DIR), never hardcoded.
 */

export interface WorkspaceConfig {
  /** Absolute directory holding the per-run workspaces. */
  baseDir: string;
  /** A `node_modules` directory that contains `@playwright/test`. Default: `defaultRunnerNodeModulesDir()`. */
  nodeModulesDir?: string | undefined;
}

export interface WorkspaceFiles {
  source: string;
  helpersSource: string;
  dataJson: string;
  config: string;
}

export interface Workspace {
  dir: string;
  tmpDir: string;
  /** The Playwright CLI entry, through the workspace's node_modules link. */
  cliPath: string;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLAYWRIGHT_TEST = path.join("@playwright", "test");

/** The `node_modules` directory that holds the installed `@playwright/test` (resolved at runtime). */
export function defaultRunnerNodeModulesDir(): string {
  const pkg = realpathSync(path.dirname(createRequire(import.meta.url).resolve("@playwright/test/package.json")));
  return path.resolve(pkg, "..", "..");
}

export function workspaceDir(config: WorkspaceConfig, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`Invalid run id for a rerun workspace: ${JSON.stringify(runId)}`);
  if (!path.isAbsolute(config.baseDir)) throw new Error("The rerun workspace base directory must be absolute");
  return path.join(config.baseDir, runId);
}

export async function prepareWorkspace(config: WorkspaceConfig, runId: string, files: WorkspaceFiles): Promise<Workspace> {
  const dir = workspaceDir(config, runId);
  const nodeModules = config.nodeModulesDir ?? defaultRunnerNodeModulesDir();
  if (!existsSync(path.join(nodeModules, PLAYWRIGHT_TEST, "cli.js"))) {
    throw new Error(`The runner's node_modules (${nodeModules}) has no @playwright/test`);
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(config.baseDir, { recursive: true });
  await mkdir(dir, { mode: 0o700 });
  const tmpDir = path.join(dir, "tmp");
  await mkdir(tmpDir);
  await Promise.all([
    writeFile(path.join(dir, SPEC_FILE), files.source),
    writeFile(path.join(dir, "helpers.ts"), files.helpersSource),
    writeFile(path.join(dir, "run-data.json"), files.dataJson),
    writeFile(path.join(dir, CONFIG_FILE), files.config),
    writeFile(path.join(dir, "package.json"), JSON.stringify({ private: true, type: "commonjs" })),
    symlink(nodeModules, path.join(dir, "node_modules"), "dir"),
  ]);
  return { dir, tmpDir, cliPath: path.join(dir, "node_modules", PLAYWRIGHT_TEST, "cli.js") };
}

/** Deletes the run's workspace (never follows the node_modules link). Idempotent. */
export async function removeWorkspace(config: WorkspaceConfig, runId: string): Promise<void> {
  await rm(workspaceDir(config, runId), { recursive: true, force: true, maxRetries: 3 });
}
