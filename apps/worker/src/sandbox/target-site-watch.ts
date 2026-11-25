import type { BrowserContext, ConsoleMessage, Page, Request, Response } from "playwright-core";

/** What the tested website did wrong in the sandboxed browser (admin run logs, 2026-11-25). No bodies. */
export type TargetSiteEvent =
  | { kind: "console"; level: "error" | "warning"; text: string; url: string }
  | { kind: "pageerror"; message: string; stack?: string; url: string }
  | { kind: "requestfailed"; method: string; url: string; failure: string }
  | { kind: "response"; method: string; url: string; status: number };

/** Events reported per page; past it a page's events are dropped silently (a page logging in a loop). */
const MAX_EVENTS_PER_PAGE = 1000;
/** The browser's own pages, never the site's. */
const OWN_PAGE = /^(chrome-extension|devtools|chrome):/;
/** Chromium's own console line for a failed load: the `response` / `requestfailed` events already report it. */
const LOAD_FAILURE = /^Failed to load resource:/;
/** A missing favicon is the browser asking, not the site failing. */
const FAVICON = /\/favicon\.ico(\?|$)/;

/**
 * Reports the tested site's console errors and warnings, uncaught page errors, failed requests and 4xx/5xx
 * responses, for every page of the context, now and later. `on` is never allowed to throw into Playwright.
 * Returns the function that stops reporting.
 */
export function watchTargetSite(context: BrowserContext, on: (event: TargetSiteEvent) => void): () => void {
  let active = true;
  const detachers: (() => void)[] = [];

  const attach = (page: Page) => {
    let count = 0;
    const emit = (event: TargetSiteEvent) => {
      if (!active || count >= MAX_EVENTS_PER_PAGE) return;
      if (OWN_PAGE.test(safeUrl(page))) return;
      count += 1;
      try {
        on(event);
      } catch {
        // a log line is never the run's problem
      }
    };
    const onConsole = (msg: ConsoleMessage) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      if (LOAD_FAILURE.test(msg.text())) return;
      emit({ kind: "console", level: type, text: msg.text(), url: safeUrl(page) });
    };
    const onPageError = (err: Error) => {
      emit({ kind: "pageerror", message: err.message, ...(err.stack ? { stack: err.stack } : {}), url: safeUrl(page) });
    };
    const onRequestFailed = (req: Request) => {
      if (FAVICON.test(req.url())) return;
      emit({ kind: "requestfailed", method: req.method(), url: req.url(), failure: req.failure()?.errorText ?? "failed" });
    };
    const onResponse = (res: Response) => {
      const status = res.status();
      if (status < 400 || FAVICON.test(res.url())) return;
      emit({ kind: "response", method: res.request().method(), url: res.url(), status });
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("requestfailed", onRequestFailed);
    page.on("response", onResponse);
    detachers.push(() => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
    });
  };

  for (const page of context.pages()) attach(page);
  context.on("page", attach);
  return () => {
    active = false;
    context.off("page", attach);
    for (const detach of detachers.splice(0)) detach();
  };
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}
