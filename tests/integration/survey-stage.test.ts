import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserProviderError, type StoredTestRunRequest, type Suggestion } from "@platform/contracts";
import { startDemoShop, type RunningDemoShop } from "@platform/demo-shop";
import { LlmClient, type LlmTransport, type LlmTransportRequest, type LlmTransportResponse } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { createSurveyStage, type EventDraft, type StageContext } from "@platform/testing-engine";
import { chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBrowserUseDiscoveryClient, createDiscoveryServiceClient } from "../../apps/worker/src/discovery-client";
import { openRunSandbox } from "../../apps/worker/src/sandbox/run-sandbox";
import { withAutonomousDiscovery } from "../../packages/testing-engine/src/survey/autonomous-survey";
import { DISCOVERY_CORPUS } from "../../evals/discovery/corpus";
import { benchmarkProvenance, discoveryModelOf } from "../../evals/discovery/provenance";
import { prepareReview } from "../../evals/discovery/ratings";

/**
 * The survey against real Chromium (spec "Testing"): the worker's sandbox — egress proxy, Chromium
 * WITHOUT the Stagehand extension, navigation guard — on the in-process demo shop reached as
 * `shop.test`, the in-page inventory script (transpiled with keepNames, as the worker runs), and the
 * real LlmClient over a transport that stops the exploration at once and answers the `test_suggestions` call. No API key.
 */

const silent = { info() {}, warn() {}, error() {} };
const SECRET = "hunter2-Survey-Secret";
const discoveryLauncher = process.env.BROWSER_USE_DISCOVERY_LAUNCHER;
const discoveryFixture = process.env.BROWSER_USE_DISCOVERY_FIXTURE_URL;
const discoveryServiceUrl = process.env.BROWSER_USE_DISCOVERY_SERVICE_URL;
const discoveryService = discoveryServiceUrl && process.env.BROWSER_USE_DISCOVERY_SERVICE_TOKEN
  ? createDiscoveryServiceClient(discoveryServiceUrl, process.env.BROWSER_USE_DISCOVERY_SERVICE_TOKEN)
  : undefined;
const benchmarkEnabled = process.env.BROWSER_USE_BENCHMARK === "1";
/**
 * Optional: an operator's discovery.env (DISCOVERY_MODEL and its provider key) for a hosted-model evaluation run.
 * The harness sources it inside the launcher's config and reads only DISCOVERY_MODEL itself. Unset: scripted models.
 */
const hostedEnvFile = process.env.BROWSER_USE_BENCHMARK_ENV_FILE;
const hostedModel = benchmarkEnabled && hostedEnvFile ? discoveryModelOf(hostedEnvFile) : null;
if (benchmarkEnabled && hostedEnvFile && (!hostedModel || !/^[a-z\d-]+:[\w./:-]+$/i.test(hostedModel) ||
    /^(scripted|test|function):/i.test(hostedModel))) {
  throw new Error("The hosted benchmark config requires a hosted DISCOVERY_MODEL in provider:model form");
}
const benchmarkImage = "vtp-browser-use-discovery:1.0.6";
const benchmarkOrigin = "http://127.0.0.1:4599";
type BenchmarkFixture = typeof DISCOVERY_CORPUS[number];

function benchmarkIdeas(fixture: BenchmarkFixture, req: LlmTransportRequest) {
  const prompt = JSON.stringify(req.messages);
  const inventory = /<<<PAGES([\s\S]*?)PAGES>>>/.exec(prompt)?.[1] ?? "";
  const visible = fixture.oracles.filter((oracle) =>
    oracle.inventory.test(inventory) && (oracle.paths ?? []).every((p) => inventory.includes(p)),
  );
  const tests = visible.map(({ id, requirement }) => [id.replaceAll("-", " "), requirement]);
  const generic = [
    ["Identify the start page", "Check that the start page has a visible main heading identifying the site."],
    ["Check the page title", "Check that the browser tab contains a descriptive title for this fixture."],
    ["Check the main content", "Verify that the fixture has a main content region for the page."],
  ];
  return [...tests, ...generic.slice(0, Math.max(0, 3 - tests.length))].map(([title, requirement]) => ({
    title, requirement, why: "The survey inventory includes this feature.",
    needs: { secrets: [], testData: [] }, destructive: false,
  }));
}

