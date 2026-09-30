import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GeneratedTest, RerunOutcome, RerunResult } from "@platform/contracts";
import { createValueRedactor } from "@platform/security";
import { checkGeneratedSource } from "../compiler/ast-guard";
import { HELPERS_SOURCE } from "../compiler/helpers-template";
import { secretEnvName } from "../compiler/test-compiler";
import type { LocalArtifact } from "../evidence/collector";
import { redactedCause, type FailureLogger } from "../shared/log-cause";
import { CONFIG_FILE, RESULTS_FILE, buildPlaywrightConfig } from "./config-template";
import { RunResultsError, parseRunResults, type ParsedRunResults } from "./result-parser";
import { prepareWorkspace, type Workspace, type WorkspaceConfig } from "./workspace";

/**
 * Playwright runner (Task 17): reruns a generated test in its own workspace, in a child process
 * started through a spawn port (the worker's sandbox/runner-process.ts: env allow-list, own process
 * group), with Chromium behind the rerun's egress proxy, and reads the per-criterion outcomes.
 *
 * - Ruling R42: the stored test is re-checked before anything is written: the source with the AST
 *   guard, helpers.ts against the fixed template (the workspace gets the template itself), and
 *   run-data.json (a JSON object whose `targetUrl` and `urls` are http(s)). A rejected test never runs.
 * - Ruling R41: a rerun that fails on its own (guard, workspace, spawn, crash, unreadable results,
 *   the budget, the abort signal) is status ERRORED, returned — never thrown. Criteria whose `[AC-n]`
 *   step completed keep their outcome, the others are NOT_REACHED. The caller (the stage) decides
 *   whether an abort was the run's own signal and throws that.
 * - The budget (`timeoutMs`): Playwright's test timeout sits inside it, so a slow test still reports
 *   what completed; the child is killed at the budget regardless.
 *
 * - Infrastructure failures (workspace, spawn, browser launch, a crashed or silent runner) are
 *   logged with their cause through the logger port — the run's secret values redacted — as the
 *   explore stage logs its start-up failures; the run itself records only a template message. A
 *   misconfigured RUNNER_NODE_MODULES_DIR / RUNNER_WORKSPACE_DIR or a missing browser must not
 *   degrade every run to EXPLORATION_ONLY silently. The run's own abort and the budget are not
 *   logged (they are outcomes, not faults).
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
  /** Keep the video / trace of a passing rerun too (V1.3, the run's recordVideo / recordTrace). Default: on failure only. */
  record?: { video: boolean; trace: boolean };
}

/** Receives the cause of a rerun infrastructure failure. Only the log sees it. */
export type RerunLogger = FailureLogger;

