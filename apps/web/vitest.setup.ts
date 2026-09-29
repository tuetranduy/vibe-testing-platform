import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { testMe } from "./test/me";

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
