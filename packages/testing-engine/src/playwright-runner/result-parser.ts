import path from "node:path";
import type { RerunOutcome } from "@platform/contracts";
import { z } from "zod";
import type { LocalArtifact } from "../evidence/collector";

/**
 * Reads the JSON reporter's `results.json` (Task 17). The generated file has one test per scenario (V1.1
 * F9; one in most runs); each compiled criterion's assertions sit in `test.step("[AC-n] <statement>")` of
 * one of them (Task 16). Each test is read on its own, and the run takes the worst of them. Outcomes are
 * keyed on that step TITLE, never on assertion messages (a matcher error, e.g. a null read, drops the
 * custom `[AC-n]` message):
 *
 * - the step (or a step inside it) has an error → ASSERTION_FAILED, with that error's text;
 * - the step is present without error → PASSED;
 * - the step never started (a hard action failed first, or the test stopped) → NOT_REACHED, with the
 *   error that stopped the test;
 * - a step cut short by the test timeout did not complete → NOT_REACHED, and the run is `stopped`;
 * - a step that never ended (Playwright keeps `duration: -1` until step-end; a dying worker never
 *   sends it, and the step has no error) did not complete → NOT_REACHED, and the run is `crashed`;
 *   so is a test failed with "worker process exited unexpectedly" (OOM, native crash): R41 ERRORED.
 * - a test failed because its browser could not be launched (`browserType.launch: …`: a missing
 *   browser, no usable Chromium sandbox) is `launchError`: an infrastructure failure, R41 ERRORED,
 *   never a FAILED rerun with every criterion NOT_REACHED.
 *
 * Attachments are kept only for the trace, screenshot and video, and only inside the workspace's
 * output directory. Anything unreadable → RunResultsError (the rerun is then ERRORED).
 */

export class RunResultsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunResultsError";
  }
}

export type TestStatus = "passed" | "failed" | "timedOut" | "interrupted" | "skipped";

export interface ParsedRunResults {
  /**
   * The worst test status (cut short, then failed, then passed); null when no test ran (e.g. the spec failed
   * to load).
   */
  testStatus: TestStatus | null;
  /** The test was cut short (its timeout, an interruption) rather than finishing on its own. */
  stopped: boolean;
  /** The Playwright worker died, or a step never ended: the rerun did not run to completion. */
  crashed: boolean;
  /** Every compiled criterion: PASSED, ASSERTION_FAILED or NOT_REACHED. */
  perCriterion: Record<string, RerunOutcome>;
  errorText: Record<string, string>;
  artifacts: LocalArtifact[];
  /** Run-level errors (config, load, worker crash), cleaned. */
  runErrors: string[];
  /** The browser could not be launched: that error, cleaned; null otherwise. */
  launchError: string | null;
}

interface JsonStep {
  title: string;
  duration?: number | undefined;
  error?: { message?: string | undefined } | undefined;
  steps?: JsonStep[] | undefined;
}
const ErrorSchema = z.object({ message: z.string().optional() });
const StepSchema: z.ZodType<JsonStep> = z.lazy(() =>
  z.object({ title: z.string(), duration: z.number().optional(), error: ErrorSchema.optional(), steps: z.array(StepSchema).optional() }),
);
const ResultSchema = z.object({
  status: z.enum(["passed", "failed", "timedOut", "interrupted", "skipped"]),
  errors: z.array(ErrorSchema).default([]),
  steps: z.array(StepSchema).optional(),
  attachments: z.array(z.object({ name: z.string(), contentType: z.string(), path: z.string().optional() })).default([]),
});
const TestSchema = z.object({ results: z.array(ResultSchema) });
interface JsonSuite {
  specs?: { tests: z.infer<typeof TestSchema>[] }[] | undefined;
  suites?: JsonSuite[] | undefined;
}
const SuiteSchema: z.ZodType<JsonSuite> = z.lazy(() =>
  z.object({ specs: z.array(z.object({ tests: z.array(TestSchema) })).optional(), suites: z.array(SuiteSchema).optional() }),
);
const ReportSchema = z.object({ suites: z.array(SuiteSchema), errors: z.array(ErrorSchema).default([]) });

const STEP_TITLE = /^\[(AC-\d{1,3})\] /;
const TEST_TIMEOUT = /Test timeout of \d+ms exceeded/;
const WORKER_EXIT = /worker process exited unexpectedly/;
const BROWSER_LAUNCH = /\bbrowserType\.launch(?:PersistentContext)?:/;
const ATTACHMENT_TYPES: Record<string, LocalArtifact["type"]> = { trace: "TRACE", screenshot: "SCREENSHOT", video: "VIDEO" };
export const OUTPUT_DIR = "test-results";
const MAX_ERROR_TEXT = 1000;

