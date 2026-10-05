import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { VALID_PASSWORD, startDemoShop, type RunningDemoShop } from "@platform/demo-shop";
import type { GeneratedTest } from "@platform/contracts";
import { defaultResolver } from "@platform/security";
import {
  HELPERS_SOURCE,
  checkGeneratedSource,
  collectEvidence,
  runGeneratedTest,
  workspaceDir,
  type EvidenceUpload,
  type RunGeneratedTestInput,
} from "@platform/testing-engine";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startEgressProxy, type EgressBlockEvent, type EgressProxy } from "./egress-proxy";
import { createRunnerSpawn, runnerEnv } from "./runner-process";
import { checkSpawnRequest, createRemoteRunnerSpawn, openRunnerForward, startRunnerServer, type RunnerServer } from "./runner-service";

/**
 * Task 17 Step 2: the generated test rerun for real — the Playwright CLI in a child process (env
 * allow-list, own process group), Chromium through the rerun's egress proxy (Ruling R31), the demo
 * shop as the site under test. `?bug=empty_cart` makes the cart page list nothing while the badge
 * still counts.
 */

let shop: RunningDemoShop;
let base: string;
let proxy: EgressProxy;
let blocks: EgressBlockEvent[];
const logs: unknown[] = [];
const spawn = createRunnerSpawn({ logger: { warn: (obj, msg) => void logs.push({ obj, msg }) } });

