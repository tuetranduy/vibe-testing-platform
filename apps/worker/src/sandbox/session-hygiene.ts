import { BROWSER_VIEWPORT } from "@platform/testing-engine";
import type { Browser, BrowserContext, Page } from "playwright-core";

/**
 * Session hygiene for the sandboxed browser: no downloads, no JS dialogs left open
 * (they would stall exploration), file choosers are intercepted and never given files, and every page is full HD.
 */
export async function applySessionHygiene(browser: Browser, context: BrowserContext): Promise<void> {
  // Playwright's connectOverCDP sets "allowAndName" for the default context; override it.
  // The session stays attached: the setting is reset when the session that made it detaches.
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });

  context.on("dialog", (dialog) => {
    void dialog.dismiss().catch(() => {});
  });

  // A `filechooser` listener makes Playwright intercept the chooser; we never call setFiles.
  const interceptFileChooser = (page: Page) => {
    page.on("filechooser", () => {});
  };
  for (const page of context.pages()) interceptFileChooser(page);
  context.on("page", interceptFileChooser);

  for (const page of context.pages()) await fullHd(context, page);
  context.on("page", (page) => void fullHd(context, page).catch(() => {}));
}

/**
 * The page is a full-HD screen filled by the page (1920×1080 viewport and screen, scale 1), as in a browser in full
 * screen. New headless Chromium keeps room for browser UI in its window, by a different amount on the first tab than
 * on later ones, so the size is set per page. The session stays attached: the override ends when it detaches.
 */
async function fullHd(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const { width, height } = BROWSER_VIEWPORT;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
}
