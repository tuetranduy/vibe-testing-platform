import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { RerunResultSchema, type GeneratedTest } from "@platform/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELPERS_SOURCE } from "../compiler/helpers-template";
import type { EvidenceStore, EvidenceUpload } from "../evidence/collector";
import type { EventDraft, StageContext } from "../orchestrator/stages";
import { buildPlaywrightConfig } from "./config-template";
import { runGeneratedTest, type RunnerProcessInput, type RunnerProcessResult, type SpawnRunner } from "./runner";
import { createRunTestStage, type RerunProxy } from "./run-stage";
import { defaultRunnerNodeModulesDir, prepareWorkspace, removeWorkspace, workspaceDir } from "./workspace";

/**
 * Task 17 (testing-engine side): the rerun workspace (Step 1), the Playwright config (Step 4), the
 * runner over a spawn port, and the RUNNING_PLAYWRIGHT stage. The real child process, the egress
 * proxy and the demo shop are exercised in apps/worker/src/sandbox/runner-process.test.ts (Ruling R32).
 */

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rerun-ws-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const PROXY = "http://127.0.0.1:41234";

/** A source in the compiler's grammar (it must pass the AST guard). */
function generated(ids: string[], extra = ""): GeneratedTest {
  const steps = ids
    .map(
      (id) => `  await test.step("[${id}] " + data.criteria["${id}"].statement, async () => {
    const message = "[${id}] " + data.criteria["${id}"].statement;
    await expect.soft(page.getByTestId(data.locators.loc1.value), message).toBeVisible();
  });`,
    )
    .join("\n");
  const source = `import { expect, test } from "@playwright/test";
import data from "./run-data.json";

test("discovered flow", async ({ page }) => {
  await page.goto(data.targetUrl);
${extra}${steps}
});
`;
  const criteria = Object.fromEntries(ids.map((id) => [id, { statement: `Statement of ${id}` }]));
  return {
    id: "gt_1",
    source,
    helpersSource: HELPERS_SOURCE,
    dataJson: JSON.stringify({ targetUrl: "https://shop.test/", locators: { loc1: { value: "cart-count" } }, criteria }),
    compiledCriteria: ids,
    notCompiled: [],
    notes: [],
  };
}

