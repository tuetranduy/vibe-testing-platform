import { execFile } from "node:child_process";
import { DiscoveryInputSchema, DiscoveryResultSchema } from "@platform/contracts";
import type { AutonomousDiscoveryPort } from "@platform/testing-engine";

const MAX_OUTPUT_BYTES = 64 * 1024;

/** The launcher owns the isolated container. Its stdin/stdout carry one request and one response. */
export function createBrowserUseDiscoveryClient(launcher: string): AutonomousDiscoveryPort {
  return {
    async discover(input, { signal }) {
      signal.throwIfAborted();
      const request = DiscoveryInputSchema.parse(input);
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(launcher, [], {
          signal,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: { PATH: process.env.PATH },
          encoding: "utf8",
        }, (error, stdout) => {
          // The child error can contain raw stdout or stderr. Keep it out of worker logs.
          if (error) reject(new Error("Browser Use discovery launcher failed"));
          else resolve(stdout);
        });
        child.stdin?.on("error", () => {
          // The launcher may exit before reading stdin. Its completion drives fallback.
        });
        child.stdin?.end(JSON.stringify(request) + "\n");
      });
      signal.throwIfAborted();
      let json: unknown;
      try {
        json = JSON.parse(output);
      } catch {
        throw new Error("Browser Use discovery returned invalid JSON");
      }
      const parsed = DiscoveryResultSchema.safeParse(json);
      if (!parsed.success) throw new Error("Browser Use discovery returned an invalid result");
      const result = parsed.data;
      if (result.runId !== request.runId) throw new Error("Browser Use discovery returned a mismatched run");
      return result;
    },
  };
}
