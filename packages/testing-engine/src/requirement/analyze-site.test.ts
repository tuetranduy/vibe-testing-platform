import type { StoredTestRunRequest, TestDataValue } from "@platform/contracts";
import { FakeTransport, LlmClient } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import type { EventDraft, StageContext } from "../orchestrator/stages";
import type { SurveyLink } from "../survey/links";
import type { SurveySandbox } from "../survey/site-reader";
import { createAnalyzeStage, linkRelevance, requirementWords } from "./compiler";
import { validateInsights } from "./insights";

/** A redactor that masks the given values: the run's redactor is key-based, but the plumbing applies whatever it is given. */
const maskValues =
  (...values: string[]) =>
  (v: unknown): unknown =>
    JSON.parse(values.reduce((json, s) => json.split(s).join("[REDACTED]"), JSON.stringify(v) ?? "null"));

const ORIGIN = "https://shop.example.com";
const TEXT = "A visitor can register an account with their email address and sees a welcome message.";
const link = (text: string, path: string, area: "nav" | "main" = "nav"): SurveyLink => ({ text, url: `${ORIGIN}${path}`, area });

/** A scripted site behind a fake sandbox page (as in the survey's tests): goto by path, no browser. */
function fakeSite(site: Record<string, { title: string; links?: SurveyLink[]; fail?: boolean }>) {
  let current = "about:blank";
  const gotos: string[] = [];
  const shots: { fullPage: boolean | undefined }[] = [];
  const page = {
    url: () => current,
    async goto(url: string) {
      const path = new URL(url).pathname;
      gotos.push(path);
      const p = site[path];
      if (!p || p.fail) throw new Error("page.goto: net::ERR_CONNECTION_REFUSED");
      current = url;
      return { status: () => 200 };
    },
    async waitForLoadState() {},
    async evaluate() {
      const p = site[new URL(current).pathname];
      return { title: p?.title ?? "", description: "", headings: [], links: p?.links ?? [], forms: [], buttons: [] };
    },
    async screenshot(o: { fullPage?: boolean }) {
      shots.push({ fullPage: o.fullPage });
      return Buffer.from(`PNG ${current} ${o.fullPage ? "full" : "viewport"}`);
    },
  };
  const close = vi.fn(async () => {});
  const sandbox: SurveySandbox = { page: page as unknown as Page, close };
  return { sandbox, close, gotos, shots };
}

const SITE = {
  "/": {
    title: "Home · Shop",
    links: [link("About us", "/about"), link("Blog", "/blog"), link("Register", "/register"), link("Account", "/account"), link("Help", "/help")],
  },
  "/about": { title: "About" },
  "/blog": { title: "Blog" },
  "/register": { title: "Register" },
  "/account": { title: "Account" },
  "/help": { title: "Help" },
};

const answer = {
  criteria: [
    {
      sourceText: "A visitor can register an account with their email address",
      statement: "Registering shows a welcome message",
      expectedOutcome: { kind: "visible", fact: { key: "welcome", checkpoint: "after_register" }, expected: true },
      preconditions: [
        { kind: "test_data", ref: "email", description: "Email address to register with" },
        { kind: "test_data", ref: "firstName", description: "First name for the account" },
        { kind: "test_data", ref: "password", description: "Account password" },
      ],
      ambiguity: null,
    },
  ],
  facts: [{ key: "welcome", checkpoint: "after_register", description: "Welcome message", valueType: "boolean" }],
  siteChecks: [
    { criterion: 1, status: "found", note: "The Register page has a sign-up form" },
    { criterion: 7, status: "found", note: "out of range" },
  ],
  testData: [{ key: "email", value: "new.visitor@example.com", description: "A fresh address", fromSite: false }],
};

const request = (options: Partial<StoredTestRunRequest["options"]> = {}, testData: Record<string, TestDataValue> = {}): StoredTestRunRequest => ({
  targetUrl: `${ORIGIN}/`,
  requirement: TEXT,
  environment: "staging",
  browser: "chromium",
  testData,
  secretNames: [],
  options: {
    maxExplorationSteps: 40,
    maxRunSeconds: 300,
    generatePlaywright: true,
    rerunGeneratedTest: true,
    autoConfirmCriteria: false,
    allowDestructiveActions: false,
    additionalAllowedHosts: [],
    ...options,
  },
});