/** Error text for the report: no ANSI codes, code snippets or stack lines; bounded. */
export function cleanErrorText(message: string): string {
  return message
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => !/^\s*(?:>\s*)?\d*\s*\|/.test(line) && !/^\s+at /.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_ERROR_TEXT);
}

function firstError(step: JsonStep): string | null {
  if (step.error) return step.error.message ?? "Error";
  for (const child of step.steps ?? []) {
    const e = firstError(child);
    if (e !== null) return e;
  }
  return null;
}

function collectTests(suites: JsonSuite[]): z.infer<typeof TestSchema>[] {
  return suites.flatMap((s) => [...(s.specs ?? []).flatMap((spec) => spec.tests), ...collectTests(s.suites ?? [])]);
}

function artifactsOf(result: z.infer<typeof ResultSchema>, workspaceDir: string): LocalArtifact[] {
  const outputDir = path.join(path.resolve(workspaceDir), OUTPUT_DIR);
  const out: LocalArtifact[] = [];
  for (const a of result.attachments) {
    const type = ATTACHMENT_TYPES[a.name];
    if (!type || !a.path || !path.isAbsolute(a.path)) continue;
    const resolved = path.resolve(a.path);
    const rel = path.relative(outputDir, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    out.push({ type, path: resolved, contentType: a.contentType, fileName: path.basename(resolved) });
  }
  return out;
}

export function parseRunResults(raw: string, opts: { compiledCriteria: string[]; workspaceDir: string }): ParsedRunResults {
  let report: z.infer<typeof ReportSchema>;
  try {
    report = ReportSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new RunResultsError("The rerun's results.json could not be read", { cause: err });
  }
  const results = collectTests(report.suites).flatMap((t) => {
    const last = t.results.at(-1);
    return last ? [last] : [];
  });

  const perCriterion: Record<string, RerunOutcome> = {};
  const errorText: Record<string, string> = {};
  const compiled = new Set(opts.compiledCriteria);
  let stopped = false;
  let crashed = false;
  /** The error that stopped the first test that did not pass: why its later criteria were not reached. */
  let stoppedBy: string | undefined;

  for (const result of results) {
    const cutShort = result.status === "timedOut" || result.status === "interrupted";
    if (cutShort) stopped = true;
    if (result.errors.some((e) => WORKER_EXIT.test(e.message ?? ""))) crashed = true;
    if (result.status !== "passed") stoppedBy ??= result.errors.at(-1)?.message;

    // This test's [AC-n] steps that started, in order.
    const started: { id: string; error: string | null; ended: boolean }[] = [];
    const visit = (steps: JsonStep[]) => {
      for (const step of steps) {
        const id = STEP_TITLE.exec(step.title)?.[1];
        if (id && compiled.has(id)) {
          const ended = typeof step.duration === "number" && step.duration >= 0;
          if (!started.some((s) => s.id === id)) started.push({ id, error: firstError(step), ended });
        } else {
          visit(step.steps ?? []);
        }
      }
    };
    visit(result.steps ?? []);

    started.forEach(({ id, error, ended }, index) => {
      // A step without its step-end never finished, whatever it recorded: not reached.
      if (!ended) {
        crashed = true;
        return;
      }
      if (error === null) {
        perCriterion[id] = "PASSED";
        return;
      }
      // A step the test's timeout (or an interruption) cut short did not complete: not reached.
      if (TEST_TIMEOUT.test(error) || (cutShort && index === started.length - 1)) {
        stopped = true;
        return;
      }
      perCriterion[id] = "ASSERTION_FAILED";
      errorText[id] = cleanErrorText(error);
    });
  }

  const launchFailure = results.flatMap((r) => r.errors).find((e) => BROWSER_LAUNCH.test(e.message ?? ""))?.message;
  for (const id of opts.compiledCriteria) {
    if (perCriterion[id]) continue;
    perCriterion[id] = "NOT_REACHED";
    if (stoppedBy) errorText[id] = `Not reached: ${cleanErrorText(stoppedBy)}`.slice(0, MAX_ERROR_TEXT);
  }

  const RANK: Record<TestStatus, number> = { passed: 0, skipped: 1, failed: 2, interrupted: 3, timedOut: 4 };
  const testStatus = results.reduce<TestStatus | null>((worst, r) => (worst === null || RANK[r.status] > RANK[worst] ? r.status : worst), null);

  return {
    testStatus,
    stopped,
    crashed,
    perCriterion,
    errorText,
    artifacts: results.flatMap((r) => artifactsOf(r, opts.workspaceDir)),
    runErrors: report.errors.map((e) => cleanErrorText(e.message ?? "Error")),
    launchError: launchFailure === undefined ? null : cleanErrorText(launchFailure),
  };
}
