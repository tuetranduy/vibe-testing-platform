/** The size every test's browser runs at: exploration, the rerun and their videos (full HD, device scale 1). */
export const BROWSER_VIEWPORT = { width: 1920, height: 1080 } as const;

/**
 * Chromium flags for a full-HD screen and a window of that size: without them headless Chromium opens 800×600 on an
 * 800×600 screen. Playwright's headless shell (the rerun) gives the page the whole window; full Chromium's new headless
 * mode (exploration) keeps room for browser UI until its window is made full screen (the worker's browser launcher).
 */
export const BROWSER_WINDOW_ARGS: readonly string[] = [
  `--window-size=${BROWSER_VIEWPORT.width},${BROWSER_VIEWPORT.height}`,
  `--screen-info={${BROWSER_VIEWPORT.width}x${BROWSER_VIEWPORT.height}}`,
  "--force-device-scale-factor=1",
];
