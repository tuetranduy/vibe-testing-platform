import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localBrowser, Stagehand, type Action, type Page as StagehandPage } from "@browserbasehq/stagehand";
import type { Frame, Page, Request as PwRequest } from "playwright-core";
import { BrowserProviderError, CancelledError, EngineError } from "@platform/contracts";
import type { ZodType } from "zod";
import {
  ExplorerSessionClosedError,
  NavigationBlockedError,
  type ActResult,
  type BrowserExplorer,
  type ExplorerSession,
  type ExplorerStartInput,
  type ExtractResult,
  type LlmStepUsage,
  type NavigateResult,
  type NavigationBlock,
  type ObservedElement,
  type ObserveResult,
} from "./browser-explorer";
import { createClientLlmBridge, type ClientLlmBridge, type StructuredLlm } from "./client-llm";
import { guardrailSystemPrompt } from "./guardrails";
import { DEFAULT_TELEMETRY_ENDPOINT } from "./telemetry";

/**
 * Stagehand v4 explorer (spike GO): Stagehand's MV3 runtime is preloaded into the sandboxed
 * Chromium, and we connect with `localBrowser.connect({ cdpUrl, extensionId })`. Stagehand only
 * discovers and acts; navigation, screenshots and secret fills are ours (Playwright).
 */

export { DEFAULT_TELEMETRY_ENDPOINT, STAGEHAND_TELEMETRY_HOST } from "./telemetry";

const EXTENSION_SUBPATH = path.join("node_modules", "@browserbasehq", "stagehand", "dist", "extension");

/**
 * The Stagehand runtime extension directory (Ruling R9), real path (Chromium derives the extension
 * id from the path it loads): `STAGEHAND_EXTENSION_DIRECTORY_PATH` if set, else the installed
 * package's `dist/extension`. The worker computes the id with its `computeExtensionId`.
 */
export function resolveStagehandExtensionDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STAGEHAND_EXTENSION_DIRECTORY_PATH?.trim();
  let dir: string | undefined;
  if (override) {
    dir = path.resolve(override);
  } else {
    for (let at = path.dirname(fileURLToPath(import.meta.url)); ; at = path.dirname(at)) {
      const candidate = path.join(at, EXTENSION_SUBPATH);
      if (existsSync(path.join(candidate, "manifest.json"))) {
        dir = candidate;
        break;
      }
      if (path.dirname(at) === at) break;
    }
  }
  if (!dir || !existsSync(path.join(dir, "manifest.json"))) {
    throw new Error("Stagehand extension not found (set STAGEHAND_EXTENSION_DIRECTORY_PATH or install @browserbasehq/stagehand)");
  }
  return realpathSync(dir);
}

export interface StagehandCacheOption {
  enabled: boolean;
  threshold?: number;
}

export interface StagehandExplorerOptions {
  llm: StructuredLlm;
  /** OTLP endpoint for Stagehand's in-browser traces; must end with /v1/traces. */
  telemetryEndpoint?: string;
  /** Stagehand's server-side cache (Browserbase only; always DISABLED locally, Ruling R21). */
  cache?: StagehandCacheOption;
  /** Which loaded extension is Stagehand's; defaults to the only one loaded. */
  extensionId?: string;
  /**
   * Receives Stagehand runtime logs, redacted with the run redactor. Stagehand's own logging is
   * always "off": at any other level it writes every log (data included) unredacted to stderr
   * before `onLog` runs (dist/index.mjs `handleStagehandNotification`). With "off", neither
   * happens; failures reach callers as exceptions instead.
   */
  logger?: { warn(obj: object, msg?: string): void };
  domSettleTimeoutMs?: number;
  /** Per act/observe/extract call. */
  operationTimeoutMs?: number;
  navigationTimeoutMs?: number;
  /** How long to wait for Stagehand to connect and initialise. */
  connectTimeoutMs?: number;
  maxTokens?: number;
}

const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
/** After ERR_BLOCKED_BY_CLIENT, how long to wait for the guard's event (it may land just after). */
const BLOCK_EVENT_GRACE_MS = 500;
/** How long a blocked navigation may take to commit Chromium's error page. */
const ERROR_PAGE_COMMIT_TIMEOUT_MS = 3_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new ExplorerSessionClosedError("exploration aborted");
}

/**
 * Infrastructure failures (Stagehand runtime, CDP, Playwright) become BrowserProviderError
 * (`BROWSER_PROVIDER`), keeping the original as `cause`. Typed engine errors (model provider,
 * contract, deadline), cancellation, policy blocks, closed-session misuse and Zod validation
 * errors pass through unchanged.
 */
