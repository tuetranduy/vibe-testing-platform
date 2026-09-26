import { defaultResolver } from "@platform/security";
import { checkWorkspaceConfig, type WorkspaceConfig } from "@platform/testing-engine";
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

export interface RunnerPreflightDeps {
  logger: Pick<WorkerLogger, "info" | "error">;
  /** RUNNER_WORKSPACE_DIR and RUNNER_NODE_MODULES_DIR, as the rerun stage uses them. */
  workspace: WorkspaceConfig;
}

/**
 * Start-up check for the rerun (Task 17): @playwright/test's CLI resolves from the runner's
 * node_modules (RUNNER_NODE_MODULES_DIR, or the worker's own install) and the workspace base dir
 * (RUNNER_WORKSPACE_DIR) is writable. Like the browser sandbox preflight, a failure is logged and
 * never thrown: the worker keeps serving runs, but every rerun ends ERRORED (criteria fall back to
 * their exploration evidence) until it is fixed. It does not launch the rerun's browser: a missing
 * browser or an unusable Chromium sandbox is logged by the first rerun.
 */
export async function preflightRunner(deps: RunnerPreflightDeps): Promise<boolean> {
  try {
    await checkWorkspaceConfig(deps.workspace);
    deps.logger.info({ workspaceDir: deps.workspace.baseDir }, "rerun runner preflight passed");
    return true;
  } catch (err) {
    deps.logger.error(
      { err },
      "rerun runner preflight failed: the worker keeps running, but every Playwright rerun will end ERRORED (criteria fall back to exploration evidence) until this is fixed",
    );
    return false;
  }
}