/** results.json as the JSON reporter writes it, for a single test. */
function resultsJson(dir: string, over: { status?: string; steps?: { title: string; error?: string; duration?: number }[]; errors?: string[]; attachments?: string[] } = {}): string {
  const out = path.join(dir, "test-results", "run-discovered-flow");
  const kinds: Record<string, [string, string]> = { trace: ["trace.zip", "application/zip"], screenshot: ["test-failed-1.png", "image/png"], video: ["video.webm", "video/webm"] };
  const attachments = (over.attachments ?? []).map((name) => {
    const [file, contentType] = kinds[name]!;
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, file), `${name}-bytes`);
    return { name, contentType, path: path.join(out, file) };
  });
  return JSON.stringify({
    suites: [
      {
        title: "run.spec.ts",
        specs: [
          {
            title: "discovered flow",
            tests: [
              {
                results: [
                  {
                    status: over.status ?? "passed",
                    errors: (over.errors ?? []).map((message) => ({ message })),
                    steps: (over.steps ?? []).map((s) => ({ title: s.title, duration: s.duration ?? 5, ...(s.error ? { error: { message: s.error } } : {}) })),
                    attachments,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    errors: [],
  });
}

type Behaviour = (input: RunnerProcessInput) => Promise<RunnerProcessResult>;
function fakeSpawn(behaviour: Behaviour): SpawnRunner & { calls: RunnerProcessInput[]; snapshot: Record<string, string>[] } {
  const calls: RunnerProcessInput[] = [];
  const snapshot: Record<string, string>[] = [];
  const fn = (async (input: RunnerProcessInput) => {
    calls.push(input);
    // What the child would see in its workspace.
    const files: Record<string, string> = {};
    for (const f of ["run.spec.ts", "helpers.ts", "run-data.json", "playwright.config.js", "package.json"]) files[f] = readFileSync(path.join(input.cwd, f), "utf8");
    snapshot.push(files);
    return behaviour(input);
  }) as SpawnRunner & { calls: RunnerProcessInput[]; snapshot: Record<string, string>[] };
  fn.calls = calls;
  fn.snapshot = snapshot;
  return fn;
}
const writesResults = (over: Parameters<typeof resultsJson>[1], exitCode = 1): Behaviour => async (input) => {
  writeFileSync(path.join(input.cwd, "results.json"), resultsJson(input.cwd, over));
  return { exitCode, signal: null };
};
const untilAborted: Behaviour = (input) =>
  new Promise((resolve) => {
    input.signal.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGKILL" }), { once: true });
  });

const runInput = (test: GeneratedTest, over: Partial<Parameters<typeof runGeneratedTest>[0]> = {}) => ({
  runId: "run_1",
  test,
  secrets: {},
  proxyUrl: PROXY,
  timeoutMs: 60_000,
  signal: new AbortController().signal,
  ...over,
});
const title = (id: string) => `[${id}] Statement of ${id}`;

// ---------------------------------------------------------------------------------------------
// Step 1: workspace
// ---------------------------------------------------------------------------------------------

describe("rerun workspace", () => {
  const files = { source: "// spec", helpersSource: "// helpers", dataJson: "{}", config: "module.exports = {};" };

  it("prepares <base>/<runId>/ with the test files, a CommonJS package.json, a tmp dir and node_modules linked from the runner dir", async () => {
    const ws = await prepareWorkspace({ baseDir: base }, "run_1", files);
    expect(ws.dir).toBe(path.join(base, "run_1"));
    expect(workspaceDir({ baseDir: base }, "run_1")).toBe(ws.dir);
    expect(readFileSync(path.join(ws.dir, "run.spec.ts"), "utf8")).toBe("// spec");
    expect(readFileSync(path.join(ws.dir, "helpers.ts"), "utf8")).toBe("// helpers");
    expect(readFileSync(path.join(ws.dir, "run-data.json"), "utf8")).toBe("{}");
    expect(readFileSync(path.join(ws.dir, "playwright.config.js"), "utf8")).toBe("module.exports = {};");
    // run.spec.ts imports run-data.json without an import attribute: it must load as CommonJS.
    expect(JSON.parse(readFileSync(path.join(ws.dir, "package.json"), "utf8"))).toEqual({ private: true, type: "commonjs" });
    expect(lstatSync(path.join(ws.dir, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(ws.dir, "node_modules"))).toBe(defaultRunnerNodeModulesDir());
    expect(ws.cliPath).toBe(path.join(ws.dir, "node_modules", "@playwright", "test", "cli.js"));
    expect(existsSync(ws.cliPath)).toBe(true);
    expect(lstatSync(ws.tmpDir).isDirectory()).toBe(true);
    expect(ws.tmpDir).toBe(path.join(ws.dir, "tmp"));
    expect(lstatSync(ws.dir).mode & 0o777).toBe(0o700);
  });

  it("deletes and recreates the run's directory: nothing from an earlier attempt survives", async () => {
    const dir = path.join(base, "run_1");
    mkdirSync(path.join(dir, "test-results"), { recursive: true });
    writeFileSync(path.join(dir, "results.json"), "stale");
    writeFileSync(path.join(dir, "test-results", "trace.zip"), "stale");
    await prepareWorkspace({ baseDir: base }, "run_1", files);
    expect(existsSync(path.join(dir, "results.json"))).toBe(false);
    expect(existsSync(path.join(dir, "test-results"))).toBe(false);
  });

  it("the default runner dir is the node_modules that holds the installed @playwright/test", () => {
    const pkg = realpathSync(path.dirname(createRequire(import.meta.url).resolve("@playwright/test/package.json")));
    expect(realpathSync(path.join(defaultRunnerNodeModulesDir(), "@playwright", "test"))).toBe(pkg);
  });

  it("links a configured runner dir (the runner image's), and rejects one without @playwright/test", async () => {
    const runner = path.join(base, "runner-node-modules");
    mkdirSync(path.join(runner, "@playwright", "test"), { recursive: true });
    writeFileSync(path.join(runner, "@playwright", "test", "cli.js"), "");
    const ws = await prepareWorkspace({ baseDir: path.join(base, "runs"), nodeModulesDir: runner }, "run_1", files);
    expect(readlinkSync(path.join(ws.dir, "node_modules"))).toBe(runner);

    await expect(prepareWorkspace({ baseDir: path.join(base, "runs"), nodeModulesDir: path.join(base, "empty") }, "run_2", files)).rejects.toThrow(/@playwright\/test/);
  });

  it.each(["../x", "a/b", "", ".", "..", "run 1"])("rejects run id %j (one safe path segment only)", async (runId) => {
    await expect(prepareWorkspace({ baseDir: base }, runId, files)).rejects.toThrow(/run id/i);
  });

  it("removeWorkspace deletes the run's directory and is idempotent", async () => {
    const ws = await prepareWorkspace({ baseDir: base }, "run_1", files);
    await removeWorkspace({ baseDir: base }, "run_1");
    expect(existsSync(ws.dir)).toBe(false);
    await removeWorkspace({ baseDir: base }, "run_1");
    // The linked runner dir is untouched.
    expect(existsSync(path.join(defaultRunnerNodeModulesDir(), "@playwright", "test", "cli.js"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 4: config
// ---------------------------------------------------------------------------------------------

describe("buildPlaywrightConfig", () => {
  const load = (source: string) => {
    const module = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", source)(module, module.exports);
    return module.exports as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  it("no retries, one worker, the rerun budget as timeout, the JSON reporter, the egress proxy, evidence on failure", () => {
    const config = load(buildPlaywrightConfig({ proxyUrl: PROXY, testTimeoutMs: 45_000, actionTimeoutMs: 10_000 }));
    expect(config).toMatchObject({
      testDir: ".",
      testMatch: "run.spec.ts",
      retries: 0,
      workers: 1,
      timeout: 45_000,
      reporter: [["json", { outputFile: "results.json" }]],
      outputDir: "test-results",
      use: {
        browserName: "chromium",
        headless: true,
        proxy: { server: PROXY },
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
        actionTimeout: 10_000,
        navigationTimeout: 30_000,
      },
    });
    // No bypass: Playwright then routes loopback through the proxy too (<-loopback>).
    expect(config.use.proxy).toEqual({ server: PROXY });
    // Same egress hardening as the exploration sandbox's Chromium.
    expect(config.use.launchOptions.args).toEqual(
      expect.arrayContaining(["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]),
    );
    expect(JSON.stringify(config.use.launchOptions.args)).not.toContain("proxy-bypass");
  });

  it.each(["http://localhost:1234", "https://127.0.0.1:1234", "http://10.0.0.1:3128", "http://127.0.0.1", "http://127.0.0.1:1234/x", "socks5://127.0.0.1:1080"])(
    "rejects proxy %s (only the local egress proxy)",
    (proxyUrl) => {
      expect(() => buildPlaywrightConfig({ proxyUrl, testTimeoutMs: 1000, actionTimeoutMs: 1000 })).toThrow(/proxy/i);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// runGeneratedTest over a spawn port
// ---------------------------------------------------------------------------------------------

describe("runGeneratedTest", () => {
  it("re-checks the source with the AST guard: a rejected source never runs → ERRORED, compiled criteria NOT_REACHED (R42)", async () => {
    const spawn = fakeSpawn(writesResults({}));
    const test = generated(["AC-1", "AC-2"], '  require("child_process").execSync("id");\n');
    const out = await runGeneratedTest(runInput(test), { spawn, workspace: { baseDir: base } });
    expect(out.status).toBe("ERRORED");
    expect(out.perCriterion).toEqual({ "AC-1": "NOT_REACHED", "AC-2": "NOT_REACHED" });
    expect(out.errorText["AC-1"]).toMatch(/safety check/);
    expect(out.artifacts).toEqual([]);
    expect(spawn.calls).toEqual([]);
    expect(existsSync(path.join(base, "run_1"))).toBe(false);
  });

  it("writes the workspace and spawns the Playwright CLI there with only this run's SECRET_* variables", async () => {
    const spawn = fakeSpawn(writesResults({ steps: [{ title: title("AC-1") }] }, 0));
    const test = generated(["AC-1"]);
    await runGeneratedTest(runInput(test, { secrets: { password: "pw-1", api_key: "k-2" } }), { spawn, workspace: { baseDir: base } });

    const [call] = spawn.calls;
    const dir = path.join(base, "run_1");
    expect(call!.cwd).toBe(dir);
    expect(call!.cliPath).toBe(path.join(dir, "node_modules", "@playwright", "test", "cli.js"));
    expect(call!.args).toEqual(["test", "--config", "playwright.config.js"]);
    expect(call!.env).toEqual({ SECRET_PASSWORD: "pw-1", SECRET_API_KEY: "k-2" });
    expect(call!.tmpDir).toBe(path.join(dir, "tmp"));
    const files = spawn.snapshot[0]!;
    expect(files["run.spec.ts"]).toBe(test.source);
    expect(files["helpers.ts"]).toBe(test.helpersSource);
    expect(files["run-data.json"]).toBe(test.dataJson);
    expect(files["playwright.config.js"]).toContain(JSON.stringify(PROXY));
    // Secret values never touch the workspace files.
    expect(JSON.stringify(files)).not.toMatch(/pw-1|k-2/);
  });

  it("the test passed and every compiled criterion passed → PASSED, no evidence", async () => {
    const spawn = fakeSpawn(writesResults({ steps: [{ title: title("AC-1") }, { title: title("AC-2") }] }, 0));
    const out = await runGeneratedTest(runInput(generated(["AC-1", "AC-2"])), { spawn, workspace: { baseDir: base } });
    expect(out).toMatchObject({ status: "PASSED", perCriterion: { "AC-1": "PASSED", "AC-2": "PASSED" }, errorText: {}, artifacts: [] });
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("a soft assertion failed → FAILED; that criterion ASSERTION_FAILED with its error, the next one NOT_REACHED after a hard failure; evidence listed", async () => {
    const spawn = fakeSpawn(
      writesResults({
        status: "failed",
        steps: [{ title: title("AC-1") }, { title: title("AC-2"), error: "Error: [AC-2] Statement of AC-2\n\nExpected: visible" }],
        errors: ["Error: [AC-2] Statement of AC-2", "TimeoutError: locator.click: Timeout 10000ms exceeded."],
        attachments: ["screenshot", "video", "trace"],
      }),
    );
    const out = await runGeneratedTest(runInput(generated(["AC-1", "AC-2", "AC-3"])), { spawn, workspace: { baseDir: base } });
    expect(out.status).toBe("FAILED");
    expect(out.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "ASSERTION_FAILED", "AC-3": "NOT_REACHED" });
    expect(out.errorText).toEqual({
      "AC-2": "Error: [AC-2] Statement of AC-2\nExpected: visible",
      "AC-3": "Not reached: TimeoutError: locator.click: Timeout 10000ms exceeded.",
    });
    expect(out.artifacts.map((a) => [a.type, a.fileName])).toEqual([["SCREENSHOT", "test-failed-1.png"], ["VIDEO", "video.webm"], ["TRACE", "trace.zip"]]);
    for (const a of out.artifacts) expect(existsSync(a.path)).toBe(true); // still there for upload
  });

  it("Playwright's own timeout (budget) → ERRORED; criteria that completed keep their outcome (R41)", async () => {
    const spawn = fakeSpawn(writesResults({ status: "timedOut", steps: [{ title: title("AC-1") }], errors: ["Test timeout of 45000ms exceeded."], attachments: ["trace"] }));
    const out = await runGeneratedTest(runInput(generated(["AC-1", "AC-2"])), { spawn, workspace: { baseDir: base } });
    expect(out.status).toBe("ERRORED");
    expect(out.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "NOT_REACHED" });
    expect(out.artifacts.map((a) => a.type)).toEqual(["TRACE"]);
  });

  it("the Playwright worker died mid-step → ERRORED (R41), never FAILED; the unfinished step is NOT_REACHED, not PASSED", async () => {
    const crash = "Error: worker process exited unexpectedly (code=null, signal=SIGKILL)";
    const spawn = fakeSpawn(writesResults({ status: "failed", steps: [{ title: title("AC-1") }, { title: title("AC-2"), duration: -1 }], errors: [crash], attachments: ["trace"] }));
    const out = await runGeneratedTest(runInput(generated(["AC-1", "AC-2", "AC-3"])), { spawn, workspace: { baseDir: base } });
    expect(out.status).toBe("ERRORED");
    expect(out.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "NOT_REACHED", "AC-3": "NOT_REACHED" });
    expect(out.errorText["AC-2"]).toBe(`Not reached: ${crash}`);
    expect(out.artifacts.map((a) => a.type)).toEqual(["TRACE"]);
  });

  it("killed at the rerun budget after Playwright wrote its results → ERRORED; completed steps keep their outcome, the rest NOT_REACHED (R41)", async () => {
    const spawn = fakeSpawn(async (input) => {
      await writesResults({ status: "failed", steps: [{ title: title("AC-1") }, { title: title("AC-2"), error: "Error: [AC-2] wrong" }], errors: ["Error: [AC-2] wrong"] })(input);
      return untilAborted(input); // then hangs (e.g. closing the browser) until the budget kill
    });
    const out = await runGeneratedTest(runInput(generated(["AC-1", "AC-2", "AC-3"]), { timeoutMs: 300 }), { spawn, workspace: { baseDir: base } });
    expect(out.status).toBe("ERRORED");
    expect(out.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "ASSERTION_FAILED", "AC-3": "NOT_REACHED" });
    expect(out.errorText["AC-2"]).toBe("Error: [AC-2] wrong");
  });

  it("no results.json (runner crashed) → ERRORED, every criterion NOT_REACHED", async () => {
    const spawn = fakeSpawn(async () => ({ exitCode: 134, signal: null }));
    const out = await runGeneratedTest(runInput(generated(["AC-1", "AC-2"])), { spawn, workspace: { baseDir: base } });
    expect(out).toMatchObject({ status: "ERRORED", perCriterion: { "AC-1": "NOT_REACHED", "AC-2": "NOT_REACHED" }, artifacts: [] });
    expect(out.errorText["AC-1"]).toMatch(/did not produce results/);
  });

  it("unparseable results → ERRORED", async () => {
    const spawn = fakeSpawn(async (input) => {
      writeFileSync(path.join(input.cwd, "results.json"), "{ nope");
      return { exitCode: 1, signal: null };
    });
    const out = await runGeneratedTest(runInput(generated(["AC-1"])), { spawn, workspace: { baseDir: base } });
    expect(out.status).toBe("ERRORED");
    expect(out.perCriterion).toEqual({ "AC-1": "NOT_REACHED" });
  });

  it("the spawn itself fails → ERRORED (returned, not thrown)", async () => {
    const spawn = fakeSpawn(async () => Promise.reject(Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" })));
    const out = await runGeneratedTest(runInput(generated(["AC-1"])), { spawn, workspace: { baseDir: base } });
    expect(out).toMatchObject({ status: "ERRORED", perCriterion: { "AC-1": "NOT_REACHED" } });
    expect(out.errorText["AC-1"]).toMatch(/could not be started/);
  });

  it("the rerun budget: the child is stopped at timeoutMs → ERRORED", async () => {
    const spawn = fakeSpawn(untilAborted);
    const started = Date.now();
    const out = await runGeneratedTest(runInput(generated(["AC-1"]), { timeoutMs: 300 }), { spawn, workspace: { baseDir: base } });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(out).toMatchObject({ status: "ERRORED", perCriterion: { "AC-1": "NOT_REACHED" } });
    expect(out.errorText["AC-1"]).toMatch(/time budget/);
    // Playwright's own test timeout sits inside the budget, so it can still report what completed.
    expect(spawn.snapshot[0]!["playwright.config.js"]).toMatch(/"timeout": 1000/);
  });

  it("the abort signal stops the child → ERRORED", async () => {
    const spawn = fakeSpawn(untilAborted);
    const controller = new AbortController();
    const running = runGeneratedTest(runInput(generated(["AC-1"]), { signal: controller.signal }), { spawn, workspace: { baseDir: base } });
    setTimeout(() => controller.abort(new Error("cancelled")), 50);
    const out = await running;
    expect(spawn.calls[0]!.signal.aborted).toBe(true);
    expect(out).toMatchObject({ status: "ERRORED", perCriterion: { "AC-1": "NOT_REACHED" } });
    expect(out.errorText["AC-1"]).toMatch(/stopped/);
  });
});

// ---------------------------------------------------------------------------------------------
// The RUNNING_PLAYWRIGHT stage
// ---------------------------------------------------------------------------------------------

describe("createRunTestStage", () => {
  const SECRET = "pw-Stage-Secret-9";

  function harness(opts: { spawn: SpawnRunner; openProxy?: () => Promise<RerunProxy>; signal?: AbortSignal }) {
    const events: EventDraft[] = [];
    const cleanups: (() => Promise<void> | void)[] = [];
    const uploads: (EvidenceUpload & { workspaceExisted: boolean })[] = [];
    const proxy = { url: PROXY, closed: 0, close: async () => void proxy.closed++ };
    const store: EvidenceStore = {
      async save(upload) {
        uploads.push({ ...upload, workspaceExisted: existsSync(path.join(base, "run_1")) });
        return { artifactId: `art_${uploads.length}` };
      },
    };
    const ctx = {
      runId: "run_1",
      tenantId: "t_1",
      signal: opts.signal ?? new AbortController().signal,
      budgets: { explorationMs: 1_000, rerunMs: 60_000 },
      secrets: { names: ["password"], get: (n: string) => (n === "password" ? SECRET : undefined) },
      redact: (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll(SECRET, "[REDACTED]")),
      publish: async (e: EventDraft) => void events.push(e),
      addCleanup: (fn: () => Promise<void> | void) => void cleanups.push(fn),
    } as unknown as StageContext;
    const stage = createRunTestStage({
      openProxy: opts.openProxy ?? (async () => proxy),
      spawn: opts.spawn,
      workspace: { baseDir: base },
      evidence: () => store,
    });
    const runCleanups = async () => {
      for (const fn of cleanups.reverse()) await fn();
    };
    return { stage, ctx, events, uploads, proxy, runCleanups };
  }

  it("proxy → rerun → evidence uploaded before the workspace is removed → proxy closed; RerunResult carries the artifact ids", async () => {
    const spawn = fakeSpawn(
      writesResults({
        status: "failed",
        steps: [{ title: title("AC-1"), error: `Error: [AC-1] typed ${SECRET}` }],
        errors: [`Error: [AC-1] typed ${SECRET}`],
        attachments: ["screenshot", "trace"],
      }),
    );
    const h = harness({ spawn });
    const rerun = await h.stage(h.ctx, generated(["AC-1"]));

    expect(spawn.calls[0]!.env).toEqual({ SECRET_PASSWORD: SECRET });
    expect(spawn.snapshot[0]!["playwright.config.js"]).toContain(JSON.stringify(PROXY));
    expect(RerunResultSchema.parse(rerun)).toEqual(rerun);
    expect(rerun).toMatchObject({ status: "FAILED", perCriterion: { "AC-1": "ASSERTION_FAILED" }, artifactIds: ["art_1"] });
    expect(rerun.errorText["AC-1"]).toBe("Error: [AC-1] typed [REDACTED]");
    expect(h.uploads.map((u) => [u.type, u.sensitivity, u.workspaceExisted])).toEqual([["SCREENSHOT", "SECRET_BEARING", true]]);
    // The fake "trace-bytes" is not a zip: it cannot be scrubbed, so it is dropped, never uploaded.
    expect(h.events.map((e) => [e.type, (e.payload as { type: string }).type])).toEqual([
      ["artifact.created", "SCREENSHOT"],
      ["artifact.omitted", "TRACE"],
    ]);
    expect(existsSync(path.join(base, "run_1"))).toBe(false);
    expect(h.proxy.closed).toBeGreaterThanOrEqual(1);
    await h.runCleanups(); // idempotent
  });

  it("the run signal (cancel / deadline) throws its reason once the child is stopped; proxy closed, workspace removed", async () => {
    const controller = new AbortController();
    const spawn = fakeSpawn(untilAborted);
    const h = harness({ spawn, signal: controller.signal });
    const running = h.stage(h.ctx, generated(["AC-1"]));
    setTimeout(() => controller.abort(new Error("run cancelled")), 50);
    await expect(running).rejects.toThrow("run cancelled");
    expect(spawn.calls[0]!.signal.aborted).toBe(true);
    await h.runCleanups();
    expect(h.proxy.closed).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(base, "run_1"))).toBe(false);
    expect(h.uploads).toEqual([]);
  });

  it("a proxy that cannot start → rerun ERRORED (R41), nothing spawned", async () => {
    const spawn = fakeSpawn(writesResults({}));
    const h = harness({ spawn, openProxy: async () => Promise.reject(new Error("EADDRINUSE")) });
    const rerun = await h.stage(h.ctx, generated(["AC-1", "AC-2"]));
    expect(rerun).toMatchObject({ status: "ERRORED", perCriterion: { "AC-1": "NOT_REACHED", "AC-2": "NOT_REACHED" }, artifactIds: [] });
    expect(spawn.calls).toEqual([]);
  });
});
