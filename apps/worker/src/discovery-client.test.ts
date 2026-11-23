import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserUseDiscoveryClient } from "./discovery-client";

const input = { schemaVersion: "discovery.v1", runId: "run_fixture", targetUrl: "http://localhost:4178/" } as const;
const response = {
  schemaVersion: input.schemaVersion,
  runId: input.runId,
  status: "COMPLETED",
  candidates: [{
    title: "Browse a category",
    goal: "Open the category and read the listed products.",
    rationale: "The catalog links to categories.",
    relevantPaths: ["/catalog"],
    expectedBehavior: ["The listing displays products in the selected category."],
    negativeCases: [],
  }],
};
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "browser-use-launcher-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function launcher(code: string) {
  const file = path.join(dir, "launcher");
  writeFileSync(file, `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
  return createBrowserUseDiscoveryClient(file);
}

describe("Browser Use launcher protocol", () => {
  it("sends only the typed request to a credentialless process and accepts its typed result", async () => {
    const discover = launcher(`
      let input = "";
      process.stdin.setEncoding("utf8").on("data", (data) => input += data);
      process.stdin.on("end", () => {
        if (Object.keys(process.env).some((key) => !["PATH", "__CF_USER_TEXT_ENCODING"].includes(key))) process.exit(1);
        if (input !== ${JSON.stringify(JSON.stringify(input) + "\n")}) process.exit(2);
        process.stdout.write(${JSON.stringify(JSON.stringify(response))});
      });
    `);
    await expect(discover.discover(input, { signal: AbortSignal.timeout(5000) })).resolves.toEqual(response);
  });

  it.each([
    ["unexpected run", { ...response, runId: "run_other" }],
    ["unexpected schema", { ...response, schemaVersion: "discovery.v2" }],
    ["nonlocal paths", { ...response, candidates: [{ ...response.candidates[0], relevantPaths: ["//offsite.example/path"] }] }],
    ["query values", { ...response, candidates: [{ ...response.candidates[0], relevantPaths: ["/catalog?secret=private"] }] }],
    ["a partial result", { ...response, status: "PARTIAL" }],
  ])("rejects %s before the result can reach the survey", async (_label, invalid) => {
    const discover = launcher(`process.stdout.write(${JSON.stringify(JSON.stringify(invalid))});`);
    await expect(discover.discover(input, { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
  });

  it("bounds the child output and does not return raw errors", async () => {
    const discover = launcher('process.stdout.write("sensitive".repeat(10000));');
    await expect(discover.discover(input, { signal: AbortSignal.timeout(5000) })).rejects.toThrow("Browser Use discovery launcher failed");
  });

  it("aborts a launcher that does not finish within the stage budget", async () => {
    const discover = launcher("setInterval(() => {}, 1000);");
    await expect(discover.discover(input, { signal: AbortSignal.timeout(150) })).rejects.toThrow("Browser Use discovery launcher failed");
  });
});
