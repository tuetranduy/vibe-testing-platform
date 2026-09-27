import { defaultResolver, type Resolver } from "@platform/security";
import type { StageContext } from "@platform/testing-engine";
import type { WorkerLogger } from "../deps";
import { findFreePort, launchSandboxedBrowser, type BrowserExtension, type SandboxedBrowser } from "./browser-launcher";
import { createEgressEventReporter } from "./egress-events";
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
  logger: Pick<WorkerLogger, "warn">;
  resolve?: Resolver;
  /** e.g. the Stagehand runtime extension (supplied by `@platform/stagehand-adapter`, Ruling R9). */
  extensions?: BrowserExtension[];
  executablePath?: string;
  onNavigationBlocked?: (e: NavigationBlockEvent) => void;
  /** Every egress-proxy block (metrics); events are reported separately, deduplicated. */
  onEgressBlock?: (e: EgressBlockEvent) => void;
}

export interface RunSandbox extends SandboxedBrowser {
  proxyUrl: string;
  allowedHosts: string[];
  /** Subscribe to blocked main-frame navigations (Task 14 → `BLOCKED_BY_POLICY` step). Returns an unsubscribe. */
  onNavigationBlocked(listener: (e: NavigationBlockEvent) => void): () => void;
}

/**
 * Owns the sandbox's resources. The orchestrator abandons a stage on abort and the worker runs the
 * stage cleanups right away, possibly while we are still launching; so once teardown has started,
 * anything that finishes starting afterwards is released immediately instead of being queued.
 */
class ResourceScope {
  private readonly release: (() => Promise<void>)[] = [];
  private closing: Promise<void> | undefined;

  constructor(private readonly logger: Pick<WorkerLogger, "warn">) {}

  get closed(): boolean {
    return this.closing !== undefined;
  }

  /** Registers `fn`; if the scope is already closing, runs it now. */
  async own(fn: () => Promise<void>): Promise<void> {
    if (this.closing) {
      await this.run(fn);
      return;
    }
    this.release.push(fn);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const fn of this.release.splice(0).reverse()) await this.run(fn);
    })();
    return this.closing;
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn({ err }, "sandbox resource release failed");
    }
  }
}

export async function openRunSandbox(ctx: StageContext, deps: RunSandboxDeps): Promise<RunSandbox> {
  const allowedHosts = computeAllowedHosts(ctx.request.targetUrl, ctx.request.options.additionalAllowedHosts);
  const listeners = new Set<(e: NavigationBlockEvent) => void>();
  if (deps.onNavigationBlocked) listeners.add(deps.onNavigationBlocked);

  const scope = new ResourceScope(deps.logger);
  const close = () => scope.close();
  ctx.addCleanup(close);
  // An abort also tears down on its own, so nothing depends on the caller running cleanups.
  const onAbort = () => void close();
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const stopIfClosed = () => {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted");
    if (scope.closed) throw new Error("sandbox closed while opening");
  };

  try {
    stopIfClosed();
    const cdpPort = await findFreePort();

    const report = createEgressEventReporter({ publish: (e) => ctx.publish(e), logger: deps.logger });
    const proxy = await startEgressProxy({
      resolve: deps.resolve ?? defaultResolver,
      privateAllowlist: [...deps.privateAllowlist, `127.0.0.1:${cdpPort}`],
      onBlock: (e) => {
        deps.onEgressBlock?.(e);
        report(e);
      },
    });
    await scope.own(() => proxy.close());
    stopIfClosed();

    const browser = await launchSandboxedBrowser({
      proxyUrl: proxy.url,
      runId: ctx.runId,
      cdpPort,
      extensions: deps.extensions,
      executablePath: deps.executablePath,
      signal: ctx.signal,
    });
    await scope.own(() => browser.close());
    stopIfClosed();

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
      onError: (err) => {
        deps.logger.warn({ err, runId: ctx.runId }, "navigation guard lost; closing the sandbox");
        void close();
      },
    });
    await scope.own(() => guard.close());
    stopIfClosed();

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
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}
