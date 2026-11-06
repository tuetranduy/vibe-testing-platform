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
const fill = { candidate: 0, source: "testData", key: "query" };
const click = { candidate: 0, source: "generated", key: "" };

describe("interactive live-site discovery", () => {
  it("fills and clicks real controls and retains resulting inventories, screenshots and scrubbed network context", async () => {
    const page = await site();
    try {
      const transport = new FakeTransport().enqueue({ json: fill }, { json: click }, { json: { candidate: -1, source: "generated", key: "" } });
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
    for (const label of ["Delete account", "Place order", "Sign out", "Register", "Save changes", "Send message"]) {
      expect(canExplore({ ...candidate, label, form: "" }, ctx)).toBe(false);
    }
    expect(canExplore({ ...candidate, label: "Continue", form: "" }, ctx)).toBe(false);
    expect(canExplore({ ...candidate, href: "https://outside.test/search" }, ctx)).toBe(false);
  });
});
