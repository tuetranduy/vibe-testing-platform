import { defaultResolver, type Resolver } from "@platform/security";
import type { StageContext } from "@platform/testing-engine";
import { findFreePort, launchSandboxedBrowser, type BrowserExtension, type SandboxedBrowser } from "./browser-launcher";
import { startEgressProxy, type EgressBlockEvent } from "./egress-proxy";
import { computeAllowedHosts, installNavigationGuard, type NavigationBlockEvent } from "./navigation-guard";

/**
 * One run's browser sandbox (Ruling R12 convenience for the explore stage): egress proxy →
 * Chromium → navigation guard, with teardown registered on the stage so cancel, deadline and
 * crash paths release everything (Section 2.7).
 */

export interface RunSandboxDeps {
  /** The worker's TARGET_PRIVATE_ALLOWLIST. The browser's own CDP loopback entry is added here. */
  privateAllowlist: string[];
  resolve?: Resolver;
  /** e.g. the Stagehand runtime extension (supplied by `@platform/stagehand-adapter`, Ruling R9). */
  extensions?: BrowserExtension[];
  executablePath?: string;
  onNavigationBlocked?: (e: NavigationBlockEvent) => void;
}

export interface RunSandbox extends SandboxedBrowser {
  proxyUrl: string;
  allowedHosts: string[];
  /** Subscribe to blocked main-frame navigations (Task 14 → `BLOCKED_BY_POLICY` step). Returns an unsubscribe. */
  onNavigationBlocked(listener: (e: NavigationBlockEvent) => void): () => void;
}

function hostPort(e: EgressBlockEvent): string {
  return e.host.includes(":") ? `[${e.host}]:${e.port}` : `${e.host}:${e.port}`;
}

export async function openRunSandbox(ctx: StageContext, deps: RunSandboxDeps): Promise<RunSandbox> {
  const allowedHosts = computeAllowedHosts(ctx.request.targetUrl, ctx.request.options.additionalAllowedHosts);
  const listeners = new Set<(e: NavigationBlockEvent) => void>();
  if (deps.onNavigationBlocked) listeners.add(deps.onNavigationBlocked);

  const release: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      for (const fn of release.splice(0).reverse()) await fn().catch(() => {});
    })());
  ctx.addCleanup(close);

  const checkAborted = () => {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted");
  };

  try {
    checkAborted();
    const cdpPort = await findFreePort();

    // One egress.blocked event per host:port + reason, so a page can't flood the timeline.
    // Chromium's own background services are denied silently: the site under test didn't cause them.
    const reported = new Set<string>();
    const proxy = await startEgressProxy({
      resolve: deps.resolve ?? defaultResolver,
      privateAllowlist: [...deps.privateAllowlist, `127.0.0.1:${cdpPort}`],
      onBlock: (e) => {
        if (e.reason === "BACKGROUND_SERVICE_DENIED") return;
        const key = `${hostPort(e)}|${e.reason}`;
        if (reported.has(key)) return;
        reported.add(key);
        void ctx
          .publish({
            type: "egress.blocked",
            message: `Blocked network access to ${hostPort(e)} (${e.reason})`,
            payload: { host: e.host, reason: e.reason },
          })
          .catch(() => {});
      },
    });
    release.push(() => proxy.close());
    checkAborted();

    const browser = await launchSandboxedBrowser({
      proxyUrl: proxy.url,
      runId: ctx.runId,
      cdpPort,
      extensions: deps.extensions,
      executablePath: deps.executablePath,
    });
    release.push(() => browser.close());
    checkAborted();

    const guard = await installNavigationGuard(browser, {
      allowedHosts,
      privateAllowlist: deps.privateAllowlist, // not the CDP entry: pages must never navigate there
      onBlock: (e) => {
        for (const l of listeners) {
          try {
            l(e);
          } catch {
            // listener errors are the caller's problem
          }
        }
      },
      // Fail closed: an unguarded browser is torn down.
      onError: () => void close(),
    });
    release.push(() => guard.close());
    checkAborted();

    return {
      ...browser,
      proxyUrl: proxy.url,
      allowedHosts,
      onNavigationBlocked(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
