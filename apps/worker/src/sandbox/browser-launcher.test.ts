import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { launchSandboxedBrowser, releaseBrowser } from "./browser-launcher";

const exited = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe("releaseBrowser", () => {
  it("a hung browser.close() is bounded: the process group is still killed and the profile removed", async () => {
    const profileDir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "platform-sandbox-test-"));
    const proc = spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise((r) => proc.once("spawn", r));
    const browser = { close: () => new Promise<void>(() => {}) }; // never settles

    try {
      const started = Date.now();
      await releaseBrowser({ browser, proc, profileDir }, { closeTimeoutMs: 100 });

      expect(Date.now() - started).toBeLessThan(3_000);
      expect(proc.signalCode).toBe("SIGKILL");
      expect(exited(proc.pid!)).toBe(true);
      expect(existsSync(profileDir)).toBe(false);
    } finally {
      proc.kill("SIGKILL");
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("graceful: false (a browser abandoned mid-launch) skips the disconnect and kills straight away", async () => {
    const proc = spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise((r) => proc.once("spawn", r));
    let closeCalls = 0;
    const browser = {
      close: () => {
        closeCalls++;
        return new Promise<void>(() => {});
      },
    };
    try {
      await releaseBrowser({ browser, proc }, { graceful: false });
      expect(closeCalls).toBe(0);
      expect(proc.signalCode).toBe("SIGKILL");
    } finally {
      proc.kill("SIGKILL");
    }
  });
});

describe("launchSandboxedBrowser", () => {
  it("a browser that exits during launch rejects with the launch error and leaves no profile behind", async () => {
    const runId = `exit-${process.pid}-${Date.now()}`;
    const leftovers = () => readdirSync(realpathSync(os.tmpdir())).filter((f) => f.startsWith(`platform-sandbox-${runId}-`));
    await expect(
      launchSandboxedBrowser({ proxyUrl: "http://127.0.0.1:9", runId, executablePath: "/usr/bin/false", launchTimeoutMs: 5_000 }),
    ).rejects.toThrow(/Chromium exited during launch/);
    expect(leftovers()).toEqual([]);
  });
});