export function toExplorerError(err: unknown, what: string): unknown {
  if (
    err instanceof EngineError ||
    err instanceof CancelledError ||
    err instanceof NavigationBlockedError ||
    err instanceof ExplorerSessionClosedError ||
    (err as { name?: unknown } | null)?.name === "ZodError"
  ) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new BrowserProviderError(`${what} failed: ${message.split("\n")[0]!.slice(0, 500)}`, { cause: err });
}

/** Rejects as soon as the signal fires; `work` keeps running (its owner is torn down separately). */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => {});
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function targetIdOf(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

function toObserved(a: Action): ObservedElement {
  return { selector: a.selector, description: a.description, method: a.method ?? null, arguments: a.arguments ?? [] };
}

function toAction(e: ObservedElement): Action {
  return {
    selector: e.selector,
    description: e.description,
    ...(e.method ? { method: e.method } : {}),
    ...(e.arguments.length > 0 ? { arguments: e.arguments } : {}),
  };
}

type CacheStatus = "HIT" | "MISS" | "DISABLED" | string;

class StagehandExplorerSession implements ExplorerSession {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly blocks: NavigationBlock[] = [];
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    readonly page: Page,
    private readonly sh: Stagehand,
    private readonly shPage: StagehandPage,
    private readonly bridge: ClientLlmBridge,
    private readonly signal: AbortSignal,
    private readonly opts: Required<Pick<StagehandExplorerOptions, "operationTimeoutMs" | "navigationTimeoutMs">>,
    onNavigationBlocked: ((listener: (e: NavigationBlock) => void) => () => void) | undefined,
  ) {
    this.unsubscribe = onNavigationBlocked?.((e) => {
      this.blocks.push(e);
    });
  }

  /**
   * Serializes operations so model usage and navigation blocks belong to exactly one of them, and
   * maps failures: the abort reason when the run signal fired, else `toExplorerError`.
   */
  private run<T>(what: string, fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.closed) throw new ExplorerSessionClosedError("explorer session is closed");
      if (this.signal.aborted) throw abortReason(this.signal);
      this.bridge.takeUsage();
      this.bridge.takeError();
      this.blocks.length = 0;
      try {
        return await raceAbort(fn(), this.signal);
      } catch (err) {
        if (this.signal.aborted) throw abortReason(this.signal);
        throw toExplorerError(err, what);
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private stepUsage(cache: CacheStatus | undefined): LlmStepUsage | null {
    const u = this.bridge.takeUsage();
    const cacheHit = cache === "HIT" ? true : cache === "MISS" ? false : null;
    if (u.calls === 0 && cacheHit === null) return null;
    return { model: this.bridge.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheHit };
  }

  /**
   * Runs one Stagehand call as a bridge operation, so a model call it leaves running when its
   * timeout gives up is aborted rather than holding up the next step's (KI-020). If it fails, a
   * model error raised inside it (by our bridge) is thrown instead of Stagehand's wrapper, so typed
   * engine errors (cancelled, provider, contract) survive.
   */
  private async stagehand<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await this.bridge.operation(call);
    } catch (err) {
      throw this.bridge.takeError() ?? err;
    }
  }

  private takeBlocks(): NavigationBlock[] {
    return this.blocks.splice(0);
  }

  /**
   * After the guard blocks a main-frame navigation, Chromium commits `chrome-error://chromewebdata/`
   * asynchronously, and a navigation started before that commit gets interrupted by it. Watch for
   * that commit from before the navigation starts (the URL may already be a previous error page).
   */
  private watchErrorCommit(): { settle(): Promise<void>; dispose(): void } {
    let committed = false;
    let resolveCommit!: () => void;
    const commit = new Promise<void>((r) => (resolveCommit = r));
    const onNavigated = (frame: Frame) => {
      if (frame === this.page.mainFrame() && frame.url().startsWith("chrome-error:")) {
        committed = true;
        resolveCommit();
      }
    };
    this.page.on("framenavigated", onNavigated);
    return {
      settle: async () => {
        if (!committed) await Promise.race([commit, sleep(ERROR_PAGE_COMMIT_TIMEOUT_MS)]);
      },
      dispose: () => {
        this.page.off("framenavigated", onNavigated);
      },
    };
  }

  navigate(url: string): Promise<NavigateResult> {
    return this.run("navigate", async () => {
      const errorPage = this.watchErrorCommit();
      try {
        try {
          await this.page.goto(url, { waitUntil: "load", timeout: this.opts.navigationTimeoutMs }).catch(async (err: unknown) => {
            // A late error-page commit from a navigation blocked before this call (e.g. a script
            // redirect between steps) interrupts ours: go again, once.
            if (!/interrupted by another navigation to "chrome-error:/.test(err instanceof Error ? err.message : String(err))) throw err;
            this.takeBlocks();
            return this.page.goto(url, { waitUntil: "load", timeout: this.opts.navigationTimeoutMs });
          });
        } catch (err) {
          const blocked = /ERR_BLOCKED_BY_CLIENT/.test(err instanceof Error ? err.message : String(err));
          if (blocked && this.blocks.length === 0) {
            for (let waited = 0; waited < BLOCK_EVENT_GRACE_MS && this.blocks.length === 0; waited += 50) await sleep(50);
          }
          const [first] = this.takeBlocks();
          if (blocked || first) {
            await errorPage.settle();
            throw new NavigationBlockedError(first?.url ?? url, first?.reason ?? null);
          }
          throw err;
        }
        const [first] = this.takeBlocks();
        if (first) {
          await errorPage.settle();
          throw new NavigationBlockedError(first.url, first.reason);
        }
        return { url: this.page.url() };
      } finally {
        errorPage.dispose();
      }
    });
  }

  observe(instruction: string): Promise<ObserveResult> {
    return this.run("Stagehand observe", async () => {
      const res = await this.stagehand(() => this.sh.observe(instruction, { page: this.shPage, timeout: this.opts.operationTimeoutMs }));
      return { elements: res.data.map(toObserved), llm: this.stepUsage(res.metadata.cache.status) };
    });
  }

  act(instruction: string): Promise<ActResult> {
    return this.run("Stagehand act", () => this.doAct(instruction));
  }

  actOn(element: ObservedElement): Promise<ActResult> {
    return this.run("Stagehand act", () => this.doAct(toAction(element)));
  }

  /**
   * Tracks main-frame navigation requests started while an action runs, so a navigation the action
   * triggered (a link, a form post) is attributed to that action even if it finishes after
   * Stagehand returns: waits for them to finish, and for a blocked one, for the guard's event and
   * Chromium's error page.
   */
  private watchNavigations(): { settle(): Promise<void>; dispose(): void } {
    const pending = new Set<PwRequest>();
    let blocked = false;
    const isMainNav = (r: PwRequest) => r.isNavigationRequest() && r.frame() === this.page.mainFrame();
    const onRequest = (r: PwRequest) => {
      if (isMainNav(r)) pending.add(r);
    };
    const onFinished = (r: PwRequest) => {
      pending.delete(r);
    };
    const onFailed = (r: PwRequest) => {
      if (pending.delete(r) && /ERR_BLOCKED_BY_CLIENT/.test(r.failure()?.errorText ?? "")) blocked = true;
    };
    const errorPage = this.watchErrorCommit();
    this.page.on("request", onRequest);
    this.page.on("requestfinished", onFinished);
    this.page.on("requestfailed", onFailed);
    return {
      settle: async () => {
        const deadline = Date.now() + this.opts.navigationTimeoutMs;
        while (pending.size > 0 && Date.now() < deadline) await sleep(50);
        if (blocked && this.blocks.length === 0) {
          for (let waited = 0; waited < BLOCK_EVENT_GRACE_MS && this.blocks.length === 0; waited += 50) await sleep(50);
        }
        if (blocked || this.blocks.length > 0) await errorPage.settle();
      },
      dispose: () => {
        this.page.off("request", onRequest);
        this.page.off("requestfinished", onFinished);
        this.page.off("requestfailed", onFailed);
        errorPage.dispose();
      },
    };
  }

  private async doAct(what: string | Action): Promise<ActResult> {
    const options = { page: this.shPage, timeout: this.opts.operationTimeoutMs };
    const navigations = this.watchNavigations();
    let res;
    try {
      res = await this.stagehand(() => (typeof what === "string" ? this.sh.act(what, options) : this.sh.act(what, options)));
      await navigations.settle();
    } finally {
      navigations.dispose();
    }
    // Stagehand reports some failures as success: false; a model error behind one is the real cause.
    const modelError = this.bridge.takeError();
    if (!res.data.success && modelError) throw modelError;
    const first = res.data.actions[0];
    return {
      success: res.data.success,
      message: res.data.message,
      element: first ? toObserved(first) : null,
      navigationBlocks: this.takeBlocks(),
      llm: this.stepUsage(res.metadata.cache.status),
    };
  }

  extract<T>(instruction: string, schema: ZodType<T>): Promise<ExtractResult<T>> {
    return this.run("Stagehand extract", async () => {
      const res = await this.stagehand(() => this.sh.extract(instruction, schema, { page: this.shPage, timeout: this.opts.operationTimeoutMs }));
      // Stagehand parses with the schema already; parse again so T is exactly the caller's output type.
      return { data: schema.parse(res.data), llm: this.stepUsage(res.metadata.cache.status) };
    });
  }

  screenshot(): Promise<Buffer> {
    return this.run("screenshot", async () => Buffer.from(await this.page.screenshot({ type: "png" })));
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      this.unsubscribe?.();
      // Stagehand's close detaches its runtime; the browser handle is never closed here
      // (`StagehandBrowser.close()` would send Browser.close to the sandbox's Chromium).
      await withTimeout(this.sh.close(), CLOSE_TIMEOUT_MS, "Stagehand close").catch(() => {});
    })();
    return this.closing;
  }
}