beforeAll(async () => {
  shop = await startDemoShop();
});
afterAll(async () => {
  await shop?.close();
});
beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rerun-fixture-")));
  blocks = [];
  // The demo shop is on loopback: only its exact host:port is admitted (TARGET_PRIVATE_ALLOWLIST).
  proxy = await startEgressProxy({ resolve: defaultResolver, privateAllowlist: [`127.0.0.1:${shop.port}`], onBlock: (e) => blocks.push(e) });
});
afterEach(async () => {
  await proxy.close();
  rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Generated tests in the compiler's grammar (each must pass the AST guard)
// ---------------------------------------------------------------------------------------------

type Step = { id: string; body: string };
function generated(opts: { targetUrl: string; flow: string[]; steps: Step[]; after?: Record<string, string[]>; data?: Record<string, unknown>; helpers?: string[] }): GeneratedTest {
  const lines: string[] = [];
  for (const line of opts.flow) lines.push(`  ${line}`);
  for (const s of opts.steps) {
    lines.push(`  await test.step("[${s.id}] " + data.criteria["${s.id}"].statement, async () => {`);
    lines.push(`    const message = "[${s.id}] " + data.criteria["${s.id}"].statement;`);
    lines.push(`    ${s.body}`);
    lines.push("  });");
    for (const line of opts.after?.[s.id] ?? []) lines.push(`  ${line}`);
  }
  const helpers = opts.helpers?.length ? `import { ${opts.helpers.join(", ")} } from "./helpers";\n` : "";
  const source = `import { expect, test } from "@playwright/test";
${helpers}import data from "./run-data.json";

const softExpect = expect.configure({ soft: true });

test("discovered flow", async ({ page }) => {
${lines.join("\n")}
});
`;
  expect(checkGeneratedSource(source)).toEqual([]);
  const criteria = Object.fromEntries(opts.steps.map((s) => [s.id, { statement: `Statement of ${s.id}`, ...((opts.data?.criteria as Record<string, object> | undefined)?.[s.id] ?? {}) }]));
  return {
    id: "gt_fixture",
    source,
    helpersSource: HELPERS_SOURCE,
    dataJson: JSON.stringify({ ...opts.data, targetUrl: opts.targetUrl, criteria }),
    compiledCriteria: opts.steps.map((s) => s.id),
    notCompiled: [],
    notes: [],
  };
}

/** Product 1 → Add to cart → cart page; AC-1 badge counts it, AC-2 the cart lists it, AC-3 the cart heading. */
function cartTest(targetUrl: string, over: { beforeAc3?: string[] } = {}): GeneratedTest {
  return generated({
    targetUrl,
    flow: [
      "await page.goto(data.targetUrl);",
      "await page.getByRole(\"button\", { name: data.locators.loc1.name, exact: true }).click();",
      "await page.goto(data.urls.url1);",
      "// Checkpoint 1",
      'await page.waitForLoadState("load", { timeout: 10000 }).catch(() => {});',
    ],
    steps: [
      { id: "AC-1", body: 'await expect.soft(page.getByTestId(data.locators.loc2.value), message).toContainText(data.criteria["AC-1"].value, { ignoreCase: true, useInnerText: true });' },
      { id: "AC-2", body: 'await softExpect.poll(async () => listContains(await readTextList(page.getByRole("list", { name: data.locators.loc3.name, exact: true }), 0), data.criteria["AC-2"].item, "contains"), { message }).toBe(true);' },
      { id: "AC-3", body: 'await expect.soft(page.getByRole("heading", { name: data.locators.loc4.name, exact: true }), message).toBeVisible();' },
    ],
    after: { "AC-2": over.beforeAc3 ?? [] },
    helpers: ["listContains", "readTextList"],
    data: {
      urls: { url1: `${shop.url}/cart` },
      locators: { loc1: { name: "Add to cart" }, loc2: { value: "cart-count" }, loc3: { name: "Cart items list" }, loc4: { name: "Your cart" }, loc5: { name: "Checkout" } },
      criteria: { "AC-1": { value: "Cart (1)" }, "AC-2": { item: "iPhone 17 Pro" } },
    },
  });
}

const input = (test: GeneratedTest, over: Partial<RunGeneratedTestInput> = {}): RunGeneratedTestInput => ({
  runId: "run_fixture",
  test,
  secrets: {},
  proxyUrl: proxy.url,
  timeoutMs: 60_000,
  signal: new AbortController().signal,
  // The demo shop and the test servers all listen on 127.0.0.1.
  allowedHosts: ["127.0.0.1"],
  ...over,
});
const deps = () => ({ spawn, workspace: { baseDir: base }, actionTimeoutMs: 2_000, expectTimeoutMs: 2_000 });

/** Processes whose command line mentions `needle` (the runner, Chromium: its profile lives in the workspace's tmp dir). */
function processesMentioning(needle: string): string[] {
  const out = execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes(needle) && !l.includes(" ps -Ao"));
}

// ---------------------------------------------------------------------------------------------

describe("runGeneratedTest against the demo shop (real child process, egress proxy)", () => {
  it("a passing test → PASSED, every compiled criterion PASSED, no evidence (retain-on-failure)", async () => {
    const out = await runGeneratedTest(input(cartTest(`${shop.url}/products/1`)), deps());
    expect(out.errorText).toEqual({});
    expect(out).toMatchObject({ status: "PASSED", perCriterion: { "AC-1": "PASSED", "AC-2": "PASSED", "AC-3": "PASSED" }, artifacts: [] });
    expect(blocks).toEqual([]);
  });

  it("one soft assertion fails (?bug=empty_cart) → FAILED; AC-2 ASSERTION_FAILED with its error; AC-1 and AC-3 still PASSED; trace, screenshot and video kept", async () => {
    const out = await runGeneratedTest(input(cartTest(`${shop.url}/products/1?bug=empty_cart`)), deps());
    expect(out.status).toBe("FAILED");
    expect(out.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "ASSERTION_FAILED", "AC-3": "PASSED" });
    expect(Object.keys(out.errorText)).toEqual(["AC-2"]);
    expect(out.errorText["AC-2"]).toMatch(/^Error: \[AC-2\] Statement of AC-2\n.*\nExpected: true\nReceived: false\n/);
    expect(out.artifacts.map((a) => a.type).sort()).toEqual(["SCREENSHOT", "TRACE", "VIDEO"]);
    for (const a of out.artifacts) {
      expect(a.path.startsWith(path.join(workspaceDir({ baseDir: base }, "run_fixture"), "test-results") + path.sep)).toBe(true);
      expect(existsSync(a.path)).toBe(true);
    }
    const trace = out.artifacts.find((a) => a.type === "TRACE")!;
    expect(Object.keys(unzipSync(readFileSync(trace.path))).some((n) => n.endsWith(".trace"))).toBe(true);
  });

  it("a hard action fails before the [AC-3] step → AC-3 NOT_REACHED with the error that stopped the test", async () => {
    const test = cartTest(`${shop.url}/products/1?bug=empty_cart`, { beforeAc3: ['await page.getByRole("button", { name: data.locators.loc5.name, exact: true }).click();'] });
    const out = await runGeneratedTest(input(test), deps());
    expect(out.status).toBe("FAILED");
    expect(out.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "ASSERTION_FAILED", "AC-3": "NOT_REACHED" });
    expect(out.errorText["AC-3"]).toMatch(/^Not reached: TimeoutError: locator\.click: Timeout 2000ms exceeded\./);
    expect(out.artifacts.map((a) => a.type).sort()).toEqual(["SCREENSHOT", "TRACE", "VIDEO"]);
  });

  it("a secret the test fills (process.env.SECRET_PASSWORD) is in the raw trace but never in the scrubbed upload", async () => {
    const test = generated({
      targetUrl: `${shop.url}/login`,
      flow: [
        "await page.goto(data.targetUrl);",
        "await page.getByLabel(data.locators.loc1.text, { exact: true }).fill(data.inputs.input1);",
        "await page.getByLabel(data.locators.loc2.text, { exact: true }).fill(secret(process.env.SECRET_PASSWORD));",
        'await page.getByRole("button", { name: data.locators.loc3.name, exact: true }).click();',
      ],
      steps: [{ id: "AC-1", body: 'await expect.soft(page.getByTestId(data.locators.loc4.value), message).toContainText(data.criteria["AC-1"].value, { ignoreCase: true, useInnerText: true });' }],
      helpers: ["secret"],
      data: {
        inputs: { input1: "qa@demo.test" },
        locators: { loc1: { text: "Email" }, loc2: { text: "Password" }, loc3: { name: "Log in" }, loc4: { value: "account-email" } },
        criteria: { "AC-1": { value: "someone-else@demo.test" } }, // fails → the trace is kept
      },
    });
    const out = await runGeneratedTest(input(test, { secrets: { password: VALID_PASSWORD } }), deps());
    expect(out.perCriterion).toEqual({ "AC-1": "ASSERTION_FAILED" }); // logged in (the secret was filled), wrong email expected
    const trace = out.artifacts.find((a) => a.type === "TRACE")!;
    expect(readFileSync(trace.path).length).toBeGreaterThan(0);
    const raw = Object.values(unzipSync(readFileSync(trace.path))).map((b) => strFromU8(b, true)).join("\n");
    expect(raw).toContain(VALID_PASSWORD);

    const uploads: EvidenceUpload[] = [];
    await collectEvidence({ publish: async () => {} }, [trace], {
      store: { save: async (u) => (uploads.push(u), { artifactId: "art_1" }) },
      secretValues: [VALID_PASSWORD],
    });
    const scrubbed = Object.values(unzipSync(uploads[0]!.body)).map((b) => strFromU8(b, true)).join("\n");
    expect(scrubbed).not.toContain(VALID_PASSWORD);
    expect(scrubbed).not.toContain(Buffer.from(VALID_PASSWORD).toString("base64"));
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("browser traffic goes through the egress proxy, loopback included: a non-allowlisted address is blocked by the proxy, never connected to", async () => {
    const hits: string[] = [];
    const other = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("<h1>Internal admin</h1>");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const port = (other.address() as net.AddressInfo).port;
    try {
      const test = generated({
        targetUrl: `http://127.0.0.1:${port}/admin`,
        flow: ["await page.goto(data.targetUrl);"],
        steps: [{ id: "AC-1", body: 'await expect.soft(page.getByRole("heading", { name: data.locators.loc1.name, exact: true }), message).toBeVisible();' }],
        data: { locators: { loc1: { name: "Internal admin" } } },
      });
      const out = await runGeneratedTest(input(test), deps());
      expect(hits).toEqual([]);
      expect(blocks).toContainEqual({ host: "127.0.0.1", port, reason: "NON_PUBLIC_ADDRESS" });
      expect(out.status).toBe("FAILED");
      expect(out.perCriterion).toEqual({ "AC-1": "ASSERTION_FAILED" });
    } finally {
      await new Promise((r) => other.close(r));
    }
  });

  it("the navigation guard keeps the rerun on the run's hosts: an off-domain page never loads, not even at the proxy (KI-029)", async () => {
    const test = generated({
      targetUrl: `${shop.url}/products/1`,
      flow: ["await page.goto(data.targetUrl);"],
      steps: [
        { id: "AC-1", body: 'await expect.soft(page.getByRole("button", { name: data.locators.loc1.name, exact: true }), message).toBeVisible();' },
        { id: "AC-2", body: "await page.goto(data.urls.url1);" },
      ],
      data: { urls: { url1: "http://evil.example/steal" }, locators: { loc1: { name: "Add to cart" } } },
    });
    const before = blocks.length;
    const out = await runGeneratedTest(input(test), deps());
    expect(out.status).toBe("FAILED");
    expect(out.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "ASSERTION_FAILED" });
    expect(out.errorText["AC-2"]).toMatch(/^The rerun was stopped from leaving the allowed website \(to evil\.example\)\..*ERR_BLOCKED_BY_CLIENT/s);
    // Stopped in the browser: the request never reached the egress proxy.
    expect(blocks.slice(before)).toEqual([]);
  });

  it("Chromium runs with its sandbox on; abort signal → the child (and its Chromium) is killed within 5 s; ERRORED; no orphan process survives", async () => {
    const test = cartTest(`${shop.url}/products/1`, { beforeAc3: ['await page.getByRole("button", { name: data.locators.loc5.name, exact: true }).click();'] });
    const controller = new AbortController();
    const running = runGeneratedTest(input(test, { signal: controller.signal }), { ...deps(), actionTimeoutMs: 60_000 });
    const tmp = path.join(workspaceDir({ baseDir: base }, "run_fixture"), "tmp");
    // Wait until Chromium is up (its profile dir lives in the workspace's tmp dir).
    const deadline = Date.now() + 20_000;
    while (!processesMentioning(tmp).some((l) => /chrom|headless_shell/i.test(l))) {
      if (Date.now() > deadline) throw new Error("Chromium did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
    // Chromium's own sandbox is on (Playwright adds --no-sandbox unless chromiumSandbox is true);
    // exploration's browser-launcher keeps it on too.
    const chromium = processesMentioning(tmp).filter((l) => /chrom|headless_shell/i.test(l));
    const abortedAt = Date.now();
    controller.abort(new Error("cancelled"));
    const out = await running;
    expect(chromium.length).toBeGreaterThan(0);
    for (const line of chromium) expect(line).not.toContain("--no-sandbox");
    expect(Date.now() - abortedAt).toBeLessThan(5_000);
    expect(out.status).toBe("ERRORED");
    expect(out.perCriterion).toEqual({ "AC-1": "NOT_REACHED", "AC-2": "NOT_REACHED", "AC-3": "NOT_REACHED" });
    expect(processesMentioning(workspaceDir({ baseDir: base }, "run_fixture"))).toEqual([]);
  });
});

describe("runner child process environment", () => {
  const saved: Record<string, string | undefined> = {};
  const planted = {
    DATABASE_URL: "postgresql://platform:platform@localhost:5432/platform",
    API_TOKEN: "worker-api-token-0123456789",
    SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    ANTHROPIC_API_KEY: "sk-ant-planted",
    GEMINI_API_KEY: "gm-planted",
    PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: "1",
    NODE_OPTIONS: "--require /nonexistent/evil.js",
    SECRET_OTHER_RUN: "belongs-to-another-run",
  };
  beforeEach(() => {
    for (const [k, v] of Object.entries(planted)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(planted)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("contains only this run's SECRET_* variables, PATH and Playwright's variables; no DATABASE_URL, API_TOKEN, SECRETS_ENCRYPTION_KEY", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "runner-env-")));
    try {
      const script = path.join(dir, "dump-env.cjs");
      writeFileSync(script, 'require("fs").writeFileSync(require("path").join(process.cwd(), "env.json"), JSON.stringify(process.env));');
      const result = await spawn({ cwd: dir, cliPath: script, args: [], env: { SECRET_PASSWORD: "pw-this-run" }, tmpDir: dir, signal: new AbortController().signal });
      expect(result).toEqual({ exitCode: 0, signal: null });
      const env = JSON.parse(readFileSync(path.join(dir, "env.json"), "utf8")) as Record<string, string>;
      for (const k of ["DATABASE_URL", "API_TOKEN", "SECRETS_ENCRYPTION_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK", "NODE_OPTIONS", "SECRET_OTHER_RUN", "HOME"]) {
        expect(env[k], k).toBeUndefined();
      }
      expect(env.SECRET_PASSWORD).toBe("pw-this-run");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.TMPDIR).toBe(dir);
      // macOS sets __CF_USER_TEXT_ENCODING on every process it launches; nothing else may come from the worker.
      const allowed = new Set(["PATH", "TMPDIR", "SECRET_PASSWORD", "PLAYWRIGHT_BROWSERS_PATH", "__CF_USER_TEXT_ENCODING"]);
      const fromWorker = Object.keys(env).filter((k) => !allowed.has(k) && process.env[k] !== undefined && process.env[k] === env[k]);
      expect(fromWorker).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runnerEnv refuses anything but SECRET_<NAME> from the runner", () => {
    expect(() => runnerEnv({ DATABASE_URL: "x" }, "/tmp")).toThrow(/SECRET_/);
    expect(() => runnerEnv({ SECRET_lower: "x" }, "/tmp")).toThrow(/SECRET_/);
    expect(runnerEnv({ SECRET_A: "1" }, "/w/tmp")).toMatchObject({ SECRET_A: "1", TMPDIR: "/w/tmp", PATH: process.env.PATH });
  });
});

describe("the runner as its own service (KI-029)", () => {
  const TOKEN = "runner-token-for-tests-0123";
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  let runner: RunnerServer;
  beforeEach(async () => {
    runner = await startRunnerServer({ host: "127.0.0.1", port: 0, token: TOKEN, workspaceDir: base, logger: quiet });
  });
  afterEach(async () => {
    await runner.close();
  });

  /** A proxy reachable only from the runner's address, and the runner's loopback forwarder to it. */
  async function forwardedProxy(allowedClients = ["127.0.0.1"]) {
    const own = await startEgressProxy({
      resolve: defaultResolver,
      privateAllowlist: [`127.0.0.1:${shop.port}`],
      onBlock: (e) => blocks.push(e),
      listen: { host: "127.0.0.1", allowedClients },
    });
    const forward = await openRunnerForward({ url: runner.url, token: TOKEN }, own.port);
    return {
      url: `http://127.0.0.1:${forward.port}`,
      async close() {
        await forward.close();
        await own.close();
      },
    };
  }

  it("reruns in the runner: the workspace on the shared dir, the browser through the forwarder and the worker's proxy → PASSED", async () => {
    const forwarded = await forwardedProxy();
    try {
      const out = await runGeneratedTest(input(cartTest(`${shop.url}/products/1`), { proxyUrl: forwarded.url }), {
        ...deps(),
        spawn: createRemoteRunnerSpawn({ url: runner.url, token: TOKEN }),
      });
      expect(out.status).toBe("PASSED");
      expect(out.perCriterion).toEqual({ "AC-1": "PASSED", "AC-2": "PASSED", "AC-3": "PASSED" });
    } finally {
      await forwarded.close();
    }
  });

  it("the worker's proxy drops every client but the runner", async () => {
    const forwarded = await forwardedProxy(["10.99.99.99"]);
    try {
      const out = await runGeneratedTest(input(cartTest(`${shop.url}/products/1`), { proxyUrl: forwarded.url }), {
        ...deps(),
        spawn: createRemoteRunnerSpawn({ url: runner.url, token: TOKEN }),
      });
      expect(out.status).not.toBe("PASSED");
    } finally {
      await forwarded.close();
    }
  });

  it("refuses a request without the token, and any spawn but a rerun workspace's own CLI", async () => {
    const post = (pathname: string, body: object, token?: string) =>
      fetch(new URL(pathname, runner.url), {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    const cwd = path.join(base, "run_1");
    const ok = { cwd, cliPath: path.join(cwd, "node_modules", "@playwright", "test", "cli.js"), args: ["test", "--config", "playwright.config.js"], env: {}, tmpDir: path.join(cwd, "tmp") };
    expect((await post("/spawn", ok)).status).toBe(401);
    expect((await post("/spawn", ok, "wrong-token-of-the-same-len")).status).toBe(401);
    expect(checkSpawnRequest(ok, base)).toMatchObject({ cwd });
    for (const bad of [
      { ...ok, cwd: "/etc" },
      { ...ok, cwd: path.join(base, "run_1", "..", "..") },
      { ...ok, cliPath: "/usr/bin/env" },
      { ...ok, args: ["test", "--config", "/tmp/evil.js"] },
      { ...ok, tmpDir: "/tmp" },
      { ...ok, env: { SECRET_X: 1 } },
    ]) {
      const res = await post("/spawn", bad, TOKEN);
      expect(res.status).toBe(400);
    }
    expect((await post("/forwards", { proxyPort: 0 }, TOKEN)).status).toBe(400);
  });

  it("an abort closes the spawn request: the runner kills the rerun; ERRORED; no process survives", async () => {
    const forwarded = await forwardedProxy();
    try {
      const test = cartTest(`${shop.url}/products/1`, { beforeAc3: ['await page.getByRole("button", { name: data.locators.loc5.name, exact: true }).click();'] });
      const controller = new AbortController();
      const running = runGeneratedTest(input(test, { proxyUrl: forwarded.url, signal: controller.signal }), {
        ...deps(),
        actionTimeoutMs: 60_000,
        spawn: createRemoteRunnerSpawn({ url: runner.url, token: TOKEN }),
      });
      const tmp = path.join(workspaceDir({ baseDir: base }, "run_fixture"), "tmp");
      const deadline = Date.now() + 20_000;
      while (!processesMentioning(tmp).some((l) => /chrom|headless_shell/i.test(l))) {
        if (Date.now() > deadline) throw new Error("Chromium did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
      controller.abort(new Error("cancelled"));
      const out = await running;
      expect(out.status).toBe("ERRORED");
      const gone = Date.now() + 10_000;
      while (processesMentioning(workspaceDir({ baseDir: base }, "run_fixture")).length > 0 && Date.now() < gone) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(processesMentioning(workspaceDir({ baseDir: base }, "run_fixture"))).toEqual([]);
    } finally {
      await forwarded.close();
    }
  });
});
