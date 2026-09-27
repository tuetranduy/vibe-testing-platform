import { readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import { resolveStagehandExtensionDir } from "@platform/stagehand-adapter";
import { describe, expect, it } from "vitest";
import { computeExtensionId } from "../../apps/worker/src/sandbox/browser-launcher";
import { preflightBrowserSandbox } from "../../apps/worker/src/sandbox/preflight";

const profiles = () => readdirSync(realpathSync(os.tmpdir())).filter((n) => n.startsWith("platform-sandbox-preflight-"));

describe("worker start-up sandbox preflight (real Chromium + the Stagehand extension)", () => {
  it("launches and closes the sandboxed Chromium once, logs success, and leaves no profile behind", async () => {
    // A profile an earlier, interrupted process left behind is not this preflight's.
    const before = new Set(profiles());
    const logged: { level: string; msg?: string }[] = [];
    const at = (level: string) => (_obj: object, msg?: string) => void logged.push({ level, msg });
    const ok = await preflightBrowserSandbox({
      logger: { info: at("info"), error: at("error") },
      resolveExtension: () => {
        const dir = resolveStagehandExtensionDir();
        return { dir, id: computeExtensionId(dir) };
      },
    });
    expect(logged).toEqual([{ level: "info", msg: "browser sandbox preflight passed" }]);
    expect(ok).toBe(true);
    expect(profiles().filter((n) => !before.has(n))).toEqual([]);
  });
});