/**
 * One matcher for every suggestion, whatever produced it: the rubric check's pattern over the suggestion's title
 * and requirement. Neither source gets a stricter or looser test than the other.
 */
function matchedOracles(fixture: BenchmarkFixture, suggestions: Suggestion[]) {
  return fixture.oracles
    .filter((oracle) => suggestions.some((item) => oracle.proposal.test(`${item.title}\n${item.requirement}`)))
    .map((oracle) => oracle.id);
}

/** Ends the exploration on its first choice, answers the survey's call with three suggestions, and keeps what it was sent. */
class SuggestionTransport implements LlmTransport {
  readonly provider = "scripted";
  readonly requests: LlmTransportRequest[] = [];
  constructor(private readonly fixture?: BenchmarkFixture) {}

  async complete(req: LlmTransportRequest): Promise<LlmTransportResponse> {
    this.requests.push(req);
    if (req.schemaName === "site_exploration_action") {
      const stop = { observation: "Everything needed is on screen.", missing: "", candidate: -1, source: "generated", key: "" };
      return { text: JSON.stringify(stop), model: req.model, usage: { inputTokens: 100, outputTokens: 20 } };
    }
    if (req.schemaName !== "test_suggestions") throw new Error(`unexpected model call ${req.schemaName}`);
    const suggestions = this.fixture ? benchmarkIdeas(this.fixture, req) : [
      ["Add a product to the cart", "A visitor can add iPhone 17 Pro to the cart and sees the cart count go up."],
      ["Search the catalog", "Searching for Pixel on the products page lists only products whose names contain Pixel."],
      ["Sign in", "A user can sign in on the login page and sees their account page."],
    ].map(([title, requirement], i) => ({
      title,
      requirement,
      why: "The site map links to it.",
      needs: { secrets: i === 2 ? ["password"] : [], testData: [] },
      destructive: false,
    }));
    return { text: JSON.stringify({ suggestions }), model: req.model, usage: { inputTokens: 1000, outputTokens: 200 } };
  }
}

const CHROMIUM_EXE = chromium.executablePath();
const CHROMIUM_ROOT = CHROMIUM_EXE.includes(".app/") ? CHROMIUM_EXE.slice(0, CHROMIUM_EXE.indexOf(".app/") + 5) : path.dirname(CHROMIUM_EXE);

/** Chromium processes and sandbox profiles of these runs still around (none once a survey has returned). */
function leftovers(runIds: string[]): { processes: string[]; profiles: string[] } {
  const out = execFileSync("ps", ["-ax", "-ww", "-o", "pid=,command="], { encoding: "utf8" });
  const mine = (s: string) => runIds.some((id) => s.includes(`platform-sandbox-${id}`));
  const processes = out.split("\n").filter((l) => {
    const command = l.trim().replace(/^\d+\s+/, "");
    return command.startsWith(CHROMIUM_ROOT) && mine(command);
  });
  const profiles = readdirSync(realpathSync(os.tmpdir())).filter(mine);
  return { processes, profiles };
}

