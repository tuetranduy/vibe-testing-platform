import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserProviderError, type StoredTestRunRequest } from "@platform/contracts";
import { startDemoShop, type RunningDemoShop } from "@platform/demo-shop";
import { LlmClient, type LlmTransport, type LlmTransportRequest, type LlmTransportResponse } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { createSurveyStage, type EventDraft, type StageContext } from "@platform/testing-engine";
import { chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openRunSandbox } from "../../apps/worker/src/sandbox/run-sandbox";

/**
 * The survey against real Chromium (spec "Testing"): the worker's sandbox — egress proxy, Chromium
 * WITHOUT the Stagehand extension, navigation guard — on the in-process demo shop reached as
 * `shop.test`, the in-page inventory script (transpiled with keepNames, as the worker runs), and the
 * real LlmClient over a transport that answers the one `test_suggestions` call. No API key.
 */

const silent = { info() {}, warn() {}, error() {} };
const SECRET = "hunter2-Survey-Secret";

/** Answers the survey's model call with three suggestions, and keeps what it was sent. */
class SuggestionTransport implements LlmTransport {
  readonly provider = "scripted";
  readonly requests: LlmTransportRequest[] = [];

  async complete(req: LlmTransportRequest): Promise<LlmTransportResponse> {
    this.requests.push(req);
    if (req.schemaName !== "test_suggestions") throw new Error(`unexpected model call ${req.schemaName}`);
    const suggestions = [
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

  function setup(targetPath: string) {
    const runId = `run_survey_${runIds.length + 1}_${Date.now().toString(36)}`;
    runIds.push(runId);
    const request: StoredTestRunRequest = {
      targetUrl: `http://shop.test:${shop.port}${targetPath}`,
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
    const transport = new SuggestionTransport();
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
    const resolver = async (host: string) => {
      if (host === "shop.test") return ["127.0.0.1"];
      throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    };
    const survey = createSurveyStage({
      openSandbox: (c) => openRunSandbox(c, { resolve: resolver, privateAllowlist: [`shop.test:${shop.port}`], logger: silent }),
      store: () => ({
        saveScreenshot: async ({ png }) => {
          shots.push(png);
          return { artifactId: `art_${shots.length}` };
        },
      }),
    });
    return { ctx, events, shots, transport, survey };
  }

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

      // One model call: the inventories the in-page script read, the start page's screenshot, names never values.
      expect(transport.requests).toHaveLength(1);
      const content = transport.requests[0]!.messages[0]!.content as { type: string; text?: string }[];
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
