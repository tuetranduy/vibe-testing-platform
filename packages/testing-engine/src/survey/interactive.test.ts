import { chromium, type Browser, type Page } from "playwright-core";
import { FakeTransport, LlmClient } from "@platform/llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StageContext } from "../orchestrator/stages";
import { canExplore, explorePage } from "./interactive";
import { readSite } from "./site-reader";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });
const target = "https://shop.test/";
const html = `<html><title>Shop</title><form role="search" onsubmit="event.preventDefault();fetch('/api/search?q='+encodeURIComponent(document.querySelector('input').value)).then(r=>r.json()).then(r=>document.querySelector('h1').textContent=r.title)">
<label>Search products<input type="search" name="q"></label><button>Search</button></form><h1>Products</h1></html>`;
async function site(): Promise<Page> {
  const page = await browser.newPage();
  await page.route(`${target}**`, async (route) => {
    if (route.request().url().includes("/api/search")) await route.fulfill({ json: { title: "Matching shoes" } });
    else await route.fulfill({ contentType: "text/html", body: html });
  });
  return page;
}
function context(llm: LlmClient | null): StageContext {
  return {
    runId: "run_interactive", tenantId: "tenant", request: { targetUrl: target, requirement: "Search for shoes", environment: "staging",
      browser: "chromium", testData: { query: "shoes" }, secretNames: [], options: { additionalAllowedHosts: [] } as never },
    llm, signal: new AbortController().signal, deadlineAt: null, budgets: { explorationMs: 30_000, rerunMs: 0 },
    secrets: { names: [], get: () => undefined }, redact: (v) => v, publish: vi.fn(async () => {}),
    addCleanup: () => {}, boundary: async () => {}, budgetSignal: (ms) => AbortSignal.timeout(ms), now: () => new Date(),
  };
}
const review = { observation: "", missing: "the results" };
const fill = { ...review, candidate: 0, source: "testData", key: "query" };
const click = { ...review, observation: "The search field holds the query.", candidate: 0, source: "generated", key: "" };

