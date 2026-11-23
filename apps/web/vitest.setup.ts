import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { testMe } from "./test/me";

// Radix measures controls and popup content. JSDOM does not perform layout.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollIntoView ??= function () {};
  HTMLElement.prototype.hasPointerCapture ??= function () { return false; };
  HTMLElement.prototype.releasePointerCapture ??= function () {};
}

// The signed-in user comes from test/me.ts instead of a fetch of /api/v1/auth/me.
vi.mock("./lib/me", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/me")>();
  return {
    ...actual,
    useMe: () => testMe.current,
    loadMe: async () => {
      if (!testMe.current) throw new Error("no user");
      return testMe.current;
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  testMe.current = null;
});
