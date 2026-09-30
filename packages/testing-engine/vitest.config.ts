import { transform } from "esbuild";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Transpile TypeScript as the worker runs it (`tsx`: esbuild with `keepNames`), as the root config does: a named
 * function inside a callback sent to the browser (`locator.evaluate(fn)`) is then wrapped in `__name(...)`, which
 * the page doesn't define, and fails here as it would in the worker.
 */
const tsxTransform = (): Plugin => ({
  name: "tsx-keep-names",
  enforce: "pre",
  async transform(code, id) {
    if (!/\.[cm]?tsx?$/.test(id.split("?")[0]!) || id.includes("/node_modules/")) return null;
    const out = await transform(code, { loader: "ts", format: "esm", target: "node22", keepNames: true, sourcemap: true, sourcefile: id });
    return { code: out.code, map: out.map };
  },
});

export default defineConfig({
  plugins: [tsxTransform()],
  test: { include: ["src/**/*.test.ts"], exclude: ["**/*.live.test.ts", "**/node_modules/**"], testTimeout: 30_000 },
});
