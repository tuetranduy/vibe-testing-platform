import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          exclude: ["**/*.live.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "live",
          include: ["tests/integration/**/*.live.test.ts", "packages/**/src/**/*.live.test.ts"],
          testTimeout: 180_000,
        },
      },
    ],
  },
});
