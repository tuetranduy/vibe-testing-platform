import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { applySessionHygiene } from "./session-hygiene";

/**
 * Launches Chromium ourselves (spike: Stagehand v4 caveats 1–4): detached in its own process
 * group, fresh temporary profile, fixed CDP port, every connection through the egress proxy
 * (loopback included), QUIC off, WebRTC UDP only via the proxy, background networking off.
 */

export interface BrowserExtension {
  /** Absolute path of an unpacked extension. */
  dir: string;
  /** Chromium's id for it (see `computeExtensionId`). */
  id: string;
}

export interface LaunchSandboxedBrowserOptions {
  proxyUrl: string;
  runId: string;
  /** CDP port; must be the one allowlisted at the proxy as `127.0.0.1:<port>`. Defaults to a free port. */
  cdpPort?: number;
  extensions?: BrowserExtension[];
  /** Defaults to Playwright's Chromium (`chromium.executablePath()`). */
  executablePath?: string;
  launchTimeoutMs?: number;
  /** The run signal: aborting stops the launch promptly and releases everything it created. */
  signal?: AbortSignal;
}

/** Structural (plain fields) so `@platform/stagehand-adapter` can declare a matching type (Ruling R10). */
export interface SandboxedBrowser {
  /** `http://127.0.0.1:<cdpPort>` */
  cdpUrl: string;
  /** `ws://127.0.0.1:<cdpPort>/devtools/browser/<id>` */
  browserWsUrl: string;
  extensionIds: string[];
  /** The initial page, via `chromium.connectOverCDP(cdpUrl)`. */
  page: Page;
  profileDir: string;
  pid: number;
  /** Disconnects, kills the process group, deletes the profile. Idempotent. */
  close(): Promise<void>;
}

/** Chromium's id for an unpacked extension without a manifest `key`: sha256(absolute path) → a–p. */
export function computeExtensionId(dir: string): string {
  const hex = createHash("sha256").update(dir).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export async function findFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

/**
 * Chrome background features that phone home (spike caveat 4), plus speculative preconnect /
 * prefetch: those open connections to a URL's origin in parallel with (and regardless of) the
 * navigation guard's decision on the request itself.
 */
const DISABLED_FEATURES = [
  "AutofillServerCommunication",
  "CertificateTransparencyComponentUpdater",
  "DialMediaRouteProvider",
  "InterestFeedContentSuggestions",
  "LoadingPredictor",
  "MediaRouter",
  "NavigationPredictor",
  "NetworkTimeServiceQuerying",
  "NoStatePrefetch",
  "OptimizationHints",
  "PreconnectToSearch",
  "PrivacySandboxSettings4",
  "Translate",
];

/** Seeded into the fresh profile before launch. `network_prediction_options: 2` = never preload/preconnect. */
const PROFILE_PREFERENCES = {
  net: { network_prediction_options: 2 },
  download: { prompt_for_download: false },
  profile: { password_manager_enabled: false },
  credentials_enable_service: false,
  safebrowsing: { enabled: false },
  search: { suggest_enabled: false },
};

export function buildChromiumArgs(opts: {
  proxyUrl: string;
  cdpPort: number;
  profileDir: string;
  extensions: BrowserExtension[];
}): string[] {
  const args = [
    "--headless=new",
    `--user-data-dir=${opts.profileDir}`,
    `--remote-debugging-port=${opts.cdpPort}`,
    // D8: everything through the egress proxy, loopback included.
    `--proxy-server=${opts.proxyUrl}`,
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    // Chromium never resolves names itself: proxied requests don't need it; anything else fails.
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    // Background networking / phoning home.
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-component-extensions-with-background-pages",
    "--disable-client-side-phishing-detection",
    "--disable-domain-reliability",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-breakpad",
    "--metrics-recording-only",
    "--no-pings",
    "--no-service-autorun",
    "--safebrowsing-disable-auto-update",
    `--disable-features=${DISABLED_FEATURES.join(",")}`,
    // Profile / UI hygiene.
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--password-store=basic",
    "--use-mock-keychain",
    "--deny-permission-prompts",
    "--disable-notifications",
    "--disable-back-forward-cache",
    "--disable-prompt-on-repost",
    "--disable-hang-monitor",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-ipc-flooding-protection",
    "--disable-dev-shm-usage",
    "--mute-audio",
  ];
  if (opts.extensions.length > 0) {
    const dirs = opts.extensions.map((e) => e.dir).join(",");
    args.push(
      `--load-extension=${dirs}`,
      `--disable-extensions-except=${dirs}`,
      // Only these extensions may open the browser CDP WebSocket; web pages may not. Never "*".
      `--remote-allow-origins=${opts.extensions.map((e) => `chrome-extension://${e.id}`).join(",")}`,
    );
  } else {
    args.push("--disable-extensions");
  }
  args.push("about:blank");
  return args;
}

// Chromium gets only what it needs from the worker's environment (no tokens, no DB URLs).
const PASSTHROUGH_ENV = ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "FONTCONFIG_PATH"];

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASSTHROUGH_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

