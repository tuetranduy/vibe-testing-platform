import { BrowserProviderError, CancelledError, ContractError, type StoredTestRunRequest } from "@platform/contracts";
import { FakeTransport, LlmClient, type LlmTransportRequest } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import type { EventDraft, StageContext } from "../orchestrator/stages";
import type { SurveyLink } from "./links";
import { SURVEY_PAGE_TIMEOUT_MS, createSurveyStage, type SurveySandbox } from "./survey-stage";

const ORIGIN = "https://shop.example.com";
const link = (text: string, path: string, area: "nav" | "main" = "main"): SurveyLink => ({ text, url: `${ORIGIN}${path}`, area });

interface FakePage {
  title?: string;
  links?: SurveyLink[];
  status?: number;
  /** The navigation guard stops it (as it stops a redirect off the allowed hosts). */
  blocked?: boolean;
  /** goto throws this message (a timeout, a network error). */
  fail?: string;
  /** Where the page lands after goto. */
  landsOn?: string;
}

/** A scripted site behind a fake sandbox page: goto by path, one inventory per page, no browser. */
function fakeSite(site: Record<string, FakePage>, opts: { onGoto?: (path: string) => void; log?: string[] } = {}) {
  let current = "about:blank";
  const gotos: { url: string; timeout: number | undefined }[] = [];
  const listeners = new Set<(e: { url: string; reason: string }) => void>();
  const page = {
    url: () => current,
    async goto(url: string, o?: { timeout?: number }) {
      gotos.push({ url, timeout: o?.timeout });
      const path = new URL(url).pathname;
      opts.onGoto?.(path);
      const p = site[path];
      if (!p) throw new Error("page.goto: net::ERR_NAME_NOT_RESOLVED");
      if (p.blocked) {
        for (const l of listeners) l({ url, reason: "OFF_DOMAIN_NAVIGATION" });
        throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
      }
      if (p.fail) throw new Error(p.fail);
      current = p.landsOn ?? url;
      return { status: () => p.status ?? 200 };
    },
    async evaluate() {
      const p = site[new URL(current).pathname];
      return { title: p?.title ?? "", description: "", headings: [], links: p?.links ?? [], forms: [], buttons: [] };
    },
    async screenshot() {
      return Buffer.from(`PNG ${current}`);
    },
  };
  const close = vi.fn(async () => void opts.log?.push("sandbox closed"));
  const sandbox: SurveySandbox = {
    page: page as unknown as Page,
    onNavigationBlocked: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    close,
  };
  return { sandbox, close, gotos };
}

const answer = {
  suggestions: [1, 2, 3].map((i) => ({
    title: `Test ${i}`,
    requirement: `A visitor can open page ${i} and sees its heading.`,
    why: "It is linked from the home page.",
    needs: { secrets: [], testData: [] },
    destructive: false,
  })),
};

const request = (patch: Partial<StoredTestRunRequest> = {}): StoredTestRunRequest => ({
  targetUrl: `${ORIGIN}/`,
  requirement: "",
  environment: "staging",
  browser: "chromium",
  testData: { email: "alice@example.com" },
  secretNames: [],
  options: {
    maxExplorationSteps: 40,
    maxRunSeconds: 300,
    generatePlaywright: true,
    rerunGeneratedTest: true,
    autoConfirmCriteria: false,
    allowDestructiveActions: false,
    additionalAllowedHosts: [],
  },
  ...patch,
});

function setup(opts: { secrets?: Record<string, string>; budget?: AbortSignal; llm?: "none"; log?: string[] } = {}) {
  const transport = new FakeTransport().enqueue((req: LlmTransportRequest) => {
    opts.log?.push("model called");
    void req;
    return { json: answer };
  });
  const secrets = opts.secrets ?? {};
  const redact = createRunRedactor();
  const events: EventDraft[] = [];
  const cleanups: (() => Promise<void> | void)[] = [];
  const shots: { fileName: string; sensitivity: string }[] = [];
  const ac = new AbortController();
  const ctx: StageContext = {
    runId: "run_1",
    tenantId: "t_default",
    request: request({ secretNames: Object.keys(secrets) }),
    signal: ac.signal,
    deadlineAt: null,
    budgets: { explorationMs: 108_000, rerunMs: 45_000 },
    secrets: { names: Object.keys(secrets), get: (n) => secrets[n] },
    redact,
    publish: async (e) => void events.push(redact(e) as EventDraft),
    addCleanup: (fn) => void cleanups.push(fn),
    boundary: async () => {
      if (ac.signal.aborted) throw ac.signal.reason;
    },
    budgetSignal: (ms) => opts.budget ?? AbortSignal.any([ac.signal, AbortSignal.timeout(ms)]),
    now: () => new Date(),
    llm: opts.llm === "none" ? null : new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {} }),
  };
  const store = {
    saveScreenshot: async (input: { png: Buffer; fileName: string; sensitivity: string }) => {
      shots.push({ fileName: input.fileName, sensitivity: input.sensitivity });
      return { artifactId: `art_${shots.length}` };
    },
  };
  return { ctx, events, cleanups, shots, transport, store, abort: (reason: Error) => ac.abort(reason) };
}

