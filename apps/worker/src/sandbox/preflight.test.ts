import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preflightBrowserSandbox, preflightRunner } from "./preflight";

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

describe("preflightRunner", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "runner-preflight-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("@playwright/test resolves from the runner node_modules and the workspace dir is writable → passed (logged), nothing left behind", async () => {
    const { logged, logger } = capture();
    const baseDir = path.join(dir, "runs");
    expect(await preflightRunner({ logger, workspace: { baseDir } })).toBe(true);
    expect(logged).toMatchObject([{ level: "info", msg: "rerun runner preflight passed" }]);
    expect(readdirSync(baseDir)).toEqual([]);
  });

  it("a RUNNER_NODE_MODULES_DIR without @playwright/test is logged and does not throw", async () => {
    const { logged, logger } = capture();
    const nodeModulesDir = path.join(dir, "empty-node-modules");
    expect(await preflightRunner({ logger, workspace: { baseDir: path.join(dir, "runs"), nodeModulesDir } })).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "error", msg: expect.stringContaining("rerun runner preflight failed") });
    expect((logged[0]!.obj.err as Error).message).toContain(nodeModulesDir);
  });

  it("an unwritable RUNNER_WORKSPACE_DIR is logged and does not throw", async () => {
    const { logged, logger } = capture();
    const file = path.join(dir, "a-file");
    writeFileSync(file, "");
    expect(await preflightRunner({ logger, workspace: { baseDir: file } })).toBe(false);
    expect(logged).toMatchObject([{ level: "error", msg: expect.stringContaining("rerun runner preflight failed") }]);
  });
});