describe("the survey through the real sandbox (demo shop, scripted model)", () => {
  let shop: RunningDemoShop;
  const runIds: string[] = [];
  const cleanups: (() => Promise<void> | void)[] = [];

  beforeAll(async () => {
    shop = await startDemoShop({ port: 0, host: "127.0.0.1", testEndpoints: true });
  }, 60_000);

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  afterAll(async () => {
    await shop?.close();
    let left = leftovers(runIds);
    for (let i = 0; i < 50 && (left.processes.length > 0 || left.profiles.length > 0); i++) {
      await new Promise((r) => setTimeout(r, 200));
      left = leftovers(runIds);
    }
    expect(left).toEqual({ processes: [], profiles: [] });
  }, 60_000);

  const lastSeq = () => shop.server.demoShop.requests.at(-1)?.seq ?? 0;
  const requestsSince = (seq: number) => shop.server.demoShop.requests.filter((r) => r.seq > seq);

  function setup(targetPath: string, targetUrl = `http://shop.test:${shop.port}${targetPath}`, transport = new SuggestionTransport()) {
    const runId = `run_survey_${runIds.length + 1}_${Date.now().toString(36)}`;
    runIds.push(runId);
    const request: StoredTestRunRequest = {
      targetUrl,
      requirement: "",
      environment: "staging",
      browser: "chromium",
      testData: {},
      secretNames: ["password"],
      options: {
        maxExplorationSteps: 40,
        maxRunSeconds: 300,
        generatePlaywright: true,
        rerunGeneratedTest: true,
        autoConfirmCriteria: false,
        allowDestructiveActions: false,
        additionalAllowedHosts: [],
      },
    };
    const events: EventDraft[] = [];
    const shots: Buffer[] = [];
    const controller = new AbortController();
    const redact = createRunRedactor([SECRET]);
    const ctx: StageContext = {
      runId,
      tenantId: "t_default",
      request,
      signal: controller.signal,
      deadlineAt: new Date(Date.now() + 180_000),
      budgets: { explorationMs: 108_000, rerunMs: 45_000 },
      secrets: { names: ["password"], get: (n) => (n === "password" ? SECRET : undefined) },
      redact,
      publish: async (e) => void events.push(redact(e) as EventDraft),
      addCleanup: (fn) => void cleanups.push(fn),
      boundary: async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
      },
      budgetSignal: (ms) => AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]),
      now: () => new Date(),
      llm: new LlmClient({ transport, model: "claude-sonnet-5", logger: silent, retry: { maxRetries: 0 } }),
    };
    const fixture = new URL(targetUrl);
    const resolver = async (host: string) => {
      if (host === fixture.hostname) return ["127.0.0.1"];
      throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    };
    const survey = createSurveyStage({
      openSandbox: (c) => openRunSandbox(c, { resolve: resolver, privateAllowlist: [fixture.host], logger: silent }),
      store: () => ({
        saveScreenshot: async ({ png }) => {
          shots.push(png);
          return { artifactId: `art_${shots.length}` };
        },
      }),
    });
    return { ctx, events, shots, transport, survey };
  }

  describe.runIf(benchmarkEnabled)("ten-site Browser Use fixture benchmark", () => {
    const rows: {
      fixture: string; baseline: string[]; enriched: string[]; discoveryOnly: string[];
      baselineMs: number; addedMs: number; returned: number; offered: number; oracleMatches: number;
      modelRequests: number; modelCostUsd: number | null; discoveryStatus: string; discoveryCompleted: boolean;
      peakMemoryBytes: number | null;
      playwrightOraclePassed: boolean;
    }[] = [];
    const app = path.resolve(import.meta.dirname, "../../apps/browser-use-discovery");

    const ideas: Parameters<typeof prepareReview>[0] = [];

    afterAll(() => {
      if (!benchmarkEnabled) return;
      const root = path.resolve(import.meta.dirname, "../..");
      const directory = path.join(root, ".artifacts/discovery-benchmark");
      const latency = rows.map((row) => row.addedMs).sort((a, b) => a - b);
      const totalBaseline = rows.reduce((sum, row) => sum + row.baseline.length, 0);
      const totalEnriched = rows.reduce((sum, row) => sum + row.enriched.length, 0);
      const totalOffered = rows.reduce((sum, row) => sum + row.offered, 0);
      const matched = rows.reduce((sum, row) => sum + row.oracleMatches, 0);
      const hosted = Boolean(hostedModel);
      const { review, sheet } = prepareReview(ideas);
      // A loopback-served model (local:...) is zero-cost and stays on this host; name its files apart from a provider's.
      const local = hostedModel?.startsWith("local:") ?? false;
      const suffix = !hosted ? "" : local ? `.local-${hostedModel!.slice(6).replace(/[^a-z0-9.-]+/gi, "-")}` : ".hosted";
      const report = {
        kind: hosted ? "hosted-model-fixture-evaluation" : "scripted-fixture-smoke",
        purpose: hosted
          ? "Hosted-model discovery on the disposable fixtures. Rate ideas from both paths in candidates-for-rating.hosted.json."
          : "Regression evidence that the standard survey, Browser Use enrichment, merge and fixture checks work end to end. "
            + "Both models are scripted, and the scripted Browser Use model derives its ideas from fixture DOM heuristics, "
            + "so rubric agreement here measures plumbing, not discovery usefulness.",
        provenance: benchmarkProvenance(root, benchmarkImage),
        modelMode: hosted ? `standard survey scripted; Browser Use ${hostedModel}` : "scripted on both paths",
        modelLocation: !hosted ? "scripted" : local ? "loopback (zero-cost, no provider)" : "provider",
        matcher: "symmetric: each rubric check's pattern over every suggestion's title and requirement, regardless of source",
        fixtures: rows.length,
        expectedFixtures: DISCOVERY_CORPUS.length,
        complete: rows.length === DISCOVERY_CORPUS.length && rows.every((row) => row.playwrightOraclePassed && row.discoveryCompleted),
        smoke: {
          rubricChecksMatchedByStandardSurvey: totalBaseline,
          rubricChecksMatchedAfterEnrichment: totalEnriched,
          browserUseIdeasOffered: totalOffered,
          browserUseIdeasMatchingARubricCheck: matched,
          fixtureChecksPassed: rows.filter((row) => row.playwrightOraclePassed).length,
          // Host-sampled peak of each job's agent container (limit 2 GiB); null when no sample landed.
          agentContainerPeakMemoryBytes: rows.reduce<number | null>((max, row) =>
            row.peakMemoryBytes === null ? max : Math.max(max ?? 0, row.peakMemoryBytes), null),
          addedLatencyMs: latency.length
            ? { p50: latency[Math.ceil(latency.length / 2) - 1], p95: latency[Math.ceil(latency.length * 0.95) - 1], max: latency.at(-1) }
            : null,
        },
        usefulness: {
          status: "not_measured",
          reason: "Requires hosted-model runs across the corpus and human ratings of the offered ideas (plan §12.3).",
          openGates: [
            "useful discovery rate (human-rated)",
            "new coverage yield from a hosted model",
            "selected-scenario execution and confirmed-test rates on unedited suggestions",
            "cost per useful candidate",
          ],
        },
        review,
        rows,
      };
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, `results${suffix}.json`), JSON.stringify(report, null, 2) + "\n");
      writeFileSync(path.join(directory, `candidates-for-rating${suffix}.json`), JSON.stringify(sheet, null, 2) + "\n");
    });

    it.each(DISCOVERY_CORPUS)("compares the standard and enriched surveys for $id", async (fixture) => {
      const url = new URL(fixture.path, benchmarkOrigin).href;
      const { ctx, survey, events } = setup(fixture.path, url, new SuggestionTransport(fixture));
      const start = performance.now();
      const baseline = await survey(ctx);
      const baselineMs = Math.round(performance.now() - start);

      const temp = mkdtempSync(path.join(os.tmpdir(), "discovery-benchmark-"));
      cleanups.push(() => rmSync(temp, { recursive: true, force: true }));
      const config = path.join(temp, "discovery.env");
      const script = path.join(temp, "launcher");
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      // Source provider credentials on the host. Fix the fixture, model and image to the values the report records.
      const providerConfig = hostedModel && hostedEnvFile ? `. ${quote(path.resolve(hostedEnvFile))}\n` : "";
      writeFileSync(config, `${providerConfig}DISCOVERY_FIXTURE_URL=${quote(url)}\n` +
        `DISCOVERY_MODEL=${quote(hostedModel ?? "scripted")}\nDISCOVERY_IMAGE=${quote(benchmarkImage)}\n`, { mode: 0o600 });
      writeFileSync(script, `#!/bin/sh\nBROWSER_USE_DISCOVERY_ENV=${quote(config)} exec ${quote(path.join(app, "bin/browser-use-discovery"))}\n`, { mode: 0o700 });

      ctx.request.options.autonomousDiscovery = true;
      const discoveryStart = performance.now();
      const enriched = await withAutonomousDiscovery(async () => baseline, {
        fixtureUrl: url, port: createBrowserUseDiscoveryClient(script),
      })(ctx);
      const addedMs = Math.round(performance.now() - discoveryStart);
      const summary = events.find((event) => event.type === "discovery.completed" || event.type === "discovery.failed");
      expect(summary, "every opted-in run records a discovery outcome").toBeDefined();
      // Scripted smoke must complete; a hosted model may legitimately fall back, and the row records it.
      if (!hostedModel) expect(summary?.type).toBe("discovery.completed");
      expect(enriched.suggestions.length).toBeLessThanOrEqual(8);
      expect(JSON.stringify(enriched.suggestions)).not.toContain("BENCHMARK_UNTRUSTED_COPY_ME");
      const baselineMatches = matchedOracles(fixture, baseline.suggestions);
      const enrichedMatches = matchedOracles(fixture, enriched.suggestions);
      const discoverySuggestions = enriched.suggestions.filter((idea) => idea.discovery);
      ideas.push(...baseline.suggestions.map(({ title, requirement }) => ({ fixture: fixture.id, title, requirement, source: "survey" as const })));
      ideas.push(...discoverySuggestions.map(({ title, requirement }) => ({ fixture: fixture.id, title, requirement, source: "discovery" as const })));

      // Check the corpus independently of either model or the Browser Use agent.
      const browser = await chromium.launch();
      let playwrightOraclePassed: boolean;
      try {
        const page = await browser.newPage();
        await page.route("**/*", (route) => new URL(route.request().url()).origin === benchmarkOrigin ? route.continue() : route.abort());
        await page.goto(url);
        playwrightOraclePassed = await fixture.verify(page);
      } finally {
        await browser.close();
      }
      rows.push({
        fixture: fixture.id, baseline: baselineMatches, enriched: enrichedMatches,
        discoveryOnly: enrichedMatches.filter((id) => !baselineMatches.includes(id)),
        baselineMs, addedMs, returned: summary!.payload.candidateCount, offered: discoverySuggestions.length,
        oracleMatches: discoverySuggestions.filter((idea) => matchedOracles(fixture, [idea]).length > 0).length,
        modelRequests: summary!.payload.statistics?.modelRequests ?? 0,
        modelCostUsd: summary!.payload.statistics?.modelCostUsd ?? null,
        discoveryStatus: summary!.payload.status,
        peakMemoryBytes: summary!.payload.statistics?.peakMemoryBytes ?? null,
        discoveryCompleted: summary!.type === "discovery.completed",
        playwrightOraclePassed,
      });
      expect(playwrightOraclePassed).toBe(true);
    }, 160_000);
  });

  // Opt in with the built discovery image, its launcher, and the host copy of the bundled fixture.
  it.runIf(Boolean((discoveryLauncher || discoveryService) && discoveryFixture))("merges isolated Browser Use candidates into the real survey", async () => {
    const fixtureUrl = new URL(discoveryFixture!).href;
    const { ctx, survey, events } = setup("/", fixtureUrl);
    const baseline = await survey(ctx);
    ctx.request.options.autonomousDiscovery = true;
    const enrich = withAutonomousDiscovery(survey, {
      fixtureUrl,
      port: discoveryService ?? createBrowserUseDiscoveryClient(discoveryLauncher!),
      logger: console,
    });
    const enriched = await enrich(ctx);
    expect(enriched.suggestions.slice(0, 2)).toEqual(baseline.suggestions.slice(0, 2));
    expect(enriched.suggestions.some(({ title }) => !baseline.suggestions.some((original) => original.title === title))).toBe(true);
    expect(enriched.suggestions.length).toBeLessThanOrEqual(8);
    expect(enriched.pages).toEqual(baseline.pages);
    expect(enriched.suggestions.some(({ discovery }) => discovery?.engine === "browser_use")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "discovery.started" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "discovery.completed", payload: expect.objectContaining({ fallbackUsed: false }) }));
  }, 180_000);

  it.runIf(Boolean(discoveryService && discoveryFixture))("falls back when rollout is disabled after signed broker progress", async () => {
    const fixtureUrl = new URL(discoveryFixture!).href;
    const { ctx, survey, events } = setup("/", fixtureUrl);
    const baseline = await survey(ctx);
    ctx.request.options.autonomousDiscovery = true;
    let enabled = true;
    const publish = ctx.publish;
    ctx.publish = async (event) => {
      await publish(event);
      // The signed broker has accepted this job and returned progress. Use that boundary to avoid a sleep race.
      if (event.type === "discovery.progress") enabled = false;
    };
    const result = await withAutonomousDiscovery(async () => baseline, {
      fixtureUrl, port: discoveryService!, allowsTenant: () => enabled,
    })(ctx);
    expect(result).toBe(baseline);
    expect(events).toContainEqual(expect.objectContaining({ type: "discovery.progress" }));
    expect(events.filter(({ type }) => type === "discovery.completed" || type === "discovery.failed")).toEqual([
      expect.objectContaining({ type: "discovery.failed", payload: expect.objectContaining({
        status: "CANCELLED", reason: "tenant_disabled", attempted: true, acceptedCount: 0, fallbackUsed: true,
      }) }),
    ]);
    await expect.poll(async () => (await fetch(`${discoveryServiceUrl}/internal/health`)).json(), { timeout: 20_000 })
      .toMatchObject({ status: "ready", activeJobs: 0, cleanupFailures: 0 });
  }, 180_000);

  it(
    "reads /sitemap and 5 same-site links by URL — never a destructive, sign-out, download or off-site one; the off-host redirect is SKIPPED; nothing is clicked",
    async () => {
      const { ctx, events, shots, transport, survey } = setup("/sitemap");
      const since = lastSeq();
      const deleteClicks = shop.server.demoShop.deleteClicks;

      const draft = await survey(ctx);

      expect(draft.pages.map((p) => [new URL(p.url).pathname, p.status])).toEqual([
        ["/sitemap", "READ"],
        ["/", "READ"],
        ["/products", "READ"],
        ["/cart", "READ"],
        ["/login", "READ"],
        ["/redirect", "SKIPPED"],
      ]);
      expect(draft.suggestions.map((s) => s.id)).toEqual(["S-1", "S-2", "S-3"]);

      // What the shop saw: GETs only, of the pages the survey chose; the delete button was never pressed.
      const seen = requestsSince(since);
      expect(seen.filter((r) => r.method !== "GET")).toEqual([]);
      const paths = seen.map((r) => r.path);
      expect(paths).toEqual(expect.arrayContaining(["/sitemap", "/", "/products", "/cart", "/login", "/redirect"]));
      for (const never of ["/account/delete", "/logout", "/catalog.pdf", "/products/2"]) expect(paths).not.toContain(never);
      expect(shop.server.demoShop.deleteClicks).toBe(deleteClicks);

      // Events: paths only; the redirect off the site stopped by the navigation guard.
      const surveyed = events.filter((e) => e.type === "page.surveyed");
      expect(surveyed.map((e) => e.message)).toEqual([
        "Loaded /sitemap — Site map · Demo Shop",
        "Loaded / — Home · Demo Shop",
        "Loaded /products — Products · Demo Shop",
        "Loaded /cart — Cart · Demo Shop",
        "Loaded /login — Log in · Demo Shop",
        "Skipped /redirect — blocked by policy",
      ]);
      expect(JSON.stringify(surveyed)).not.toMatch(/[?#]|example\.org/);

      // A screenshot per page read — STANDARD (secrets are not redacted since 2026-10-07) — announced live.
      expect(shots).toHaveLength(5);
      expect(shots.every((png) => png.subarray(1, 4).toString() === "PNG")).toBe(true);
      expect(events.filter((e) => e.type === "artifact.created").map((e) => e.payload)).toEqual(
        shots.map((_, i) => ({ artifactId: `art_${i + 1}`, type: "SCREENSHOT", sensitivity: "STANDARD" })),
      );

      // One exploration choice (it stops, so nothing is clicked), then the suggestions call: the inventories the
      // in-page script read, the start page's screenshot, names never values.
      expect(transport.requests.map((r) => r.schemaName)).toEqual(["site_exploration_action", "test_suggestions"]);
      const content = transport.requests[1]!.messages[0]!.content as { type: string; text?: string }[];
      expect(content.map((p) => p.type)).toEqual(["text", "image"]);
      expect(content[0]!.text).toContain('"title":"Site map · Demo Shop"');
      expect(content[0]!.text).toContain('"text":"Delete my account"'); // the model sees the link; the survey never followed it
      expect(content[0]!.text).toContain("Secret names available: password");
      expect(JSON.stringify(transport.requests.map(({ signal: _s, ...r }) => r))).not.toContain(SECRET);
    },
    120_000,
  );

  it(
    "a start page the navigation guard stops (a redirect off the site) ends the survey: BROWSER_PROVIDER, no model call",
    async () => {
      const { ctx, events, transport, survey } = setup("/redirect?to=https://example.org/");
      const err = await survey(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BrowserProviderError);
      expect((err as Error).message).toBe("The start page could not be loaded (blocked by policy)");
      // Only the survey's own events: Chromium's background requests (e.g. to google.com) may add egress.blocked ones.
      expect(events.filter((e) => e.type === "page.surveyed").map((e) => e.message)).toEqual(["Skipped /redirect — blocked by policy"]);
      expect(transport.requests).toHaveLength(0);
    },
    120_000,
  );
});
