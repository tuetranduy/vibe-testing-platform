import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig keeps `jsx: preserve` for Next; tests need React's automatic runtime.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)) } },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", ".next/**"],
  },
});