function setup(req: StoredTestRunRequest, reply: object = answer) {
  const transport = new FakeTransport().enqueue({ json: reply });
  const llm = new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {} });
  const events: EventDraft[] = [];
  const ac = new AbortController();
  const ctx: StageContext = {
    runId: "run_1",
    tenantId: "t_1",
    request: req,
    signal: ac.signal,
    deadlineAt: null,
    budgets: { explorationMs: 60_000, rerunMs: 1000 },
    secrets: { names: [], get: () => undefined },
    redact: createRunRedactor(),
    publish: async (e) => void events.push(e),
    addCleanup: () => {},
    boundary: async () => {},
    budgetSignal: () => new AbortController().signal,
    now: () => new Date(),
    llm,
  };
  const saved: string[] = [];
  const store = () => ({
    saveScreenshot: async (i: { fileName: string }) => {
      saved.push(i.fileName);
      return { artifactId: `art_${saved.length}` };
    },
  });
  return { transport, ctx, events, saved, store };
}

describe("analyze stage against the live site (V1.3)", () => {
  it("reads the start page and the links that match the requirement first, then compiles with what they show", async () => {
    const h = setup(request());
    const site = fakeSite(SITE);
    const result = await createAnalyzeStage({ site: { openSandbox: async () => site.sandbox, store: h.store } })(h.ctx);

    // Start page, then the 3 best links: Register and Account share the requirement's words.
    expect(site.gotos).toEqual(["/", "/register", "/account", "/about"]);
    expect(site.close).toHaveBeenCalled();
    expect(h.saved).toEqual(["analysis-1.png", "analysis-2.png", "analysis-3.png", "analysis-4.png"]);
    expect(site.shots.filter((s) => s.fullPage).length).toBe(4);
    expect(h.events.filter((e) => e.type === "page.surveyed")).toHaveLength(4);

    const content = h.transport.requests[0]!.messages[0]!.content as { type: string; text?: string; data?: string }[];
    expect(content[0]!.text).toContain("<<<PAGES");
    expect(content[0]!.text).toContain("/register");
    expect(content[1]).toMatchObject({ type: "image", data: Buffer.from(`PNG ${ORIGIN}/ viewport`).toString("base64") });

    expect(result.criteria.map((c) => c.id)).toEqual(["AC-1"]);
    expect(result).not.toHaveProperty("insights");
    expect(result.siteAnalysis).toMatchObject({
      status: "READ",
      reason: null,
      pages: [{ url: `${ORIGIN}/`, status: "READ" }, { url: `${ORIGIN}/register` }, { url: `${ORIGIN}/account` }, { url: `${ORIGIN}/about` }],
      checks: [{ criterionId: "AC-1", status: "FOUND", note: "The Register page has a sign-up form" }],
    });
    // email from the model; firstName from the generator; never the password (a credential: a secret).
    expect(result.siteAnalysis!.testData).toEqual([
      { key: "email", value: "new.visitor@example.com", description: "A fresh address", source: "GENERATED" },
      { key: "firstName", value: "Alex", description: "First name for the account", source: "GENERATED" },
    ]);
    // Kept for the planner (KI-048): each page read and what it showed.
    expect(result.siteAnalysis!.pageContents!.map((p) => [p.url, p.inventory.title])).toEqual([
      [`${ORIGIN}/`, SITE["/"]!.title],
      [`${ORIGIN}/register`, SITE["/register"]!.title],
      [`${ORIGIN}/account`, SITE["/account"]!.title],
      [`${ORIGIN}/about`, SITE["/about"]!.title],
    ]);
  });

  it("a sandbox that does not start → UNAVAILABLE; the requirement is still compiled, without pages", async () => {
    const h = setup(request());
    const result = await createAnalyzeStage({
      site: {
        openSandbox: async () => {
          throw new Error("Chromium: No usable sandbox!");
        },
        store: h.store,
      },
    })(h.ctx);
    expect(result.siteAnalysis).toMatchObject({ status: "UNAVAILABLE", reason: "The browser could not be started", pages: [], checks: [], pageContents: [] });
    expect(result.siteAnalysis!.testData.map((t) => t.key)).toEqual(["email", "firstName"]);
    expect(JSON.stringify(h.transport.requests[0]!.messages)).not.toContain("<<<PAGES");
  });

  it("a start page that does not load → UNAVAILABLE with the reason and the page skipped", async () => {
    const h = setup(request());
    const site = fakeSite({ "/": { title: "", fail: true } });
    const result = await createAnalyzeStage({ site: { openSandbox: async () => site.sandbox, store: h.store } })(h.ctx);
    expect(result.siteAnalysis).toMatchObject({
      status: "UNAVAILABLE",
      reason: "The start page could not be read (did not load)",
      pages: [{ url: `${ORIGIN}/`, status: "SKIPPED" }],
    });
    expect(site.close).toHaveBeenCalled();
  });

  it("turned off for the run → SKIPPED, no browser opened", async () => {
    const h = setup(request({ analyzeLiveSite: false }));
    const openSandbox = vi.fn();
    const result = await createAnalyzeStage({ site: { openSandbox, store: h.store } })(h.ctx);
    expect(openSandbox).not.toHaveBeenCalled();
    expect(result.siteAnalysis).toMatchObject({ status: "SKIPPED", reason: "Turned off for this run" });
  });

  it("test data the run already has is never suggested", async () => {
    const h = setup(request({}, { email: "mine@example.com" }));
    const result = await createAnalyzeStage()(h.ctx);
    expect(result.siteAnalysis!.testData.map((t) => t.key)).toEqual(["firstName"]);
  });
});