const HOME: FakePage = {
  title: "Home · Demo Shop",
  links: [
    link("Products", "/products", "nav"),
    link("Cart", "/cart", "nav"),
    link("Delete my account", "/account/delete"),
    link("Log out", "/logout"),
    link("Catalog (PDF)", "/catalog.pdf"),
    { text: "Visit example.org", url: "https://example.org/", area: "main" },
    link("Reset your password", "/reset?email=alice@example.com"),
    link("Partner offers", "/offers"),
    link("Old page", "/missing"),
    link("Pixel 11", "/products/2"),
  ],
};
const SITE: Record<string, FakePage> = {
  "/": HOME,
  "/products": { title: "Products · Demo Shop" },
  "/cart": { title: "Your cart · Demo Shop" },
  "/reset": { title: "Reset password · Demo Shop" },
  "/offers": { blocked: true },
  "/missing": { status: 404, title: "Not found" },
  "/products/2": { title: "Pixel 11 · Demo Shop" },
};

describe("survey stage", () => {
  it("loads the start page and the 5 chosen links by URL, records each page, then asks the model once — after closing the browser", async () => {
    const log: string[] = [];
    const { ctx, events, transport, store } = setup({ log });
    const site = fakeSite(SITE, { log });
    const survey = createSurveyStage({ openSandbox: async () => site.sandbox, store: () => store });

    const draft = await survey(ctx);

    expect(site.gotos.map((g) => g.url)).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/products`,
      `${ORIGIN}/cart`,
      `${ORIGIN}/reset?email=alice@example.com`,
      `${ORIGIN}/offers`,
      `${ORIGIN}/missing`,
    ]);
    expect(draft.pages).toEqual([
      { url: `${ORIGIN}/`, title: "Home · Demo Shop", status: "READ" },
      { url: `${ORIGIN}/products`, title: "Products · Demo Shop", status: "READ" },
      { url: `${ORIGIN}/cart`, title: "Your cart · Demo Shop", status: "READ" },
      { url: `${ORIGIN}/reset`, title: "Reset password · Demo Shop", status: "READ" },
      { url: `${ORIGIN}/offers`, title: "", status: "SKIPPED" },
      { url: `${ORIGIN}/missing`, title: "", status: "SKIPPED" },
    ]);
    expect(draft.suggestions.map((s) => s.id)).toEqual(["S-1", "S-2", "S-3"]);
    expect(transport.requests).toHaveLength(1);
    expect(log).toEqual(["sandbox closed", "model called"]);
    expect(events.filter((e) => e.type === "page.surveyed").map((e) => e.message)).toEqual([
      "Loaded / — Home · Demo Shop",
      "Loaded /products — Products · Demo Shop",
      "Loaded /cart — Your cart · Demo Shop",
      "Loaded /reset — Reset password · Demo Shop",
      "Skipped /offers — blocked by policy",
      "Skipped /missing — answered 404",
    ]);
  });

  it("publishes a page's path only: never its query string, which can carry personal data", async () => {
    const { ctx, events, store } = setup();
    const site = fakeSite(SITE);
    const draft = await createSurveyStage({ openSandbox: async () => site.sandbox, store: () => store })(ctx);
    const reset = events.find((e) => e.type === "page.surveyed" && e.payload.path === "/reset");
    expect(reset?.payload).toEqual({ path: "/reset", title: "Reset password · Demo Shop", status: "READ" });
    expect(JSON.stringify({ events, pages: draft.pages })).not.toContain("alice@example.com");
  });

  it("each page load gets at most 20 s", async () => {
    const { ctx, store } = setup();
    const site = fakeSite(SITE);
    await createSurveyStage({ openSandbox: async () => site.sandbox, store: () => store })(ctx);
    expect(new Set(site.gotos.map((g) => g.timeout))).toEqual(new Set([SURVEY_PAGE_TIMEOUT_MS]));
    expect(SURVEY_PAGE_TIMEOUT_MS).toBe(20_000);
  });

  it("a page that does not load, or lands off the allowed hosts, is SKIPPED and the survey goes on", async () => {
    const { ctx, events, store } = setup();
    const site = fakeSite({
      "/": { title: "Home", links: [link("Slow", "/slow"), link("Away", "/away"), link("Cart", "/cart")] },
      "/slow": { fail: "page.goto: Timeout 20000ms exceeded." },
      "/away": { landsOn: "https://login.example.net/sso" },
      "/cart": { title: "Cart" },
    });
    const draft = await createSurveyStage({ openSandbox: async () => site.sandbox, store: () => store })(ctx);
    expect(draft.pages.map((p) => [new URL(p.url).pathname, p.status])).toEqual([
      ["/", "READ"],
      ["/slow", "SKIPPED"],
      ["/away", "SKIPPED"],
      ["/cart", "READ"],
    ]);
    expect(events.filter((e) => e.type === "page.surveyed").map((e) => e.message)).toEqual([
      "Loaded / — Home",
      "Skipped /slow — did not load",
      "Skipped /away — left the allowed hosts",
      "Loaded /cart — Cart",
    ]);
  });

  it("saves a STANDARD screenshot of each page it read, shows them live, and gives the model the start page's", async () => {
    const { ctx, events, shots, transport, store } = setup({ secrets: { password: "pw-123456" } });
    const site = fakeSite(SITE);
    await createSurveyStage({ openSandbox: async () => site.sandbox, store: () => store })(ctx);
    expect(shots).toHaveLength(4);
    expect(new Set(shots.map((s) => s.sensitivity))).toEqual(new Set(["STANDARD"]));
    expect(events.filter((e) => e.type === "artifact.created").map((e) => e.message)).toEqual([
      "Full-page screenshot saved for /",
      "Full-page screenshot saved for /products",
      "Full-page screenshot saved for /cart",
      "Full-page screenshot saved for /reset",
    ]);
    const image = (transport.requests[0]!.messages[0]!.content as { type: string; data?: string }[]).find((p) => p.type === "image");
    expect(image?.data).toBe(Buffer.from(`PNG ${ORIGIN}/`).toString("base64"));
  });

  it("the prompt carries names, never values, and the pages' inventories", async () => {
    const { ctx, transport, store } = setup({ secrets: { password: "pw-Survey-Secret" } });
    const site = fakeSite(SITE);
    await createSurveyStage({ openSandbox: async () => site.sandbox, store: () => store })(ctx);
    const text = JSON.stringify(transport.requests.map(({ signal: _s, ...r }) => r));
    expect(text).toContain("Secret names available: password");
    expect(text).toContain("Test data keys available: email");
    expect(text).not.toContain("pw-Survey-Secret");
    expect(text).not.toContain("alice@example.com");
    expect(text).toContain("Your cart · Demo Shop");
  });

  it("the start page that can't be read ends the survey: its page is SKIPPED, no model call, BROWSER_PROVIDER error", async () => {
    const { ctx, events, transport, store } = setup();
    const site = fakeSite({ "/": { blocked: true } });
    const err = await createSurveyStage({ openSandbox: async () => site.sandbox, store: () => store })(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserProviderError);
    expect((err as Error).message).toBe("The start page could not be loaded (blocked by policy)");
    expect(events.map((e) => e.message)).toEqual(["Skipped / — blocked by policy"]);
    expect(transport.requests).toHaveLength(0);
    expect(site.close).toHaveBeenCalled();
  });

  it("stops loading pages once the page budget (60 % of the survey's time) is used, and still asks the model", async () => {
    const budget = new AbortController();
    const { ctx, transport, store } = setup({ budget: budget.signal });
    const site = fakeSite(SITE, { onGoto: (path) => path === "/products" && budget.abort(new Error("page budget used")) });
    const draft = await createSurveyStage({ openSandbox: async () => site.sandbox, store: () => store })(ctx);
    expect(draft.pages.map((p) => [new URL(p.url).pathname, p.status])).toEqual([
      ["/", "READ"],
      ["/products", "SKIPPED"],
    ]);
    expect(site.gotos).toHaveLength(2);
    expect(transport.requests).toHaveLength(1);
  });

  it("a cancel while loading pages throws the cancel (no SKIPPED page) and closes the browser", async () => {
    const setupResult = setup();
    const site = fakeSite(SITE, { onGoto: (path) => path === "/cart" && setupResult.abort(new CancelledError()) });
    const err = await createSurveyStage({ openSandbox: async () => site.sandbox, store: () => setupResult.store })(setupResult.ctx).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CancelledError);
    expect(site.close).toHaveBeenCalled();
    expect(setupResult.events.some((e) => e.type === "page.surveyed" && e.payload.path === "/cart")).toBe(false);
    expect(setupResult.transport.requests).toHaveLength(0);
  });

  it("a run without a model client (the fake engine's) can't survey: ContractError before any browser opens", async () => {
    const { ctx, store } = setup({ llm: "none" });
    const openSandbox = vi.fn(async () => fakeSite(SITE).sandbox);
    await expect(createSurveyStage({ openSandbox, store: () => store })(ctx)).rejects.toBeInstanceOf(ContractError);
    expect(openSandbox).not.toHaveBeenCalled();
  });

  it("a sandbox that fails to start is a BROWSER_PROVIDER error; the raw cause stays in the log", async () => {
    const { ctx, store } = setup();
    const logged: object[] = [];
    const err = await createSurveyStage({
      openSandbox: async () => Promise.reject(new Error("chromium stderr: no usable sandbox")),
      store: () => store,
      logger: { error: (obj) => void logged.push(obj) },
    })(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserProviderError);
    expect((err as Error).message).toBe("Browser sandbox failed to start");
    expect(logged).toHaveLength(1);
  });
});
