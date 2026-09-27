import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GeneratedTest } from "@platform/contracts";

const exec = promisify(execFile);
const fromHere = createRequire(import.meta.url);
// @playwright/test is the testing engine's dependency (what the rerun runs against).
const fromEngine = createRequire(fromHere.resolve("@platform/testing-engine"));
const dirOf = (req: NodeJS.Require, name: string) => path.dirname(realpathSync(req.resolve(`${name}/package.json`)));

/** "" when the generated workspace passes `tsc --noEmit` against @playwright/test; else tsc's output. */
export async function typecheckGeneratedTest(test: Pick<GeneratedTest, "source" | "helpersSource" | "dataJson">): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-generated-tsc-"));
  try {
    writeFileSync(path.join(dir, "run.spec.ts"), test.source);
    writeFileSync(path.join(dir, "helpers.ts"), test.helpersSource);
    writeFileSync(path.join(dir, "run-data.json"), test.dataJson);
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noUncheckedIndexedAccess: true,
          resolveJsonModule: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["node"],
        },
        files: ["run.spec.ts", "helpers.ts"],
      }),
    );
    mkdirSync(path.join(dir, "node_modules", "@playwright"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "@types"), { recursive: true });
    symlinkSync(dirOf(fromEngine, "@playwright/test"), path.join(dir, "node_modules", "@playwright", "test"));
    symlinkSync(dirOf(fromHere, "@types/node"), path.join(dir, "node_modules", "@types", "node"));
    const tsc = path.join(dirOf(fromHere, "typescript"), "bin", "tsc");
    return await exec(process.execPath, [tsc, "-p", path.join(dir, "tsconfig.json")]).then(
      () => "",
      (err: { stdout?: string; stderr?: string }) => `${err.stdout ?? ""}${err.stderr ?? ""}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
