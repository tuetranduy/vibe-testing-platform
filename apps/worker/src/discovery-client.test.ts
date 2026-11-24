import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoveryPortError } from "@platform/testing-engine";
import { createBrowserUseDiscoveryClient, createDiscoveryServiceClient, discoverySignature } from "./discovery-client";

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
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

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
    const discover = launcher('process.stdout.write("sensitive".repeat(40000));');
    await expect(discover.discover(input, { signal: AbortSignal.timeout(5000) })).rejects.toThrow("Browser Use discovery launcher failed");
  });

  it("aborts a launcher that does not finish within the stage budget", async () => {
    const discover = launcher("setInterval(() => {}, 1000);");
    await expect(discover.discover(input, { signal: AbortSignal.timeout(150) })).rejects.toThrow("Browser Use discovery launcher failed");
  });
});

it("cancels a remote job with a fresh signed request after the survey signal fires", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => {
    calls.push(init);
    return init.method === "POST"
      ? Response.json({ jobId: input.runId, agentSteps: 1 }, { status: 202 })
      : Response.json({ jobId: input.runId, agentSteps: 1 });
  }));
  const remote = createDiscoveryServiceClient("http://127.0.0.1:4600", "local-test-token-for-remote-cancellation");
  const controller = new AbortController();
  await expect(remote.discover(input, {
    signal: controller.signal,
    onProgress: async () => controller.abort(),
  })).rejects.toThrow();
  expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
  expect(calls[1]?.signal?.aborted).toBe(false);
  const [post, cancel] = calls.map((call) => new Headers(call.headers).get("authorization"));
  expect(cancel).toMatch(/^Bearer \d{10}\.[a-f\d]{32}\.[a-f\d]{64}$/);
  // Every request carries its own single-use nonce.
  expect(post?.split(".")[1]).not.toBe(cancel?.split(".")[1]);
});

it("signs the body, idempotency key and nonce exactly as the job service verifies them", () => {
  // The same golden vector is asserted in apps/browser-use-discovery/tests/test_service.py.
  expect(discoverySignature(
    "golden-vector-token-of-32-characters!!", "POST", "/internal/v1/discoveries", "1764000000",
    "0123456789abcdef0123456789abcdef", "run_fixture:discovery.v1", '{"runId":"run_fixture"}',
  )).toBe("428bee0cd490a7181fa39d355cd20400df9d0d9064d22a3d44f23f3ec1fcdbba");
});

it("reports a failed cancellation of an accepted job, but not of a job the broker never accepted", async () => {
  const onCleanupError = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => init.method === "POST"
    ? Response.json({ jobId: input.runId, agentSteps: 0 }, { status: 202 })
    : new Response(null, { status: 500 })));
  const remote = createDiscoveryServiceClient("http://127.0.0.1:4600", "local-test-token-for-cleanup-failures", { onCleanupError });
  // The status poll fails, so the worker abandons the accepted job and its cancellation is refused.
  await expect(remote.discover(input, { signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({ failure: "unavailable" });
  await vi.waitFor(() => expect(onCleanupError).toHaveBeenCalledTimes(1));

  onCleanupError.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection refused"); }));
  const down = createDiscoveryServiceClient("http://127.0.0.1:4600", "local-test-token-for-cleanup-failures", { onCleanupError });
  await expect(down.discover(input, { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(onCleanupError).not.toHaveBeenCalled();
});

it("backs off after broker errors while treating backpressure as an ordinary fallback", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 429 }));
  vi.stubGlobal("fetch", fetch);
  const remote = createDiscoveryServiceClient("http://127.0.0.1:4600", "local-test-broker-cooldown-token");
  const context = { signal: AbortSignal.timeout(5000) };
  for (let index = 0; index < 3; index++) {
    await expect(remote.discover(input, context)).rejects.toMatchObject({ failure: "busy" });
  }
  expect(fetch).toHaveBeenCalledTimes(3);

  fetch.mockImplementation(async () => new Response(null, { status: 401 }));
  await expect(remote.discover(input, context)).rejects.toThrow("job was unavailable");
  await expect(remote.discover(input, context)).rejects.toThrow("job was unavailable");
  await expect(remote.discover(input, context)).rejects.toThrow("broker is cooling down");
  await expect(remote.discover(input, context)).rejects.toBeInstanceOf(DiscoveryPortError);
  expect(fetch).toHaveBeenCalledTimes(5);
});
