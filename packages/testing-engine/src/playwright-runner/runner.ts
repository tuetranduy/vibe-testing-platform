import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GeneratedTest, RerunOutcome, RerunResult } from "@platform/contracts";
import { checkGeneratedSource } from "../compiler/ast-guard";
import { secretEnvName } from "../compiler/test-compiler";
import type { LocalArtifact } from "../evidence/collector";
import { CONFIG_FILE, RESULTS_FILE, buildPlaywrightConfig } from "./config-template";
import { RunResultsError, parseRunResults, type ParsedRunResults } from "./result-parser";
import { prepareWorkspace, type Workspace, type WorkspaceConfig } from "./workspace";

/**
 * Playwright runner (Task 17): reruns a generated test in its own workspace, in a child process
 * started through a spawn port (the worker's sandbox/runner-process.ts: env allow-list, own process
 * group), with Chromium behind the rerun's egress proxy, and reads the per-criterion outcomes.
 *
 * - Ruling R42: the source is re-checked with the AST guard first; a rejected source never runs.
 * - Ruling R41: a rerun that fails on its own (guard, workspace, spawn, crash, unreadable results,
 *   the budget, the abort signal) is status ERRORED, returned — never thrown. Criteria whose `[AC-n]`
 *   step completed keep their outcome, the others are NOT_REACHED. The caller (the stage) decides
 *   whether an abort was the run's own signal and throws that.
 * - The budget (`timeoutMs`): Playwright's test timeout sits inside it, so a slow test still reports
 *   what completed; the child is killed at the budget regardless.
 *
 * Secrets reach the child only as `SECRET_<NAME>` environment variables (D11), never in a file.
 * The workspace is left in place for the caller to upload the evidence, then remove.
 */

export interface RunnerProcessInput {
  /** The workspace; the child's working directory. */
  cwd: string;
  /** The Playwright CLI entry script, run with the worker's Node. */
  cliPath: string;
  args: string[];
  /** Only `SECRET_<NAME>` variables of this run; the spawn port adds PATH and Playwright's own. */
  env: Record<string, string>;
  /** The child's TMPDIR (inside the workspace). */
  tmpDir: string;
  /** Aborting kills the child's whole process group; the port resolves once it is gone. */
  signal: AbortSignal;
}

export interface RunnerProcessResult {
  exitCode: number | null;
  signal: string | null;
}

/** Spawn port (Ruling R32), implemented by the worker. Rejects only when the child cannot be started. */
export type SpawnRunner = (input: RunnerProcessInput) => Promise<RunnerProcessResult>;

export interface RunGeneratedTestInput {
  runId: string;
  test: GeneratedTest;
  /** Secret name → value, for this run only. */
  secrets: Record<string, string>;
  /** The rerun's egress proxy, `http://127.0.0.1:<port>`. */
  proxyUrl: string;
  /** The rerun budget. */
  timeoutMs: number;
  signal: AbortSignal;
}

export interface RunGeneratedTestDeps {
  spawn: SpawnRunner;
  workspace: WorkspaceConfig;
  /** Per action (click, fill, …). Default 10 s. */
  actionTimeoutMs?: number;
  /** Per assertion; Playwright's default when omitted. */
  expectTimeoutMs?: number;
}

export interface RunGeneratedTestResult {
  status: RerunResult["status"];
  perCriterion: Record<string, RerunOutcome>;
  errorText: Record<string, string>;
  /** Evidence files inside the workspace (trace, screenshot, video), not yet scrubbed. */
  artifacts: LocalArtifact[];
  durationMs: number;
}

export const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
/** Kept out of Playwright's test timeout for starting the runner and writing results. */
const RUNNER_OVERHEAD_MS = 10_000;

/** Playwright's test timeout inside a rerun budget. */
export function testTimeoutFor(budgetMs: number): number {
  return Math.max(1_000, budgetMs - Math.min(RUNNER_OVERHEAD_MS, Math.floor(budgetMs / 4)));
}