export class StagehandExplorer implements BrowserExplorer {
  constructor(private readonly opts: StagehandExplorerOptions) {}

  async start(input: ExplorerStartInput): Promise<ExplorerSession> {
    const { page: handle, signal } = input;
    if (signal.aborted) throw abortReason(signal);
    const extensionId = this.opts.extensionId ?? (handle.extensionIds.length === 1 ? handle.extensionIds[0] : undefined);
    if (!extensionId || !handle.extensionIds.includes(extensionId)) {
      throw new BrowserProviderError("The sandboxed browser must have the Stagehand extension loaded (pass extensionId when several are loaded)");
    }

    const bridge = createClientLlmBridge({
      llm: this.opts.llm,
      runId: input.runId,
      signal,
      redact: input.redact,
      deadlineAt: input.deadlineAt ?? null,
      maxTokens: this.opts.maxTokens,
    });
    const cache = this.opts.cache?.enabled
      ? this.opts.cache.threshold !== undefined
        ? { threshold: this.opts.cache.threshold }
        : true
      : false;
    const logger = this.opts.logger;

    let sh: Stagehand | undefined;
    const connect = async () => {
      const browser = await localBrowser.connect({ cdpUrl: handle.cdpUrl, extensionId });
      sh = await Stagehand.create({
        browser,
        model: bridge.client,
        systemPrompt: guardrailSystemPrompt({ allowDestructive: input.allowDestructive }),
        telemetry: { traces: { endpoint: this.opts.telemetryEndpoint ?? DEFAULT_TELEMETRY_ENDPOINT, headers: {} } },
        logging: {
          level: "off", // see StagehandExplorerOptions.logger: any other level writes unredacted to stderr
          format: "json",
          // Defensive: never reached while the level is "off"; redacted if a Stagehand version ever calls it.
          onLog: (log) => {
            const safe = input.redact({ message: log.message.slice(0, 300), data: log.data }) as { message: string; data: unknown };
            logger?.warn({ stagehandLevel: log.level, data: safe.data }, `stagehand: ${safe.message}`);
          },
        },
        cache,
        ...(this.opts.domSettleTimeoutMs !== undefined ? { domSettleTimeoutMs: this.opts.domSettleTimeoutMs } : {}),
      });
      const targetId = await targetIdOf(handle.page);
      const shPage = (await browser.context.pages()).find((p) => p.pageId === targetId);
      if (!shPage) throw new BrowserProviderError("Stagehand does not see the sandbox page");
      await browser.context.setActivePage(shPage);
      return { sh, shPage };
    };

    const connecting = connect();
    try {
      const connected = await raceAbort(
        withTimeout(connecting, this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, "Stagehand connect"),
        signal,
      );
      return new StagehandExplorerSession(
        handle.page,
        connected.sh,
        connected.shPage,
        bridge,
        signal,
        {
          operationTimeoutMs: this.opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
          navigationTimeoutMs: this.opts.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
        },
        handle.onNavigationBlocked?.bind(handle),
      );
    } catch (err) {
      // Detach Stagehand whenever it finishes (or failed half-way); the sandbox closes the browser itself.
      connecting.then(
        (c) => c.sh.close(),
        () => sh?.close(),
      ).catch(() => {});
      if (signal.aborted) throw abortReason(signal);
      throw toExplorerError(err, "Stagehand connect");
    }
  }
}