export interface RunGeneratedTestDeps {
  spawn: SpawnRunner;
  workspace: WorkspaceConfig;
  /** Per action (click, fill, …). Default 10 s. */
  actionTimeoutMs?: number;
  /** Per assertion; Playwright's default when omitted. */
  expectTimeoutMs?: number;
  logger?: RerunLogger | undefined;
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

const isHttpUrl = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Why a stored test must not run (Ruling R42), or an empty list: the source fails the AST guard,
 * helpers.ts is not the fixed template, or run-data.json is not the compiler's shape where it
 * matters (a JSON object; `targetUrl` and every `urls` value http(s): they are the pages opened).
 */
export function checkGeneratedTest(test: Pick<GeneratedTest, "source" | "helpersSource" | "dataJson">): string[] {
  const issues = [...checkGeneratedSource(test.source)];
  if (test.helpersSource !== HELPERS_SOURCE) issues.push("helpers.ts is not the fixed helpers template");
  let data: unknown;
  try {
    data = JSON.parse(test.dataJson);
  } catch {
    return [...issues, "run-data.json is not valid JSON"];
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [...issues, "run-data.json is not a JSON object"];
  const { targetUrl, urls } = data as { targetUrl?: unknown; urls?: unknown };
  if (!isHttpUrl(targetUrl)) issues.push("run-data.json targetUrl is not an http(s) URL");
  if (urls !== undefined) {
    if (typeof urls !== "object" || urls === null || Array.isArray(urls)) issues.push("run-data.json urls is not an object");
    else for (const [key, value] of Object.entries(urls)) if (!isHttpUrl(value)) issues.push(`run-data.json urls.${key} is not an http(s) URL`);
  }
  return issues;
}

/** Playwright's test timeout inside a rerun budget. */
export function testTimeoutFor(budgetMs: number): number {
  return Math.max(1_000, budgetMs - Math.min(RUNNER_OVERHEAD_MS, Math.floor(budgetMs / 4)));
}

const REASON = {
  rejected: "The generated test was rejected by the safety check and was not run",
  workspace: "The rerun workspace could not be prepared",
  spawn: "The Playwright runner could not be started",
  browser: "The rerun's browser could not be started",
  budget: "The rerun was stopped: its time budget was exhausted",
  aborted: "The rerun was stopped: the run was cancelled or reached its deadline",
  noResults: "The Playwright runner did not produce results",
  crashed: "The Playwright runner stopped unexpectedly before the test finished",
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

  const redact = createValueRedactor(Object.values(input.secrets));
  const logFailure = (msg: string, cause: unknown) => deps.logger?.error({ runId: input.runId, err: redactedCause(cause, redact) }, msg);

  const issues = checkGeneratedTest(input.test);
  if (issues.length > 0) {
    logFailure("generated test rejected by the safety check; not run", new Error(issues.join("; ")));
    return errored(REASON.rejected);
  }
  if (input.signal.aborted) return errored(REASON.aborted);
  if (input.timeoutMs <= 0) return errored(REASON.budget);

  let workspace: Workspace;
  let env: Record<string, string>;
  try {
    env = Object.fromEntries(Object.entries(input.secrets).map(([name, value]) => [secretEnvName(name), value]));
    const config = buildPlaywrightConfig({
      proxyUrl: input.proxyUrl,
      testTimeoutMs: testTimeoutFor(input.timeoutMs),
      actionTimeoutMs: deps.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
      ...(deps.expectTimeoutMs !== undefined ? { expectTimeoutMs: deps.expectTimeoutMs } : {}),
      ...(input.record ? { record: input.record } : {}),
    });
    workspace = await prepareWorkspace(deps.workspace, input.runId, {
      source: input.test.source,
      helpersSource: HELPERS_SOURCE,
      dataJson: input.test.dataJson,
      config,
    });
  } catch (err) {
    logFailure("rerun workspace could not be prepared (check RUNNER_WORKSPACE_DIR and RUNNER_NODE_MODULES_DIR)", err);
    return errored(REASON.workspace);
  }

  const budget = AbortSignal.timeout(Math.max(1, input.timeoutMs));
  const signal = AbortSignal.any([input.signal, budget]);
  let exit: RunnerProcessResult;
  try {
    exit = await deps.spawn({ cwd: workspace.dir, cliPath: workspace.cliPath, args: ["test", "--config", CONFIG_FILE], env, tmpDir: workspace.tmpDir, signal });
  } catch (err) {
    if (signal.aborted) return errored(input.signal.aborted ? REASON.aborted : REASON.budget);
    logFailure("Playwright runner could not be started", err);
    return errored(REASON.spawn);
  }
  if (input.signal.aborted) return errored(REASON.aborted);

  let raw: string;
  try {
    raw = await readFile(path.join(workspace.dir, RESULTS_FILE), "utf8");
  } catch (err) {
    if (budget.aborted) return errored(REASON.budget);
    logFailure(`Playwright runner did not produce results (exit code ${exit.exitCode}, signal ${exit.signal})`, err);
    return errored(REASON.noResults);
  }
  let parsed: ParsedRunResults;
  try {
    parsed = parseRunResults(raw, { compiledCriteria: compiled, workspaceDir: workspace.dir });
  } catch (err) {
    if (!(err instanceof RunResultsError)) throw err;
    if (budget.aborted) return errored(REASON.budget);
    logFailure("Playwright runner's results could not be read", err.cause ?? err);
    return errored(REASON.unreadable);
  }
  // Killed at the budget after Playwright wrote its results: R41 — completed steps keep their outcome.
  if (budget.aborted) return errored(REASON.budget, parsed);

  // The browser never started: nothing ran, and the raw launch error (paths, Chromium's output) stays in the log.
  if (parsed.launchError !== null) {
    logFailure("rerun browser could not be launched", new Error(parsed.launchError));
    return errored(REASON.browser);
  }

  const allPassed = compiled.every((id) => parsed.perCriterion[id] === "PASSED");
  if (parsed.runErrors.length > 0) {
    logFailure("Playwright runner reported an error", new Error(parsed.runErrors.join("\n")));
    return errored(`The Playwright runner reported an error: ${parsed.runErrors[0]}`.slice(0, 1000), parsed);
  }
  if (parsed.crashed) {
    logFailure("Playwright runner stopped unexpectedly before the test finished", new Error(Object.values(parsed.errorText).join("\n") || REASON.crashed));
    return errored(REASON.crashed, parsed);
  }
  if (parsed.stopped) return errored(REASON.budget, parsed);
  if (parsed.testStatus === "failed") {
    return { status: "FAILED", perCriterion: parsed.perCriterion, errorText: parsed.errorText, artifacts: parsed.artifacts, durationMs: Date.now() - startedAt };
  }
  if (parsed.testStatus === "passed" && allPassed) {
    return { status: "PASSED", perCriterion: parsed.perCriterion, errorText: parsed.errorText, artifacts: parsed.artifacts, durationMs: Date.now() - startedAt };
  }
  // Skipped, no test, or a "passed" test that never reached a compiled criterion: not a real rerun.
  logFailure("Playwright rerun did not run the generated test's criteria", new Error(`test status ${parsed.testStatus ?? "none"}`));
  return errored(REASON.unreadable, parsed);
}
