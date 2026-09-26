import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunResultsError, cleanErrorText, parseRunResults } from "./result-parser";

/**
 * The JSON reporter's `results.json` (shape as written by @playwright/test 1.56). Outcomes are keyed
 * on the `[AC-n]` test.step TITLE: a matcher error (e.g. a null read) drops the custom `[AC-n]`
 * assertion message, so messages cannot be trusted to name the criterion.
 */

const WS = path.join(path.sep, "work", "runs", "run_1");
const ANSI = (s: string) => `\u001b[2m${s}\u001b[22m`;

interface StepDraft {
  title: string;
  /** Playwright keeps -1 until the step ends; `null` omits the field. Default 12. */
  duration?: number | null;
  error?: string;
  steps?: StepDraft[];
}
const step = (id: string, error?: string, steps?: StepDraft[]): StepDraft => ({ title: `[${id}] Statement of ${id}`, ...(error ? { error } : {}), ...(steps ? { steps } : {}) });

function results(over: { noTest?: boolean; status?: string; steps?: StepDraft[]; errors?: string[]; attachments?: { name: string; contentType: string; path?: string }[]; topErrors?: string[] } = {}) {
  const serializeStep = (s: StepDraft): unknown => ({
    title: s.title,
    ...(s.duration === null ? {} : { duration: s.duration ?? 12 }),
    ...(s.error ? { error: { message: s.error, stack: `${s.error}\n    at ${WS}/run.spec.ts:20:5` } } : {}),
    ...(s.steps ? { steps: s.steps.map(serializeStep) } : {}),
  });
  const status = over.status ?? "passed";
  return JSON.stringify({
    config: {},
    suites: over.noTest ? [] : [
      {
        title: "run.spec.ts",
        file: "run.spec.ts",
        specs: [
          {
            title: "discovered flow",
            ok: status === "passed",
            tests: [
              {
                timeout: 30000,
                expectedStatus: "passed",
                status: status === "passed" ? "expected" : "unexpected",
                results: [
                  {
                    status,
                    duration: 1234,
                    errors: (over.errors ?? []).map((message) => ({ message })),
                    steps: over.steps?.map(serializeStep),
                    attachments: over.attachments ?? [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    errors: (over.topErrors ?? []).map((message) => ({ message })),
    stats: {},
  });
}

const parse = (raw: string, compiledCriteria = ["AC-1", "AC-2", "AC-3"]) => parseRunResults(raw, { compiledCriteria, workspaceDir: WS });

describe("parseRunResults: outcomes keyed on the [AC-n] step title", () => {
  it("every step present without error → PASSED", () => {
    const parsed = parse(results({ steps: [step("AC-1"), step("AC-2"), step("AC-3")] }));
    expect(parsed.testStatus).toBe("passed");
    expect(parsed.stopped).toBe(false);
    expect(parsed.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "PASSED", "AC-3": "PASSED" });
    expect(parsed.errorText).toEqual({});
  });

  it("a step with an error (even a matcher error without the [AC-n] message) → ASSERTION_FAILED with its error text; the others PASSED", () => {
    const matcherError = `Error: ${ANSI("expect(")}received${ANSI(").")}toContain(expected)\n\nMatcher error: received value must not be null nor undefined\n\n  14 |     const message = "[AC-2] " + data.criteria["AC-2"].statement;\n> 15 |     expect.soft(fact1, message).toContain("x");\n     |                                 ^\n    at ${WS}/run.spec.ts:15:33`;
    const parsed = parse(results({ status: "failed", steps: [step("AC-1"), step("AC-2", matcherError), step("AC-3")], errors: [matcherError] }));
    expect(parsed.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "ASSERTION_FAILED", "AC-3": "PASSED" });
    expect(parsed.errorText["AC-2"]).toBe("Error: expect(received).toContain(expected)\nMatcher error: received value must not be null nor undefined");
    expect(Object.keys(parsed.errorText)).toEqual(["AC-2"]);
  });

  it("an error in a nested step counts for the criterion", () => {
    const parsed = parse(results({ status: "failed", steps: [step("AC-1", undefined, [{ title: "inner", error: "boom" }])] }), ["AC-1"]);
    expect(parsed.perCriterion).toEqual({ "AC-1": "ASSERTION_FAILED" });
    expect(parsed.errorText["AC-1"]).toBe("boom");
  });

  it("a compiled criterion whose step never started → NOT_REACHED, with the error that stopped the test", () => {
    const hard = "TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Checkout', exact: true })\n\n\n  17 |   });\n> 18 |   await page.getByRole(\"button\").click();\n    at /work/runs/run_1/run.spec.ts:18:82";
    const parsed = parse(results({ status: "failed", steps: [step("AC-1"), step("AC-2", "Error: [AC-2] x")], errors: ["Error: [AC-2] x", hard] }));
    expect(parsed.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "ASSERTION_FAILED", "AC-3": "NOT_REACHED" });
    expect(parsed.errorText["AC-3"]).toBe("Not reached: TimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n- waiting for getByRole('button', { name: 'Checkout', exact: true })");
    expect(parsed.stopped).toBe(false);
  });

  it("steps for criteria that were not compiled are ignored; titles must start with the [AC-n] prefix", () => {
    const parsed = parse(results({ steps: [step("AC-1"), step("AC-9"), { title: "Statement mentioning [AC-2]" }] }), ["AC-1", "AC-2"]);
    expect(parsed.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "NOT_REACHED" });
  });

  it("a step cut short by the test timeout did not complete → NOT_REACHED, and the run is marked stopped", () => {
    const cut = "Error: [AC-2] x\n\nExpected: \"zzz\"\nReceived: \"Cart (0)\"\n\nCall Log:\n- Test timeout of 6000ms exceeded";
    const parsed = parse(results({ status: "timedOut", steps: [step("AC-1"), step("AC-2", cut)], errors: ["Test timeout of 6000ms exceeded."] }));
    expect(parsed.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "NOT_REACHED", "AC-3": "NOT_REACHED" });
    expect(parsed.stopped).toBe(true);
    expect(parsed.testStatus).toBe("timedOut");
  });

  it("a step that never ended (Playwright keeps duration -1, no error) did not complete → NOT_REACHED, never PASSED", () => {
    const parsed = parse(results({ status: "failed", steps: [step("AC-1"), { ...step("AC-2"), duration: -1 }], errors: ["Error: boom"] }));
    expect(parsed.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "NOT_REACHED", "AC-3": "NOT_REACHED" });
    expect(parsed.crashed).toBe(true);
    expect(parse(results({ steps: [{ ...step("AC-1"), duration: null }] }), ["AC-1"]).perCriterion).toEqual({ "AC-1": "NOT_REACHED" });
    expect(parse(results({ steps: [{ ...step("AC-1", "Error: x"), duration: -1 }] }), ["AC-1"]).perCriterion).toEqual({ "AC-1": "NOT_REACHED" });
  });

  it("the Playwright worker died mid-test (OOM, native crash) → crashed; completed steps keep their outcome, the in-flight one is NOT_REACHED", () => {
    const crash = "Error: worker process exited unexpectedly (code=null, signal=SIGKILL)";
    const parsed = parse(results({ status: "failed", steps: [step("AC-1"), { ...step("AC-2"), duration: -1 }], errors: [crash] }));
    expect(parsed.crashed).toBe(true);
    expect(parsed.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "NOT_REACHED", "AC-3": "NOT_REACHED" });
    expect(parsed.errorText["AC-2"]).toBe(`Not reached: ${crash}`);
    // Even when every started step had ended, a dead worker means the test did not finish on its own.
    expect(parse(results({ status: "failed", steps: [step("AC-1")], errors: [crash] }), ["AC-1"]).crashed).toBe(true);
    expect(parse(results({ status: "failed", steps: [step("AC-1", "Error: x")], errors: ["Error: x"] }), ["AC-1"]).crashed).toBe(false);
  });

  it("keeps trace, screenshot and video attachments inside the workspace's output dir; drops anything else", () => {
    const out = (f: string) => path.join(WS, "test-results", "run-discovered-flow", f);
    const parsed = parse(
      results({
        status: "failed",
        attachments: [
          { name: "screenshot", contentType: "image/png", path: out("test-failed-1.png") },
          { name: "video", contentType: "video/webm", path: out("video.webm") },
          { name: "error-context", contentType: "text/markdown", path: out("error-context.md") },
          { name: "trace", contentType: "application/zip", path: out("trace.zip") },
          { name: "trace", contentType: "application/zip", path: "/etc/passwd" },
          { name: "screenshot", contentType: "image/png", path: path.join(WS, "test-results", "..", "..", "x.png") },
          { name: "screenshot", contentType: "image/png" },
        ],
      }),
    );
    expect(parsed.artifacts).toEqual([
      { type: "SCREENSHOT", path: out("test-failed-1.png"), contentType: "image/png", fileName: "test-failed-1.png" },
      { type: "VIDEO", path: out("video.webm"), contentType: "video/webm", fileName: "video.webm" },
      { type: "TRACE", path: out("trace.zip"), contentType: "application/zip", fileName: "trace.zip" },
    ]);
  });

  it("run-level errors (config / load / worker crash) are reported; no test ran → every criterion NOT_REACHED", () => {
    const parsed = parse(results({ noTest: true, topErrors: ["Error: Cannot find module '@playwright/test'"] }));
    expect(parsed.testStatus).toBeNull();
    expect(parsed.runErrors).toEqual(["Error: Cannot find module '@playwright/test'"]);
    expect(parsed.perCriterion).toEqual({ "AC-1": "NOT_REACHED", "AC-2": "NOT_REACHED", "AC-3": "NOT_REACHED" });
  });

  it.each([
    ["not JSON", "{"],
    ["wrong shape", JSON.stringify({ suites: "x" })],
    ["more than one test", results().replace('"tests":[{', '"tests":[{"results":[],"status":"skipped"},{')],
  ])("unparseable results (%s) → RunResultsError", (_label, raw) => {
    expect(() => parse(raw)).toThrow(RunResultsError);
  });
});

describe("cleanErrorText", () => {
  it("strips ANSI codes, code snippets and stack lines; bounded length", () => {
    expect(cleanErrorText(`${ANSI("Error")}: x\n\n  3 | const a = 1;\n> 4 | boom();\n    |     ^\n    at /work/runs/run_1/run.spec.ts:4:5`)).toBe("Error: x");
    expect(cleanErrorText("a".repeat(5000))).toHaveLength(1000);
  });
});