const REASON = {
  rejected: "The generated test was rejected by the safety check and was not run",
  workspace: "The rerun workspace could not be prepared",
  spawn: "The Playwright runner could not be started",
  budget: "The rerun was stopped: its time budget was exhausted",
  aborted: "The rerun was stopped: the run was cancelled or reached its deadline",
  noResults: "The Playwright runner did not produce results",
  unreadable: "The Playwright runner's results could not be read",
} as const;

export async function runGeneratedTest(input: RunGeneratedTestInput, deps: RunGeneratedTestDeps): Promise<RunGeneratedTestResult> {
  const startedAt = Date.now();
  const compiled = input.test.compiledCriteria;
  const errored = (reason: string, parsed?: ParsedRunResults): RunGeneratedTestResult => {
    const perCriterion: Record<string, RerunOutcome> = {};
    const errorText: Record<string, string> = {};
    for (const id of compiled) {
      perCriterion[id] = parsed?.perCriterion[id] ?? "NOT_REACHED";
      const text = parsed?.errorText[id] ?? (perCriterion[id] === "NOT_REACHED" ? reason : undefined);
      if (text !== undefined) errorText[id] = text;
    }
    return { status: "ERRORED", perCriterion, errorText, artifacts: parsed?.artifacts ?? [], durationMs: Date.now() - startedAt };
  };

  if (checkGeneratedSource(input.test.source).length > 0) return errored(REASON.rejected);
  if (input.signal.aborted) return errored(REASON.aborted);

  let workspace: Workspace;
  let env: Record<string, string>;
  try {
    env = Object.fromEntries(Object.entries(input.secrets).map(([name, value]) => [secretEnvName(name), value]));
    const config = buildPlaywrightConfig({
      proxyUrl: input.proxyUrl,
      testTimeoutMs: testTimeoutFor(input.timeoutMs),
      actionTimeoutMs: deps.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
      ...(deps.expectTimeoutMs !== undefined ? { expectTimeoutMs: deps.expectTimeoutMs } : {}),
    });
    workspace = await prepareWorkspace(deps.workspace, input.runId, {
      source: input.test.source,
      helpersSource: input.test.helpersSource,
      dataJson: input.test.dataJson,
      config,
    });
  } catch {
    return errored(REASON.workspace);
  }

  const budget = AbortSignal.timeout(Math.max(1, input.timeoutMs));
  const signal = AbortSignal.any([input.signal, budget]);
  try {
    await deps.spawn({ cwd: workspace.dir, cliPath: workspace.cliPath, args: ["test", "--config", CONFIG_FILE], env, tmpDir: workspace.tmpDir, signal });
  } catch {
    return errored(signal.aborted ? (input.signal.aborted ? REASON.aborted : REASON.budget) : REASON.spawn);
  }
  if (input.signal.aborted) return errored(REASON.aborted);
  if (budget.aborted) return errored(REASON.budget);

  let raw: string;
  try {
    raw = await readFile(path.join(workspace.dir, RESULTS_FILE), "utf8");
  } catch {
    return errored(REASON.noResults);
  }
  let parsed: ParsedRunResults;
  try {
    parsed = parseRunResults(raw, { compiledCriteria: compiled, workspaceDir: workspace.dir });
  } catch (err) {
    if (err instanceof RunResultsError) return errored(REASON.unreadable);
    throw err;
  }

  const allPassed = compiled.every((id) => parsed.perCriterion[id] === "PASSED");
  if (parsed.runErrors.length > 0) return errored(`The Playwright runner reported an error: ${parsed.runErrors[0]}`.slice(0, 1000), parsed);
  if (parsed.stopped) return errored(REASON.budget, parsed);
  if (parsed.testStatus === "failed") {
    return { status: "FAILED", perCriterion: parsed.perCriterion, errorText: parsed.errorText, artifacts: parsed.artifacts, durationMs: Date.now() - startedAt };
  }
  if (parsed.testStatus === "passed" && allPassed) {
    return { status: "PASSED", perCriterion: parsed.perCriterion, errorText: parsed.errorText, artifacts: parsed.artifacts, durationMs: Date.now() - startedAt };
  }
  // Skipped, no test, or a "passed" test that never reached a compiled criterion: not a real rerun.
  return errored(REASON.unreadable, parsed);
}
