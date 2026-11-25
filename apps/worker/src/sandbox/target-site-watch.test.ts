import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { watchTargetSite, type TargetSiteEvent } from "./target-site-watch";

const PAGE = `<!doctype html><title>t</title><script>
console.log("just a log");
console.warn("a warning");
console.error("an error");
fetch("/missing");
fetch("/boom");
setTimeout(() => { throw new Error("kaboom"); }, 0);
</script>`;

let server: http.Server;
let base: string;
let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    if (req.url === "/ok") return void res.writeHead(200, { "content-type": "text/html" }).end("<p>ok</p>");
    if (req.url === "/boom") return void res.writeHead(500).end("no");
    if (req.url === "/hang") return void req.socket.destroy();
    res.writeHead(404).end("missing");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  server?.close();
});
beforeEach(async () => {
  context = await browser.newContext();
});
afterEach(async () => context?.close());

const collect = () => {
  const events: TargetSiteEvent[] = [];
  return { events, on: (e: TargetSiteEvent) => void events.push(e) };
};

describe("watchTargetSite", () => {
  it("reports console errors and warnings but not logs", async () => {
    const { events, on } = collect();
    watchTargetSite(context, on);
    const page = await context.newPage();
    await page.goto(base);
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "response")).toHaveLength(2));
    await page.waitForTimeout(100);
    // The browser's own "Failed to load resource" messages are left out: the response lines cover them.
    expect(events.filter((e) => e.kind === "console").map((e) => e.kind === "console" && [e.level, e.text])).toEqual([
      ["warning", "a warning"],
      ["error", "an error"],
    ]);
  });

  it("reports uncaught page errors with stack", async () => {
    const { events, on } = collect();
    watchTargetSite(context, on);
    const page = await context.newPage();
    await page.goto(base);
    await vi.waitFor(() => expect(events.some((e) => e.kind === "pageerror")).toBe(true));
    const err = events.find((e) => e.kind === "pageerror")!;
    expect(err).toMatchObject({ kind: "pageerror", message: expect.stringContaining("kaboom"), url: `${base}/` });
    expect(err.kind === "pageerror" && err.stack).toContain("kaboom");
  });

  it("reports failed requests and 4xx/5xx responses, not 2xx", async () => {
    const { events, on } = collect();
    watchTargetSite(context, on);
    const page = await context.newPage();
    await page.goto(base);
    await page.evaluate(() => fetch("/hang").catch(() => {}));
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "response" || e.kind === "requestfailed")).toHaveLength(3));
    const net = events.filter((e) => e.kind === "response" || e.kind === "requestfailed");
    expect(net).toEqual(
      expect.arrayContaining([
        { kind: "response", method: "GET", url: `${base}/missing`, status: 404 },
        { kind: "response", method: "GET", url: `${base}/boom`, status: 500 },
        expect.objectContaining({ kind: "requestfailed", method: "GET", url: `${base}/hang` }),
      ]),
    );
    expect(events.some((e) => e.kind === "response" && e.status < 400)).toBe(false);
  });

  it("follows pages opened later", async () => {
    const first = await context.newPage();
    await first.goto(`${base}/ok`);
    const { events, on } = collect();
    watchTargetSite(context, on);
    await first.goto(`${base}/nope`);
    const later = await context.newPage();
    await later.goto(`${base}/later-missing`);
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "response")).toHaveLength(2));
  });

  it("dispose stops reporting", async () => {
    const { events, on } = collect();
    const dispose = watchTargetSite(context, on);
    dispose();
    const page = await context.newPage();
    await page.goto(base);
    await page.waitForTimeout(200);
    expect(events).toEqual([]);
  });

  it("a throwing handler never breaks the page", async () => {
    watchTargetSite(context, () => {
      throw new Error("handler broke");
    });
    const page = await context.newPage();
    await expect(page.goto(base)).resolves.toBeTruthy();
  });
});

describe("logTargetSite", () => {
  it("writes target_site lines, serious ones at warn", async () => {
    const { logTargetSite } = await import("./run-sandbox");
    const got: [string, Record<string, unknown>, string | undefined][] = [];
    const logger = {
      info: (o: object, m?: string) => void got.push(["info", o as Record<string, unknown>, m]),
      warn: (o: object, m?: string) => void got.push(["warn", o as Record<string, unknown>, m]),
    };
    logTargetSite(logger, "run_1", { kind: "console", level: "warning", text: "w", url: "u" });
    logTargetSite(logger, "run_1", { kind: "console", level: "error", text: "e", url: "u" });
    logTargetSite(logger, "run_1", { kind: "response", method: "GET", url: "u", status: 404 });
    logTargetSite(logger, "run_1", { kind: "response", method: "GET", url: "u", status: 503 });
    logTargetSite(logger, "run_1", { kind: "pageerror", message: "m", url: "u" });
    expect(got.map(([level]) => level)).toEqual(["info", "warn", "info", "warn", "warn"]);
    expect(got[2]).toEqual(["info", { runId: "run_1", source: "target_site", kind: "response", method: "GET", url: "u", status: 404 }, "Tested site answered 404: GET u"]);
    expect(got.map(([, , msg]) => msg)).toEqual([
      "Tested site console warning: w",
      "Tested site console error: e",
      "Tested site answered 404: GET u",
      "Tested site answered 503: GET u",
      "Tested site page error: m",
    ]);
    logTargetSite(logger, "run_1", { kind: "requestfailed", method: "POST", url: "u2", failure: "net::ERR_CONNECTION_REFUSED" });
    expect(got.at(-1)![2]).toBe("Tested site request failed: POST u2 (net::ERR_CONNECTION_REFUSED)");
  });
});
