import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import type { RequestOptions } from "node:https";
import { Readable } from "node:stream";
import { RunOptionsSchema } from "@platform/contracts";
import { defaultResolver } from "@platform/security";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StageContext } from "../orchestrator/stages";
import { inventoryOfVerifiedHtml, readVerifiedSite } from "./verified-site";

const request = vi.hoisted(() => vi.fn<(
  options: RequestOptions,
  onResponse: (response: Readable & { statusCode: number; headers: IncomingHttpHeaders }) => void,
) => EventEmitter & { end(): void }>());
vi.mock("node:https", () => ({ request }));
vi.mock("@platform/security", async (importOriginal) => ({
  ...await importOriginal<typeof import("@platform/security")>(),
  defaultResolver: vi.fn(),
}));

const ORIGIN = "https://shop.example.com";
const PUBLIC_IP = "93.184.216.34";

function stubSite(pages: Record<string, { redirect?: string; html?: string }>) {
  request.mockImplementation((options, onResponse) => Object.assign(new EventEmitter(), {
    end() {
      const page = pages[options.path ?? ""];
      if (!page) throw new Error(`Unexpected request: ${options.path}`);
      const response = Readable.from([Buffer.from(page.html ?? "")]);
      onResponse(Object.assign(response, {
        statusCode: page.redirect ? 301 : 200,
        headers: page.redirect ? { location: page.redirect } : { "content-type": "text/html" },
      }));
    },
  }));
}

function context(): StageContext {
  const { signal } = new AbortController();
  return {
    runId: "run_verified_site",
    tenantId: "t_default",
    request: {
      targetUrl: ORIGIN, environment: "staging", requirement: "", browser: "chromium",
      testData: {}, secretNames: [], options: RunOptionsSchema.parse({}),
    },
    budgets: { explorationMs: 30_000, rerunMs: 30_000 },
    signal,
    deadlineAt: null,
    budgetSignal: (ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)]),
    boundary: async () => signal.throwIfAborted(),
    publish: vi.fn(async () => {}),
    redact: (value: unknown) => value,
    secrets: { names: [], get: () => undefined },
    addCleanup: () => {},
    now: () => new Date(),
    llm: null,
  };
}

const paths = () => request.mock.calls.map(([options]) => options.path);

describe("verified site inventory", () => {
  it("collects public page labels and links on the exact HTTPS origin without acting on markup", () => {
    const inventory = inventoryOfVerifiedHtml(`
      <title>Catalog</title><h1>Find books</h1><h2 hidden>Hidden heading</h2>
      <script>fetch("https://other.example/")</script>
      <a href="/books">Browse</a><a href="https://other.example/">Other</a>
      <a href="https://sub.catalog.example/">Subdomain</a><a href="http://catalog.example/">Downgrade</a>
      <a href="/books?private=true">Query</a><a href="/books#items">Jump</a>
      <form action="/submit"><input value="private"><button>Search</button></form>`,
      new URL("https://catalog.example/"),
    );
    expect(inventory).toMatchObject({
      title: "Catalog", headings: [{ level: 1, text: "Find books" }], buttons: ["Search"], forms: [],
      links: [
        { text: "Browse", url: "https://catalog.example/books" },
        { text: "Jump", url: "https://catalog.example/books" },
      ],
    });
    expect(JSON.stringify(inventory)).not.toContain("private");
  });
});

describe("verified site discovery", () => {
  beforeEach(() => {
    request.mockReset();
    vi.mocked(defaultResolver).mockReset().mockResolvedValue([PUBLIC_IP]);
  });

  it("reads the final page, resolves links there, and caps headers on every request", async () => {
    stubSite({
      "/": { redirect: "/quotes/start" },
      "/quotes/start": { redirect: "summary" },
      "/quotes/summary": { html: '<title>Quote summary</title><a href="/">Home</a><a href="details">Details</a>' },
      "/quotes/details": { html: "<title>Details</title>" },
    });
    const ctx = context();

    const { pages, snapshot } = await readVerifiedSite(ctx);

    expect(paths()).toEqual(["/", "/quotes/start", "/quotes/summary", "/quotes/details"]);
    expect(defaultResolver).toHaveBeenCalledTimes(4);
    for (const [options] of request.mock.calls) {
      expect(options).toMatchObject({ hostname: PUBLIC_IP, servername: "shop.example.com", method: "GET", maxHeaderSize: 32 * 1024 });
    }
    expect(pages.map(({ url }) => url)).toEqual([`${ORIGIN}/quotes/summary`, `${ORIGIN}/quotes/details`]);
    expect(snapshot.map(({ path, title }) => ({ path, title }))).toEqual([
      { path: "/quotes/summary", title: "Quote summary" },
      { path: "/quotes/details", title: "Details" },
    ]);
    expect(ctx.publish).toHaveBeenCalledTimes(2);
  });

  it.each(["https://other.example.com/page", "http://shop.example.com/page", "/page?query=1", "/delete-account"])(
    "rejects a redirect to %s before requesting it", async (redirect) => {
      stubSite({ "/": { redirect } });

      await expect(readVerifiedSite(context())).rejects.toThrow("Use its final page URL");
      expect(paths()).toEqual(["/"]);
    },
  );

  it("rechecks public addresses before connecting to a redirect", async () => {
    stubSite({ "/": { redirect: "/quotes" } });
    vi.mocked(defaultResolver).mockResolvedValueOnce([PUBLIC_IP]).mockResolvedValueOnce(["127.0.0.1"]);

    await expect(readVerifiedSite(context())).rejects.toThrow("Use its final page URL");
    expect(paths()).toEqual(["/"]);
    expect(defaultResolver).toHaveBeenCalledTimes(2);
  });

  it("stops a redirect loop and limits chains of distinct paths", async () => {
    stubSite({ "/": { redirect: "/quotes" }, "/quotes": { redirect: "/" } });
    await expect(readVerifiedSite(context())).rejects.toThrow("Use its final page URL");
    expect(paths()).toEqual(["/", "/quotes"]);

    request.mockClear();
    stubSite({
      "/": { redirect: "/one" },
      "/one": { redirect: "/two" },
      "/two": { redirect: "/three" },
      "/three": { redirect: "/four" },
    });
    await expect(readVerifiedSite(context())).rejects.toThrow("Use its final page URL");
    expect(paths()).toEqual(["/", "/one", "/two", "/three"]);
  });
});
