import path from "node:path";
import { describe, expect, it } from "vitest";
import { preflightBrowserSandbox } from "./preflight";

function capture() {
  const logged: { level: string; obj: Record<string, unknown>; msg?: string }[] = [];
  const at = (level: string) => (obj: object, msg?: string) => void logged.push({ level, obj: obj as Record<string, unknown>, msg });
  return { logged, logger: { info: at("info"), warn: at("warn"), error: at("error") } };
}

const extension = { dir: path.resolve("/nonexistent/stagehand-extension"), id: "a".repeat(32) };

describe("preflightBrowserSandbox", () => {
  it("Chromium that cannot start is logged (with its stderr, in the log only) and does not throw", async () => {
    const { logged, logger } = capture();
    const ok = await preflightBrowserSandbox({ logger, resolveExtension: () => extension, executablePath: "/usr/bin/false", launchTimeoutMs: 5_000 });
    expect(ok).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "error", msg: expect.stringContaining("browser sandbox preflight failed") });
    expect((logged[0]!.obj.err as Error).message).toMatch(/Chromium exited during launch/);
  });

  it("a missing Stagehand extension is logged and does not throw", async () => {
    const { logged, logger } = capture();
    const ok = await preflightBrowserSandbox({
      logger,
      resolveExtension: () => {
        throw new Error("Stagehand extension not found");
      },
    });
    expect(ok).toBe(false);
    expect(logged).toMatchObject([{ level: "error", obj: { err: expect.objectContaining({ message: "Stagehand extension not found" }) } }]);
  });
});
