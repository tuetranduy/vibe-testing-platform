import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { startDemoShop, type RunningDemoShop } from "@platform/demo-shop";
import type { EventDraft, StageContext } from "@platform/testing-engine";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { computeExtensionId } from "../../apps/worker/src/sandbox/browser-launcher";
import type { NavigationBlockEvent } from "../../apps/worker/src/sandbox/navigation-guard";
import { openRunSandbox, type RunSandbox, type RunSandboxDeps } from "../../apps/worker/src/sandbox/run-sandbox";

// A 1x1 transparent PNG.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

/** Same shape as `Resolver` from @platform/security (not a root dependency). */
type Resolver = (hostname: string) => Promise<string[]>;

interface Fixture {
  port: number;
  hits: string[];
  close(): Promise<void>;
}

/** Extra fixture pages, reached as static.shop.test (an allowed subdomain) and cdn.test (off-domain). */
async function startFixtureServer(): Promise<Fixture> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? "";
    hits.push(`${host}${req.url}`);
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body>${body}</body></html>`);
    };
    switch (req.url) {
      case "/pixel.png":
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PIXEL);
      case "/subresource":
        return html(`<h1>Mixed hosts</h1><img id="cdn" src="http://cdn.test:${port()}/pixel.png">`);
      case "/download-page":
        return html(`<a id="dl" href="/download">Get file</a>`);
      case "/download":
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="report.bin"' });
        return res.end("SANDBOX-DOWNLOAD-PAYLOAD");
      case "/upload":
        return html(`<input id="file" type="file">`);
      default:
        return html(`<h1>fixture ${req.url}</h1>`);
    }
  });
  const port = () => (server.address() as net.AddressInfo).port;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: port(),
    hits,
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
    // Unknown names fail: nothing in this suite may reach the real internet.
    if (!hit) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return hit;
  }) as Resolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

interface FakeStage {
  ctx: StageContext;
  events: EventDraft[];
  runCleanups(): Promise<void>;
}

function fakeStage(targetUrl: string, additionalAllowedHosts: string[] = []): FakeStage {
  const events: EventDraft[] = [];
  const cleanups: (() => Promise<void> | void)[] = [];
  const ctx = {
    runId: "run_sandbox_it",
    tenantId: "tenant_default",
    request: { targetUrl, options: { additionalAllowedHosts } },
    signal: new AbortController().signal,
    publish: async (e: EventDraft) => {
      events.push(e);
    },
    addCleanup: (fn: () => Promise<void> | void) => {
      cleanups.push(fn);
    },
  } as unknown as StageContext;
  return {
    ctx,
    events,
    runCleanups: async () => {
      for (const fn of cleanups.splice(0).reverse()) await fn();
    },
  };
}

function commandLineOf(pid: number): string {
  return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
}

function sandboxProcesses(): string[] {
  const out = execFileSync("ps", ["-ax", "-ww", "-o", "pid=,command="], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes("platform-sandbox-"));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("browser sandbox (real Chromium, demo shop)", () => {
  let shop: RunningDemoShop;
  let fixture: Fixture;
  let target: string;
  let resolver: Resolver & { calls: string[] };
  let deps: RunSandboxDeps;
  let stage: FakeStage | undefined;
  let sandbox: RunSandbox | undefined;
  let navBlocks: NavigationBlockEvent[];

  beforeAll(async () => {
    shop = await startDemoShop({ port: 0, host: "127.0.0.1" });
    fixture = await startFixtureServer();
    target = `http://shop.test:${shop.port}/`;
  });

  afterAll(async () => {
    await shop.close();
    await fixture.close();
    expect(sandboxProcesses()).toEqual([]);
  });

  async function open(extra: Partial<RunSandboxDeps> = {}): Promise<RunSandbox> {
    resolver = fakeResolver({ "shop.test": ["127.0.0.1"], "static.shop.test": ["127.0.0.1"], "cdn.test": ["127.0.0.1"] });
    deps = {
      resolve: resolver,
      // Stand-ins for TARGET_PRIVATE_ALLOWLIST: the local fixtures, by name only.
      privateAllowlist: [`shop.test:${shop.port}`, `static.shop.test:${fixture.port}`, `cdn.test:${fixture.port}`],
      ...extra,
    };
    stage = fakeStage(target);
    navBlocks = [];
    sandbox = await openRunSandbox(stage.ctx, deps);
    sandbox.onNavigationBlocked((e) => navBlocks.push(e));
    return sandbox;
  }

  afterEach(async () => {
    await stage?.runCleanups();
    stage = undefined;
    sandbox = undefined;
  });

  const egressEvents = () => (stage?.events ?? []).filter((e) => e.type === "egress.blocked");

  it("launches Chromium through the egress proxy with hardened flags and a fresh temporary profile", async () => {
    const sb = await open();
    const cmd = commandLineOf(sb.pid);

    expect(cmd).toContain(`--proxy-server=${sb.proxyUrl}`);
    expect(cmd).toContain("--proxy-bypass-list=<-loopback>");
    expect(cmd).toContain("--disable-quic");
    expect(cmd).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(cmd).toContain("--headless=new");
    expect(cmd).toContain("--disable-background-networking");
    expect(cmd).toContain(`--user-data-dir=${sb.profileDir}`);
    expect(cmd).toContain("--disable-extensions");
    expect(cmd).not.toContain("--remote-allow-origins");
    expect(cmd).not.toContain("--no-sandbox");

    expect(sb.profileDir.startsWith(realpathSync(os.tmpdir()))).toBe(true);
    expect(path.basename(sb.profileDir)).toMatch(/^platform-sandbox-run_sandbox_it-/);
    expect(existsSync(sb.profileDir)).toBe(true);
    expect(sb.extensionIds).toEqual([]);
    expect(sb.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await sb.page.goto(target);
    expect(await sb.page.title()).toContain("Home");
  });

  it("the demo shop's metadata image never loads and egress.blocked is published once", async () => {
    const sb = await open();
    await sb.page.goto(`${target}egress-probe`);

    const loaded = await sb.page.evaluate(() => {
      const img = document.querySelector("img");
      return img ? img.complete && img.naturalWidth > 0 : null;
    });
    expect(loaded).toBe(false);
    const metadata = () => egressEvents().filter((e) => e.type === "egress.blocked" && e.payload.host === "169.254.169.254");
    await expect.poll(() => metadata().length).toBe(1);
    // Reloading re-triggers the block but not another event.
    await sb.page.reload();
    expect(metadata()).toHaveLength(1);
    expect(metadata()[0]).toEqual({
      type: "egress.blocked",
      message: "Blocked network access to 169.254.169.254:80 (NON_PUBLIC_ADDRESS)",
      payload: { host: "169.254.169.254", reason: "NON_PUBLIC_ADDRESS" },
    });
  });

  it("loopback traffic also goes through the proxy (only allowlisted host:port pairs pass)", async () => {
    const sb = await open();
    await sb.page.goto(target);
    const before = fixture.hits.length;

    // The fixture server listens on 127.0.0.1:<port>, but only its *names* are allowlisted.
    const outcome = await sb.page.evaluate(async (url) => {
      try {
        await fetch(url, { mode: "no-cors" });
        return "fetched";
      } catch {
        return "failed";
      }
    }, `http://127.0.0.1:${fixture.port}/secret`);

    // no-cors hides the status, so prove it via the proxy's decision and the server's log.
    void outcome;
    await expect.poll(() => egressEvents().map((e) => e.payload)).toContainEqual({ host: "127.0.0.1", reason: "NON_PUBLIC_ADDRESS" });
    expect(fixture.hits.slice(before)).toEqual([]);
  });

  it("an open redirect to a private address is blocked as TARGET_BLOCKED_BY_POLICY", async () => {
    const sb = await open();
    await expect(sb.page.goto(`${target}redirect?to=http://10.0.0.1/`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    expect(navBlocks).toEqual([{ url: "http://10.0.0.1/", reason: "TARGET_BLOCKED_BY_POLICY" }]);
  });

  it("main-frame navigation to https://example.org is aborted as OFF_DOMAIN_NAVIGATION before any connection", async () => {
    const sb = await open();
    // Clicking the demo shop's external link…
    await sb.page.goto(`${target}external`);
    await sb.page.getByTestId("external-link").click();
    await expect.poll(() => navBlocks.length).toBe(1);
    expect(navBlocks[0]).toEqual({ url: "https://example.org/", reason: "OFF_DOMAIN_NAVIGATION" });

    // …and a direct main-frame navigation are both stopped.
    await sb.page.waitForURL("chrome-error://chromewebdata/");
    await expect(sb.page.goto("https://example.org/")).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    expect(navBlocks).toEqual([
      { url: "https://example.org/", reason: "OFF_DOMAIN_NAVIGATION" },
      { url: "https://example.org/", reason: "OFF_DOMAIN_NAVIGATION" },
    ]);

    // The guard stopped it in the browser: the proxy never resolved or saw example.org.
    expect(resolver.calls).not.toContain("example.org");
    expect(egressEvents().filter((e) => e.message.includes("example.org"))).toEqual([]);
  });

  it("subresources from other hosts still load; only main-frame navigation to them is blocked", async () => {
    const sb = await open();
    await sb.page.goto(`http://static.shop.test:${fixture.port}/subresource`); // allowed: subdomain of the target
    await sb.page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>("#cdn");
      return !!img && img.complete;
    });
    expect(await sb.page.evaluate(() => document.querySelector<HTMLImageElement>("#cdn")?.naturalWidth)).toBe(1);
    expect(fixture.hits).toContain(`cdn.test:${fixture.port}/pixel.png`);

    await expect(sb.page.goto(`http://cdn.test:${fixture.port}/pixel.png`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    expect(navBlocks).toEqual([{ url: `http://cdn.test:${fixture.port}/pixel.png`, reason: "OFF_DOMAIN_NAVIGATION" }]);
  });

  it("window.open popups follow the same navigation guard", async () => {
    const sb = await open();
    await sb.page.goto(target);
    const context = sb.page.context();

    const offDomain = context.waitForEvent("page");
    await sb.page.evaluate(() => void window.open("https://example.org/"));
    await offDomain;
    await expect.poll(() => navBlocks).toContainEqual({ url: "https://example.org/", reason: "OFF_DOMAIN_NAVIGATION" });

    const viaRedirect = context.waitForEvent("page");
    await sb.page.evaluate((u) => void window.open(u), `${target}redirect?to=http://10.0.0.2/`);
    await viaRedirect;
    await expect.poll(() => navBlocks).toContainEqual({ url: "http://10.0.0.2/", reason: "TARGET_BLOCKED_BY_POLICY" });

    const allowed = context.waitForEvent("page");
    await sb.page.evaluate((u) => void window.open(u), `${target}products`);
    const popup = await allowed;
    await popup.waitForLoadState();
    expect(popup.url()).toBe(`${target}products`);
    expect(navBlocks).toHaveLength(2);
  });

  it("downloads are denied", async () => {
    const sb = await open();
    await sb.page.goto(`http://static.shop.test:${fixture.port}/download-page`);
    const download = sb.page.waitForEvent("download");
    await sb.page.click("#dl");
    expect(await (await download).failure()).toBe("canceled");
  });

  it("file choosers are intercepted and never given files", async () => {
    const sb = await open();
    await sb.page.goto(`http://static.shop.test:${fixture.port}/upload`);
    const chooser = sb.page.waitForEvent("filechooser");
    await sb.page.click("#file");
    await chooser;
    expect(await sb.page.evaluate(() => document.querySelector<HTMLInputElement>("#file")?.files?.length)).toBe(0);
  });

  it("JavaScript dialogs are auto-dismissed", async () => {
    const sb = await open();
    await sb.page.goto(target);
    const results = await sb.page.evaluate(() => {
      const confirmed = window.confirm("Delete everything?");
      const prompted = window.prompt("Your name?", "default");
      window.alert("hello");
      return { confirmed, prompted, afterAlert: true };
    });
    expect(results).toEqual({ confirmed: false, prompted: null, afterAlert: true });
  });

  it("close() kills the browser process group, closes the proxy and deletes the profile; cleanup is idempotent", async () => {
    const sb = await open();
    const { pid, profileDir, cdpUrl, proxyUrl } = sb;
    await sb.page.goto(target);
    expect(isAlive(pid)).toBe(true);

    await sb.close();

    expect(isAlive(pid)).toBe(false);
    expect(existsSync(profileDir)).toBe(false);
    expect(sandboxProcesses().filter((l) => l.includes(profileDir))).toEqual([]);
    await expect(fetch(`${cdpUrl}/json/version`)).rejects.toThrow();
    await expect(fetch(proxyUrl)).rejects.toThrow();
    // The cleanup registered with the stage runs again in afterEach; it must be a no-op.
    await stage?.runCleanups();
  });

  describe("with an extension", () => {
    let extDir: string;

    beforeAll(() => {
      extDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sandbox-ext-")));
      writeFileSync(
        path.join(extDir, "manifest.json"),
        JSON.stringify({ manifest_version: 3, name: "sandbox-test-ext", version: "1.0.0", background: { service_worker: "sw.js" } }),
      );
      writeFileSync(path.join(extDir, "sw.js"), "self.addEventListener('install', () => self.skipWaiting());\n");
    });

    afterAll(() => {
      rmSync(extDir, { recursive: true, force: true });
    });

    it("loads it, and only that extension's origin may open the browser CDP websocket", async () => {
      const id = computeExtensionId(extDir);
      const sb = await open({ extensions: [{ dir: extDir, id }] });
      const cmd = commandLineOf(sb.pid);

      expect(sb.extensionIds).toEqual([id]);
      expect(cmd).toContain(`--load-extension=${extDir}`);
      expect(cmd).toContain(`--disable-extensions-except=${extDir}`);
      expect(cmd).toContain(`--remote-allow-origins=chrome-extension://${id}`);
      expect(cmd).not.toContain("--remote-allow-origins=*");

      const probe = (ws: string) =>
        new Promise<string>((resolve) => {
          const s = new WebSocket(ws);
          s.onopen = () => {
            s.close();
            resolve("OPEN");
          };
          s.onerror = () => resolve("REJECTED");
        });

      // A web page cannot drive the browser over CDP.
      await sb.page.goto(target);
      expect(await sb.page.evaluate(probe, sb.browserWsUrl)).toBe("REJECTED");

      // The extension can (its socket goes through the proxy's CDP loopback allowlist entry).
      const context = sb.page.context();
      const worker =
        context.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`)) ??
        (await context.waitForEvent("serviceworker", (w) => w.url().startsWith(`chrome-extension://${id}/`)));
      expect(await worker.evaluate(probe, sb.browserWsUrl)).toBe("OPEN");
    });
  });
});