describe("link relevance", () => {
  it("counts the requirement's content words a link's text or path shares", () => {
    const rank = linkRelevance(requirementWords(TEXT));
    expect(rank(link("Register", "/register"))).toBe(1);
    expect(rank(link("My account", "/account"))).toBe(1);
    expect(rank(link("Create an account", "/register"))).toBe(2);
    expect(rank(link("About us", "/about"))).toBe(0);
  });
});

describe("validateInsights", () => {
  const draft = {
    originalText: TEXT,
    criteria: [answer.criteria[0], { ...answer.criteria[0], preconditions: [{ kind: "test_data", ref: "productName", description: "A product" }] }].map(
      (c, i) => ({ ...c, id: `AC-${i + 1}`, critical: true }),
    ),
    facts: answer.facts,
  } as never;
  const base = { draft, testData: {}, secretNames: [], seed: "run_1", redact: (v: unknown) => v };

  it("without pages read: no site checks, and no value counts as taken from the site", () => {
    const out = validateInsights({
      ...base,
      siteRead: false,
      output: { siteChecks: [{ criterion: 1, status: "found", note: "x" }], testData: [{ key: "productName", value: "iPhone 17 Pro", description: "", fromSite: true }] },
    });
    expect(out.checks).toEqual([]);
    expect(out.testData.find((t) => t.key === "productName")).toMatchObject({ value: "iPhone 17 Pro", source: "GENERATED", description: "A product" });
  });

  it("with pages read: one check per criterion (the first), site values marked SITE; unusable values replaced", () => {
    const out = validateInsights({
      ...base,
      siteRead: true,
      output: {
        siteChecks: [
          { criterion: 2, status: "not_found", note: "No product list on the pages read" },
          { criterion: 1, status: "unclear", note: "first" },
          { criterion: 1, status: "found", note: "duplicate" },
          { criterion: 1.5, status: "found", note: "not an index" },
        ],
        testData: [
          { key: "productName", value: "iPhone 17 Pro", description: "A listed product", fromSite: true },
          { key: "email", value: "   ", description: "blank", fromSite: false },
        ],
      },
    });
    expect(out.checks).toEqual([
      { criterionId: "AC-1", status: "UNCLEAR", note: "first" },
      { criterionId: "AC-2", status: "NOT_FOUND", note: "No product list on the pages read" },
    ]);
    expect(out.testData).toEqual([
      { key: "email", value: expect.stringMatching(/@example\.com$/), description: "Email address to register with", source: "GENERATED" },
      { key: "firstName", value: "Alex", description: "First name for the account", source: "GENERATED" },
      { key: "productName", value: "iPhone 17 Pro", description: "A listed product", source: "SITE" },
    ]);
  });

  it("a suggested value that carries one of the run's secret values is dropped for a generated one", () => {
    const secret = "hunter2-secret";
    const out = validateInsights({
      ...base,
      siteRead: true,
      redact: maskValues(secret),
      output: { siteChecks: [], testData: [{ key: "email", value: `${secret}@example.com`, description: "", fromSite: false }] },
    });
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.testData[0]).toMatchObject({ key: "email", source: "GENERATED" });
  });
});
