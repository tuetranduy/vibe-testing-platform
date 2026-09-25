import type { Browser, BrowserContext, Page } from "playwright-core";

/**
 * Session hygiene for the sandboxed browser: no downloads, no JS dialogs left open
 * (they would stall exploration), and file choosers are intercepted and never given files.
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
}
