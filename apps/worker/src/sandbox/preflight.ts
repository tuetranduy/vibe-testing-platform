import { defaultResolver } from "@platform/security";
import type { WorkerLogger } from "../deps";
import { findFreePort, launchSandboxedBrowser, type BrowserExtension } from "./browser-launcher";
import { startEgressProxy } from "./egress-proxy";

export interface SandboxPreflightDeps {
  logger: Pick<WorkerLogger, "info" | "error">;
  /** The Stagehand runtime extension (throws when it cannot be found). */
  resolveExtension: () => BrowserExtension;
  executablePath?: string;
  launchTimeoutMs?: number;
}

/**
 * Start-up check for the real engine: resolves the Stagehand extension and launches + closes the
 * sandboxed Chromium once (egress proxy included, same flags as a run). A failure is logged — with
 * Chromium's stderr, which only the log ever sees — and never thrown: the worker keeps serving
 * analyze/plan, and exploring runs end ERRORED / BROWSER_PROVIDER until it is fixed.
 */
export async function preflightBrowserSandbox(deps: SandboxPreflightDeps): Promise<boolean> {
  const started = Date.now();
  let closeProxy: (() => Promise<void>) | undefined;
  try {
    const extension = deps.resolveExtension();
    const cdpPort = await findFreePort();
    const proxy = await startEgressProxy({ resolve: defaultResolver, privateAllowlist: [`127.0.0.1:${cdpPort}`], onBlock: () => {} });
    closeProxy = () => proxy.close();
    const browser = await launchSandboxedBrowser({
      proxyUrl: proxy.url,
      runId: "preflight",
      cdpPort,
      extensions: [extension],
      ...(deps.executablePath ? { executablePath: deps.executablePath } : {}),
      ...(deps.launchTimeoutMs ? { launchTimeoutMs: deps.launchTimeoutMs } : {}),
    });
    await browser.close();
    deps.logger.info({ durationMs: Date.now() - started }, "browser sandbox preflight passed");
    return true;
  } catch (err) {
    deps.logger.error(
      { err },
      "browser sandbox preflight failed: the worker keeps running, but exploring runs will end ERRORED / BROWSER_PROVIDER until this is fixed",
    );
    return false;
  } finally {
    await closeProxy?.().catch(() => {});
  }
}
