import { transform } from "esbuild";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Transpile TypeScript the way tsx does when the worker runs (`tsx src/main.ts`): esbuild with
 * `keepNames`, which wraps named functions in a module-level `__name(...)` helper. A function sent
 * into the browser (`locator.evaluate(fn)`) is serialised with that call but not the helper, so it
 * fails there with "__name is not defined"; Vite's default transform hides that.
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
  test: {
    projects: [
      {
        plugins: [tsxTransform()],
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          exclude: ["**/*.live.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        plugins: [tsxTransform()],
        test: {
          name: "live",
          include: ["tests/integration/**/*.live.test.ts", "packages/**/src/**/*.live.test.ts"],
          testTimeout: 180_000,
        },
      },
    ],
  },
});