export async function launchSandboxedBrowser(opts: LaunchSandboxedBrowserOptions): Promise<SandboxedBrowser> {
  const proxy = new URL(opts.proxyUrl);
  if (proxy.protocol !== "http:" || proxy.hostname !== "127.0.0.1") throw new Error("proxyUrl must be http://127.0.0.1:<port>");
  const extensions = opts.extensions ?? [];
  for (const e of extensions) {
    if (!path.isAbsolute(e.dir) || e.dir.includes(",")) throw new Error(`invalid extension dir: ${e.dir}`);
    if (!/^[a-p]{32}$/.test(e.id)) throw new Error(`invalid extension id: ${e.id}`);
  }
  const { signal } = opts;
  signal?.throwIfAborted();
  const cdpPort = opts.cdpPort ?? (await findFreePort());
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const timeoutMs = opts.launchTimeoutMs ?? 30_000;
  const safeRunId = opts.runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);

  let profileDir: string | undefined;
  let proc: ChildProcess | undefined;
  let browser: Browser | undefined;
  let stderrTail = "";
  let disposed = false;

  /** Idempotent; safe to run again to catch anything created after an earlier run. */
  const teardown = async () => {
    await browser?.close().catch(() => {});
    if (proc?.pid !== undefined && proc.exitCode === null && proc.signalCode === null) {
      const child = proc;
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      try {
        process.kill(-child.pid!, "SIGKILL"); // the whole process group: browser + helpers
      } catch {
        // already gone
      }
      await Promise.race([exited, sleep(5_000)]);
    }
    proc?.stderr?.destroy();
    if (profileDir) await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  let closing: Promise<void> | undefined;
  const close = () => {
    disposed = true;
    return (closing ??= teardown());
  };
  const stopIfDisposed = () => {
    if (disposed) throw signal?.reason ?? new Error("browser launch cancelled");
  };
  const onAbort = () => void close();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    profileDir = await mkdtemp(path.join(realpathSync(os.tmpdir()), `platform-sandbox-${safeRunId}-`));
    stopIfDisposed();
    await mkdir(path.join(profileDir, "Default"));
    await writeFile(path.join(profileDir, "Default", "Preferences"), JSON.stringify(PROFILE_PREFERENCES));
    const args = buildChromiumArgs({ proxyUrl: opts.proxyUrl, cdpPort, profileDir, extensions });
    stopIfDisposed(); // no await between this check and spawn: a close() can't slip in between
    const child = spawn(opts.executablePath ?? chromium.executablePath(), args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: minimalEnv(),
    });
    proc = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4_000);
    });
    const spawnError = new Promise<never>((_, reject) => child.once("error", reject));
    spawnError.catch(() => {});

    // Wait for the CDP endpoint; fail fast if Chromium exits or the run is aborted.
    const deadline = Date.now() + timeoutMs;
    let browserWsUrl: string | undefined;
    while (!browserWsUrl) {
      stopIfDisposed();
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Chromium exited during launch: ${stderrTail.slice(-500)}`);
      if (Date.now() > deadline) throw new Error("Chromium did not expose its CDP endpoint in time");
      const version = await Promise.race([getJson<{ webSocketDebuggerUrl?: string }>(`${cdpUrl}/json/version`), spawnError]);
      const ws = version?.webSocketDebuggerUrl;
      if (ws?.startsWith(`ws://127.0.0.1:${cdpPort}/devtools/browser/`)) browserWsUrl = ws;
      else await sleep(100);
    }

    // Every requested extension must actually be running (wrong id / path → fail loudly).
    for (const { id } of extensions) {
      let found = false;
      while (!found) {
        stopIfDisposed();
        const targets = (await getJson<{ url: string }[]>(`${cdpUrl}/json/list`)) ?? [];
        found = targets.some((t) => t.url.startsWith(`chrome-extension://${id}/`));
        if (!found) {
          if (Date.now() > deadline) throw new Error(`extension ${id} did not load`);
          await sleep(100);
        }
      }
    }

    stopIfDisposed();
    browser = await chromium.connectOverCDP(cdpUrl);
    stopIfDisposed();
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chromium has no default browser context");
    await applySessionHygiene(browser, context);
    stopIfDisposed();
    const page = context.pages().find((p) => p.url() === "about:blank") ?? (await context.newPage());
    stopIfDisposed();

    return {
      cdpUrl,
      browserWsUrl,
      extensionIds: extensions.map((e) => e.id),
      page,
      profileDir,
      pid: child.pid!,
      close,
    };
  } catch (err) {
    disposed = true;
    await closing; // a concurrent close() may be mid-flight
    await teardown(); // and may have run before something above was created
    throw signal?.aborted ? (signal.reason ?? err) : err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