describe("interactive live-site discovery", () => {
  it("fills and clicks real controls and retains resulting inventories, screenshots and scrubbed network context", async () => {
    const page = await site();
    try {
      const transport = new FakeTransport().enqueue({ json: fill }, { json: click }, { json: { observation: "Results for shoes are shown.", missing: "", candidate: -1, source: "generated", key: "" } });
      const ctx = context(new LlmClient({ transport, model: "fake", sleep: async () => {} }));
      const saved: string[] = [];
      const result = await readSite(ctx, { sandbox: { page, close: async () => {} },
        store: { saveScreenshot: async ({ fileName, png }) => { expect(png.length).toBeGreaterThan(100); saved.push(fileName); return { artifactId: `art_${saved.length}` }; } },
        pagesBudget: AbortSignal.timeout(15_000), pageTimeoutMs: 5000, maxLinks: 0, fileNamePrefix: "analysis" });
      expect(result.startFailure).toBeNull();
      const entry = result.read[0]!;
      expect(entry.interactions?.map((i) => i.kind)).toEqual(["fill", "click"]);
      expect(entry.interactions?.[1]).toMatchObject({ label: "Search", screenshotArtifactId: "art_3", inventory: { headings: [{ level: 1, text: "Matching shoes" }] } });
      expect(entry.network).toContainEqual({ method: "GET", url: `${target}api/search`, resourceType: "fetch", status: 200, failed: false });
      expect(JSON.stringify(entry.network)).not.toContain("q=");
      // Each review describes the state the previous action led to.
      expect(entry.interactions?.[0]?.observation).toBe("The search field holds the query.");
      expect(saved).toHaveLength(3);
      expect(JSON.stringify(transport.requests[0]?.messages)).toContain('"type":"image"');
    } finally { await page.close(); }
  });

  it("does not act after a model that ignores cancellation eventually answers", async () => {
    const page = await site();
    try {
      await page.goto(target);
      let answer!: (value: unknown) => void;
      const called = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
      const ctx = context({ generateStructured: called } as unknown as LlmClient);
      const controller = new AbortController();
      const work = explorePage(ctx, page, { signal: controller.signal, screenshot: async () => null, visited: new Set(), budget: { remaining: 6 } });
      await vi.waitFor(() => expect(called).toHaveBeenCalledOnce());
      controller.abort(new Error("budget used up"));
      await expect(work).rejects.toThrow("budget used up");
      answer({ data: fill });
      await Promise.resolve();
      expect(await page.locator("input").inputValue()).toBe("");
    } finally { await page.close(); }
  });

  it("filters mutations, sign-out, external links and generic form submissions before asking a model", () => {
    const ctx = context(null);
    const candidate = { selector: "xpath=/button", label: "Search", kind: "click" as const, type: "submit", href: "", submit: true, form: "search" };
    expect(canExplore(candidate, ctx)).toBe(true);
    for (const label of ["Delete account", "Place order", "Sign out", "Register", "Sign up", "Create account", "Save changes", "Send message"]) {
      expect(canExplore({ ...candidate, label, form: "" }, ctx)).toBe(false);
    }
    // Opening a sign-up form persists nothing; submitting it, filling it or another "create" control would.
    const opener = { ...candidate, submit: false, type: "button", form: "" };
    for (const label of ["Sign up", "Register", "Create an account"]) expect(canExplore({ ...opener, label }, ctx)).toBe(true);
    expect(canExplore({ ...opener, label: "Create post" }, ctx)).toBe(false);
    expect(canExplore({ ...opener, kind: "fill", type: "email", label: "Email", form: " /account/register " }, ctx)).toBe(false);
    expect(canExplore({ ...candidate, label: "Continue", form: "" }, ctx)).toBe(false);
    expect(canExplore({ ...candidate, href: "https://outside.test/search" }, ctx)).toBe(false);
  });

  it("follows a flow into a dialog (Sign in, then its Sign up) and stops once the review reports nothing missing", async () => {
    const page = await browser.newPage();
    const dialog = `<html><title>Store</title><button onclick="document.querySelector('#d').innerHTML=document.querySelector('#signin').innerHTML">Sign in</button>
<div id="d"></div><template id="signin"><form><label>Email<input type="email"></label><label>Password<input type="password"></label><button>Sign in</button></form>
<button type="button" onclick="document.querySelector('#d').innerHTML=document.querySelector('#signup').innerHTML">Sign up</button></template>
<template id="signup"><form><label>First name<input></label><label>Email address<input type="email"></label><label>Password<input type="password"></label><button>Create account</button></form></template></html>`;
    await page.route(`${target}**`, (route) => route.fulfill({ contentType: "text/html", body: dialog }));
    try {
      await page.goto(target);
      const transport = new FakeTransport();
      const llm = new LlmClient({ transport, model: "fake", sleep: async () => {} });
      // The model picks by index among the explorable candidates, which it sees by label.
      const pick = (label: string) => (req: { messages: { content: unknown }[] }) => {
        const parts = req.messages[req.messages.length - 1]!.content as { type: string; text?: string }[] | string;
        const text = typeof parts === "string" ? parts : parts.find((p) => p.type === "text")!.text!;
        const list = (JSON.parse(text) as { candidates: { index: number; label: string }[] }).candidates;
        return { json: { observation: `before ${label}`, missing: "the sign-up form", candidate: list.find((c) => c.label === label)!.index, source: "generated", key: "" } };
      };
      transport.enqueue(pick("Sign in"), pick("Sign up"), { json: { observation: "The sign-up form asks for first name, email address and password.", missing: "", candidate: -1, source: "generated", key: "" } });
      const ctx = context(llm);
      ctx.request.requirement = "verify signup functionality for this website";
      const budget = { remaining: 6 } as { remaining: number; goalReached?: boolean };
      const interactions = await explorePage(ctx, page, { signal: AbortSignal.timeout(15_000), screenshot: async () => null, visited: new Set(), budget });
      expect(interactions.map((i) => i.label)).toEqual(["Sign in", "Sign up"]);
      expect(interactions[1]?.inventory.forms[0]?.fields.map((f) => f.label)).toEqual(["First name", "Email address", "Password"]);
      expect(interactions[0]?.observation).toBe("before Sign up");
      expect(interactions[1]?.observation).toContain("sign-up form");
      expect(budget.goalReached).toBe(true);
      // Nothing was submitted or filled on the way.
      expect(await page.locator("input[type=email]").inputValue()).toBe("");
    } finally { await page.close(); }
  });

  it("offers only an open modal's controls, not the page behind its backdrop", async () => {
    const page = await browser.newPage();
    const body = `<html><title>Store</title><a href="/product">Smoking Board</a><button>Add to cart</button>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><form><input type="email" aria-label="Email address"><button>Sign in</button></form><button type="button">Sign up</button></div></html>`;
    await page.route(`${target}**`, (route) => route.fulfill({ contentType: "text/html", body }));
    try {
      await page.goto(target);
      const transport = new FakeTransport().enqueue({ json: { observation: "A sign-in dialog.", missing: "x", candidate: -1, source: "generated", key: "" } });
      await explorePage(context(new LlmClient({ transport, model: "fake", sleep: async () => {} })), page,
        { signal: AbortSignal.timeout(10_000), screenshot: async () => null, visited: new Set(), budget: { remaining: 6 } });
      const sent = transport.requests[0]!.messages[0]!.content as { type: string; text?: string }[];
      const labels = (JSON.parse(sent.find((p) => p.type === "text")!.text!) as { candidates: { label: string }[] }).candidates.map((c) => c.label);
      expect(labels).toEqual(["Email address", "Sign in", "Sign up"]);
    } finally { await page.close(); }
  });
});
