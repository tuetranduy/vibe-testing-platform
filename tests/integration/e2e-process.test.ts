import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { launchProcess } from "../e2e/support/process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-process-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("E2E stack processes (review focus 5)", () => {
  it("stop() ends the process running the entry even when it ignores SIGTERM (e.g. a worker draining a job)", async () => {
    const pidFile = path.join(dir, "pid");
    const entry = path.join(dir, "stubborn.ts");
    writeFileSync(entry, `import { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);

    const launched = launchProcess({ name: "stubborn", entry, cwd: ROOT, env: { PATH: process.env.PATH ?? "" }, logDir: dir, killAfterMs: 500 });
    await expect.poll(() => readFileSync(pidFile, "utf8").trim().length > 0, { timeout: 15_000 }).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);

    await launched.stop();

    await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
  });
});
