import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { startDemoShop, type RunningDemoShop } from "@platform/demo-shop";
import { LlmClient, LlmTransportError, type LlmCallRecord, type LlmTransport } from "@platform/llm";
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  NavigationBlockedError,
  resolveStagehandExtensionDir,
  StagehandExplorer,
  STAGEHAND_TELEMETRY_HOST,
  type ExplorerSession,
  type LlmStepUsage,
} from "@platform/stagehand-adapter";
import { captureFact, fillElement, recordElement, type EventDraft, type StageContext } from "@platform/testing-engine";
import { chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { computeExtensionId, launchSandboxedBrowser } from "../../apps/worker/src/sandbox/browser-launcher";
import { createEgressEventReporter } from "../../apps/worker/src/sandbox/egress-events";
import { isBackgroundServiceHost, startEgressProxy, STAGEHAND_TELEMETRY_SINK_HOST, type EgressBlockEvent } from "../../apps/worker/src/sandbox/egress-proxy";
import { openRunSandbox, type RunSandbox } from "../../apps/worker/src/sandbox/run-sandbox";
import { ScriptedTransport, type ScriptTarget } from "./support/scripted-llm";

/**
 * Stagehand v4 through the real browser sandbox (Task 13) against the in-process demo shop, with a
 * scripted model: a transport under the real LlmClient that reads Stagehand's serialized
 * accessibility tree and picks element ids. No network, no API key.
 */

type Resolver = (hostname: string) => Promise<string[]>;

const RUN_ID = "run_stagehand_it";
const SECRET = "Sup3r-Secret-Value!";
const MODEL = "claude-sonnet-5";

// ---------------------------------------------------------------------------------------------
// Scripted model (shared helper: ./support/scripted-llm)
// ---------------------------------------------------------------------------------------------

/** Matched against the whole prompt, so each `when` is a phrase only our instructions contain. */
const TARGETS: ScriptTarget[] = [
  { when: "the add to cart button", role: "button", name: "Add to cart", method: "click" },
  { when: "the cart badge", role: "status", name: "Cart items", method: "click" },
  { when: "the search box", role: "searchbox", name: "", method: "fill" },
  { when: "the get file link", role: "link", name: "Get file", method: "click" },
  { when: "the visit example.org link", role: "link", name: "Visit example.org", method: "click" },
];

// ---------------------------------------------------------------------------------------------
// Fixtures and sandbox helpers
// ---------------------------------------------------------------------------------------------

interface Fixture {
  port: number;
  close(): Promise<void>;
}

/** Download fixture, reached as static.shop.test (an allowed subdomain of the target). */
async function startFixtureServer(): Promise<Fixture> {
  const server = http.createServer((req, res) => {
    if (req.url === "/download") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="report.bin"' });
      res.end("SANDBOX-DOWNLOAD-PAYLOAD");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>Files</title></head><body><a id="dl" href="/download">Get file</a></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function fakeResolver(table: Record<string, string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (host: string) => {
    calls.push(host);
    const hit = table[host];
    if (!hit) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return hit;
  }) as Resolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const CHROMIUM_EXE = chromium.executablePath();
const CHROMIUM_ROOT = CHROMIUM_EXE.includes(".app/") ? CHROMIUM_EXE.slice(0, CHROMIUM_EXE.indexOf(".app/") + 5) : path.dirname(CHROMIUM_EXE);

function leftovers(): { processes: string[]; profiles: string[] } {
  const out = execFileSync("ps", ["-ax", "-ww", "-o", "pid=,command="], { encoding: "utf8" });
  const processes = out.split("\n").filter((l) => {
    const command = l.trim().replace(/^\d+\s+/, "");
    return command.startsWith(CHROMIUM_ROOT) && command.includes(`platform-sandbox-${RUN_ID}`);
  });
  const profiles = readdirSync(realpathSync(os.tmpdir())).filter((n) => n.startsWith(`platform-sandbox-${RUN_ID}`));
  return { processes, profiles };
}

const silent = { info() {}, warn() {}, error() {} };

/** Replaces the secret by value, like the run redactor (D7). */
const redact = (v: unknown): unknown => JSON.parse(JSON.stringify(v).split(SECRET).join("[REDACTED]"));

// ---------------------------------------------------------------------------------------------

describe("Stagehand explorer adapter through the browser sandbox (real Chromium, demo shop)", () => {
  let shop: RunningDemoShop;
  let fixture: Fixture;
  let target: string;
  let extension: { dir: string; id: string };
  let cleanups: (() => Promise<void> | void)[] = [];
  let events: EventDraft[] = [];

  beforeAll(async () => {
    shop = await startDemoShop({ port: 0, host: "127.0.0.1" });
    fixture = await startFixtureServer();
    target = `http://shop.test:${shop.port}/`;
    const dir = resolveStagehandExtensionDir();
    extension = { dir, id: computeExtensionId(dir) };
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
    events = [];
  });

  afterAll(async () => {
    await shop?.close();
    await fixture?.close();
    // No Playwright Chromium process or profile of this run survives the suite.
    let left = leftovers();
    for (let i = 0; i < 50 && (left.processes.length > 0 || left.profiles.length > 0); i++) {
      await new Promise((r) => setTimeout(r, 200));
      left = leftovers();
    }
    expect(left).toEqual({ processes: [], profiles: [] });
  });

  function llmClient() {
    const transport = new ScriptedTransport(TARGETS);
    const records: LlmCallRecord[] = [];
    const llm = new LlmClient({ transport, model: MODEL, recordCall: (c) => void records.push(c), logger: silent, retry: { maxRetries: 0 } });
    return { transport, records, llm };
  }

  async function openSandbox(): Promise<{ sandbox: RunSandbox; resolver: Resolver & { calls: string[] } }> {
    const resolver = fakeResolver({ "shop.test": ["127.0.0.1"], "static.shop.test": ["127.0.0.1"] });
    const ctx = {
      runId: RUN_ID,
      tenantId: "tenant_default",
      request: { targetUrl: target, options: { additionalAllowedHosts: [] } },
      signal: new AbortController().signal,
      publish: async (e: EventDraft) => void events.push(e),
      addCleanup: (fn: () => Promise<void> | void) => void cleanups.push(fn),
    } as unknown as StageContext;
    const sandbox = await openRunSandbox(ctx, {
      resolve: resolver,
      privateAllowlist: [`shop.test:${shop.port}`, `static.shop.test:${fixture.port}`],
      logger: silent,
      extensions: [extension],
    });
    return { sandbox, resolver };
  }

  async function startSession(sandbox: RunSandbox, llm: LlmClient): Promise<ExplorerSession> {
    const session = await new StagehandExplorer({ llm, connectTimeoutMs: 90_000 }).start({
      page: sandbox,
      runId: RUN_ID,
      signal: new AbortController().signal,
      redact,
      allowDestructive: false,
    });
    cleanups.push(() => session.close());
    return session;
  }

  const egress = () => events.filter((e) => e.type === "egress.blocked").map((e) => e.payload as { host: string; reason: string });
  const expectUsage = (llm: LlmStepUsage | null) => {
    expect(llm).toMatchObject({ model: MODEL, cacheHit: null });
    expect(llm!.inputTokens).toBeGreaterThan(0);
    expect(llm!.outputTokens).toBeGreaterThan(0);
  };

  it(
    "navigates, observes and acts on 'Add to cart', reads the cart badge as DOM_VERIFIED 1, and records model usage",
    async () => {
      // Stagehand's own logging is off: nothing (unredacted) reaches stderr from it.
      const stderr: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        stderr.push(String(chunk));
        return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stderr.write;
      cleanups.push(() => {
        process.stderr.write = write;
      });

      const { sandbox } = await openSandbox();
      const { transport, records, llm } = llmClient();
      const session = await startSession(sandbox, llm);
      expect(session.page).toBe(sandbox.page);

      expect(await session.navigate(`${target}products/1`)).toEqual({ url: `${target}products/1` });

      const observed = await session.observe("find the add to cart button");
      expect(observed.elements).toHaveLength(1);
      const button = observed.elements[0]!;
      expect(button.selector).toMatch(/^xpath=\/html\[1\]\/body\[1\]\//);
      expectUsage(observed.llm);
      const buttonRef = await recordElement(session.page, button.selector);
      expect(buttonRef.candidates[buttonRef.chosenIndex]).toEqual({ strategy: "role", role: "button", name: "Add to cart", exact: true });

      const acted = await session.act("click the add to cart button");
      expect(acted).toMatchObject({ success: true, navigationBlocks: [] });
      expect(acted.element?.selector).toBe(button.selector);
      expectUsage(acted.llm);
      await session.page.waitForLoadState("load");
      await expect.poll(() => session.page.getByTestId("cart-count").textContent()).toBe("Cart (1)");

      const extracted = await session.extract("the cart badge count", z.object({ cartCount: z.number() }));
      expect(extracted.data).toEqual({ cartCount: 1 });
      expectUsage(extracted.llm);

      const badge = (await session.observe("find the cart badge")).elements[0]!;
      const element = await recordElement(session.page, badge.selector);
      const fact = await captureFact(session.page, {
        key: "cartCount",
        checkpoint: "after_add",
        stepId: "step-4",
        modelValue: extracted.data.cartCount,
        element,
        mode: "number",
      });
      expect(fact).toMatchObject({ value: 1, provenance: "DOM_VERIFIED", read: { mode: "number" } });

      // Every model call went through @platform/llm, attributed to the run and the EXPLORING stage.
      expect(records.length).toBe(transport.requests.length);
      expect(records.length).toBeGreaterThanOrEqual(4);
      expect(records.every((r) => r.runId === RUN_ID && r.stage === "EXPLORING" && r.model === MODEL && r.status === "SUCCESS")).toBe(true);
      expect(new Set(transport.requests.map((r) => r.schemaName))).toEqual(new Set(["Observation", "Act", "Extraction", "Metadata"]));
      const stepTotals = [observed.llm, acted.llm, extracted.llm].reduce((n, u) => n + u!.inputTokens, 0);
      expect(stepTotals).toBeLessThanOrEqual(records.reduce((n, r) => n + r.inputTokens, 0));

      // Replaying an observed element is deterministic: zero model calls.
      const before = transport.requests.length;
      const replay = await session.actOn(button);
      expect(replay).toMatchObject({ success: true, llm: null });
      expect(transport.requests.length).toBe(before);
      await session.page.waitForLoadState("load");
      await expect.poll(() => session.page.getByTestId("cart-count").textContent()).toBe("Cart (2)");

      const shot = await session.screenshot();
      expect(shot.subarray(1, 4).toString("latin1")).toBe("PNG");
      expect(stderr.filter((l) => /stagehand|"level"/i.test(l))).toEqual([]);
    },
    120_000,
  );

  it(
    "our code fills fields found by observe; the value never reaches the model",
    async () => {
      const { sandbox } = await openSandbox();
      const { transport, llm } = llmClient();
      const session = await startSession(sandbox, llm);
      await session.navigate(target);

      const search = (await session.observe("find the search box")).elements[0]!;
      expect(search.method).toBe("fill");
      await fillElement(session.page, search.selector, SECRET);
      expect(await session.page.getByTestId("search-input").inputValue()).toBe(SECRET);

      // The field now shows the secret; a later snapshot is redacted before it reaches the provider.
      await session.observe("find the search box");
      expect(JSON.stringify(transport.requests)).not.toContain(SECRET);
    },
    120_000,
  );

  it(
    "security (a): the Stagehand runtime cannot change proxy settings and all traffic still goes through the egress proxy",
    async () => {
      const manifest = JSON.parse(readFileSync(path.join(extension.dir, "manifest.json"), "utf8")) as { permissions?: string[] };
      expect(manifest.permissions ?? []).not.toContain("proxy");

      const { sandbox, resolver } = await openSandbox();
      const { llm } = llmClient();
      const session = await startSession(sandbox, llm);
      await session.navigate(`${target}products/1`);
      await session.act("click the add to cart button");

      // chrome.proxy is not available to the extension (its settings would outrank --proxy-server).
      const context = session.page.context();
      const worker = context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extension.id}/`));
      expect(worker).toBeDefined();
      expect(await worker!.evaluate(() => typeof (globalThis as { chrome?: { proxy?: unknown } }).chrome?.proxy)).toBe("undefined");

      // shop.test only resolves at the proxy (Chromium resolves nothing itself): navigation still works…
      expect(resolver.calls).toContain("shop.test");
      // …and the proxy still vets page and extension traffic after Stagehand connected.
      const direct = `http://127.0.0.1:${shop.port}/healthz`;
      await session.page.evaluate((u) => fetch(u, { mode: "no-cors" }).catch(() => null), direct);
      await expect.poll(egress).toContainEqual({ host: "127.0.0.1", reason: "NON_PUBLIC_ADDRESS" });
      const blockedBefore = egress().length;
      // The extension's own requests too: the proxy answers 403 for a private address.
      expect(await worker!.evaluate((u) => fetch(u).then((r) => r.status, () => "network error"), `http://10.0.0.7/`)).toBe(403);
      await expect.poll(() => egress().length).toBeGreaterThan(blockedBefore);
      expect(egress()).toContainEqual({ host: "10.0.0.7", reason: "NON_PUBLIC_ADDRESS" });
    },
    120_000,
  );

  it(
    "security (b): after Stagehand connects, downloads are still denied",
    async () => {
      const { sandbox } = await openSandbox();
      const { llm } = llmClient();
      const session = await startSession(sandbox, llm);
      await session.navigate(`http://static.shop.test:${fixture.port}/`);
      const download = session.page.waitForEvent("download");
      const acted = await session.act("click the get file link");
      expect(acted.success).toBe(true);
      expect(await (await download).failure()).toBe("canceled");
    },
    120_000,
  );

  it(
    "security (c): a blocked main-frame navigation surfaces as NavigationBlockedError and the session stays usable",
    async () => {
      const { sandbox } = await openSandbox();
      const { llm } = llmClient();
      const session = await startSession(sandbox, llm);

      const started = Date.now();
      const offDomain = await session.navigate("https://example.org/").catch((e: unknown) => e);
      expect(offDomain).toBeInstanceOf(NavigationBlockedError);
      expect(offDomain).toMatchObject({ url: "https://example.org/", reason: "OFF_DOMAIN_NAVIGATION" });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(session.page.url()).not.toContain("example.org");

      const viaRedirect = await session.navigate(`${target}redirect?to=http://10.0.0.1/`).catch((e: unknown) => e);
      expect(viaRedirect).toMatchObject({ name: "NavigationBlockedError", url: "http://10.0.0.1/", reason: "TARGET_BLOCKED_BY_POLICY" });

      // Still usable: navigate, observe, act.
      await session.navigate(`${target}products/1`);
      const acted = await session.act("click the add to cart button");
      expect(acted.success).toBe(true);
      await session.page.waitForLoadState("load");
      await expect.poll(() => session.page.getByTestId("cart-count").textContent()).toBe("Cart (1)");

      // A click that leads off-domain reports the block on the act result.
      await session.navigate(`${target}external`);
      const external = await session.act("click the visit example.org link");
      expect(external.navigationBlocks).toEqual([{ url: "https://example.org/", reason: "OFF_DOMAIN_NAVIGATION" }]);
      await session.navigate(target);
      expect(session.page.url()).toBe(target);
    },
    120_000,
  );

  it(
    "Stagehand's telemetry export goes to the reserved host and is denied silently (no egress.blocked event)",
    async () => {
      expect(new URL(DEFAULT_TELEMETRY_ENDPOINT).hostname).toBe(STAGEHAND_TELEMETRY_SINK_HOST);
      expect(STAGEHAND_TELEMETRY_HOST).toBe(STAGEHAND_TELEMETRY_SINK_HOST);
      expect(isBackgroundServiceHost(STAGEHAND_TELEMETRY_HOST)).toBe(true);

      // Composed by hand so the proxy's raw decisions are visible next to the published events.
      const resolver = fakeResolver({ "shop.test": ["127.0.0.1"] });
      const cdpPort = await import("../../apps/worker/src/sandbox/browser-launcher").then((m) => m.findFreePort());
      const raw: EgressBlockEvent[] = [];
      const published: EventDraft[] = [];
      const report = createEgressEventReporter({ publish: async (e) => void published.push(e), logger: silent });
      const proxy = await startEgressProxy({
        resolve: resolver,
        privateAllowlist: [`shop.test:${shop.port}`, `127.0.0.1:${cdpPort}`],
        onBlock: (e) => {
          raw.push(e);
          report(e);
        },
      });
      cleanups.push(() => proxy.close());
      const browser = await launchSandboxedBrowser({ proxyUrl: proxy.url, runId: RUN_ID, cdpPort, extensions: [extension] });
      cleanups.push(() => browser.close());

      const { llm } = llmClient();
      const session = await new StagehandExplorer({ llm, connectTimeoutMs: 90_000 }).start({ page: browser, runId: RUN_ID, signal: new AbortController().signal, redact, allowDestructive: false });
      await session.navigate(`${target}products/1`);
      await session.observe("find the add to cart button");
      await session.close(); // flushes the trace exporter

      await expect
        .poll(() => raw.filter((e) => e.host === STAGEHAND_TELEMETRY_HOST), { timeout: 15_000 })
        .toContainEqual({ host: STAGEHAND_TELEMETRY_HOST, port: 443, reason: "BACKGROUND_SERVICE_DENIED" });
      expect(published.filter((e) => JSON.stringify(e).includes("telemetry") || JSON.stringify(e).includes("example.com"))).toEqual([]);
      expect(raw.some((e) => e.host === "example.com")).toBe(false);
      expect(resolver.calls).not.toContain(STAGEHAND_TELEMETRY_HOST);
      expect(resolver.calls).not.toContain("example.com");
    },
    120_000,
  );

  it(
    "a step that gives up on a stalled model call does not hold up the next step's call: the stalled call is aborted (KI-020)",
    async () => {
      const scripted = new ScriptedTransport(TARGETS);
      let stalled = 0;
      let stalledAborted = false;
      // The first observation is never answered (a provider stall with no timeout of its own).
      const transport: LlmTransport = {
        provider: "scripted",
        complete(req) {
          if (req.schemaName !== "Observation" || stalled++ > 0) return scripted.complete(req);
          return new Promise((_, reject) => {
            req.signal.addEventListener(
              "abort",
              () => {
                stalledAborted = true;
                reject(new LlmTransportError("aborted", { retryable: false }));
              },
              { once: true },
            );
          });
        },
      };
      const llm = new LlmClient({ transport, model: MODEL, logger: silent, retry: { maxRetries: 0 } });
      const { sandbox } = await openSandbox();
      const session = await new StagehandExplorer({ llm, connectTimeoutMs: 90_000, operationTimeoutMs: 2_000 }).start({
        page: sandbox,
        runId: RUN_ID,
        signal: new AbortController().signal,
        redact,
        allowDestructive: false,
      });
      cleanups.push(() => session.close());
      await session.navigate(`${target}products/1`);

      // Stagehand gives up on its own timeout (it never cancels the call in flight)...
      await expect(session.observe("find the add to cart button")).rejects.toThrow();
      expect(stalledAborted).toBe(true);
      // ...and the next step's call is answered, not queued behind the stalled one.
      const next = await session.observe("find the add to cart button");
      expect(next.elements[0]).toMatchObject({ method: "click" });
    },
    120_000,
  );
});
