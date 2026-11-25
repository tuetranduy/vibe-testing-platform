import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { DiscoveryInputSchema, DiscoveryResultSchema } from "@platform/contracts";
import { DiscoveryPortError, type AutonomousDiscoveryPort } from "@platform/testing-engine";
import { z } from "zod";

const MAX_OUTPUT_BYTES = 256 * 1024;
const JOBS = "/internal/v1/discoveries";
const BROKER_COOLDOWN_MS = 15_000;
const AgentStepsSchema = z.number().int().nonnegative();
const JobSchema = z.strictObject({
  jobId: z.string(),
  agentSteps: AgentStepsSchema,
  result: DiscoveryResultSchema.optional(),
});

function validateResult(value: unknown, runId: string) {
  const parsed = DiscoveryResultSchema.safeParse(value);
  if (!parsed.success) throw new DiscoveryPortError("invalid_result", "Browser Use discovery returned an invalid result");
  if (parsed.data.runId !== runId) throw new DiscoveryPortError("invalid_result", "Browser Use discovery returned a mismatched run");
  return parsed.data;
}

/**
 * The canonical string the job service verifies (apps/browser-use-discovery/src/discovery_service/service.py):
 * the signature covers the method, path, time, a single-use nonce, the idempotency key and the body's SHA-256.
 */
export function discoverySignature(
  token: string, method: string, path: string, timestamp: string, nonce: string, idempotencyKey: string, body: string,
): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", token)
    .update(`v2\n${method}\n${path}\n${timestamp}\n${nonce}\n${idempotencyKey}\n${digest}`)
    .digest("hex");
}

/** The launcher owns the isolated container. Its stdin/stdout carry one request and one response. */
export function createBrowserUseDiscoveryClient(launcher: string): AutonomousDiscoveryPort {
  return {
    async discover(input, { signal, onProgress }) {
      signal.throwIfAborted();
      const request = DiscoveryInputSchema.parse(input);
      let publishing = Promise.resolve();
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(launcher, [], {
          signal,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: { PATH: process.env.PATH },
          encoding: "utf8",
        }, (error, stdout) => {
          // The child error can contain raw stdout or stderr. Keep it out of worker logs.
          if (error) reject(new DiscoveryPortError("unavailable", "Browser Use discovery launcher failed"));
          else resolve(stdout);
        });
        if (child.stderr && onProgress) {
          createInterface({ input: child.stderr }).on("line", (line) => {
            if (line.length > 512 || signal.aborted) return;
            let value: Record<string, unknown>;
            try { value = JSON.parse(line); } catch { return; }
            if (value?.event !== "discovery.progress" || value.runId !== request.runId) return;
            const progress = AgentStepsSchema.safeParse(value.agentSteps);
            if (progress.success && progress.data > 0) publishing = publishing.then(() => onProgress(progress.data)).catch(() => {});
          });
        }
        child.stdin?.on("error", () => {
          // The launcher may exit before reading stdin. Its completion drives fallback.
        });
        child.stdin?.end(JSON.stringify(request) + "\n");
      });
      await publishing;
      signal.throwIfAborted();
      let json: unknown;
      try {
        json = JSON.parse(output);
      } catch {
        throw new DiscoveryPortError("invalid_result", "Browser Use discovery returned invalid JSON");
      }
      return validateResult(json, request.runId);
    },
  };
}

async function readJob(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new DiscoveryPortError("invalid_result", "Browser Use discovery did not return a body");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) throw new DiscoveryPortError("invalid_result", "Browser Use discovery response exceeded its limit");
      chunks.push(value);
    }
    let json: unknown;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new DiscoveryPortError("invalid_result", "Browser Use discovery returned invalid JSON");
    }
    const job = JobSchema.safeParse(json);
    if (!job.success) throw new DiscoveryPortError("invalid_result", "Browser Use discovery returned an invalid job");
    return job.data;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export interface DiscoveryServiceClientOptions {
  /** A job the worker abandoned could not be confirmed cancelled (the broker still ends it at its own budget). */
  onCleanupError?: () => void;
}

/** Polls the local trusted broker with single-use, body-bound request signatures and bounded I/O. */
export function createDiscoveryServiceClient(origin: string, token: string, options: DiscoveryServiceClientOptions = {}): AutonomousDiscoveryPort {
  let failedRequests = 0;
  let unavailableUntil = 0;
  function send(method: string, path: string, signal: AbortSignal, init?: { body: string; key: string }) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const signature = discoverySignature(token, method, path, timestamp, nonce, init?.key ?? "", init?.body ?? "");
    return fetch(new URL(path, origin), {
      method,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      redirect: "error",
      headers: {
        authorization: `Bearer ${timestamp}.${nonce}.${signature}`,
        ...(init && { "content-type": "application/json", "idempotency-key": init.key }),
      },
      body: init?.body,
    });
  }

  return {
    async discover(input, { signal, onProgress }) {
      signal.throwIfAborted();
      if (Date.now() < unavailableUntil) throw new DiscoveryPortError("unavailable", "Browser Use discovery broker is cooling down");
      const request = DiscoveryInputSchema.parse(input);
      const jobPath = `${JOBS}/${request.runId}`;
      const create = { body: JSON.stringify(request), key: `${request.runId}:${request.schemaVersion}` };
      let completed = false;
      let shouldCancel = true;
      let busy = false;
      let accepted = false;
      let steps = 0;
      try {
        // One bounded retry on a transport error; the idempotency key makes a duplicate submit return the same job.
        let response = await send("POST", JOBS, signal, create).catch(() => send("POST", JOBS, signal, create));
        if (response.status !== 202) {
          shouldCancel = response.status >= 500;
          busy = response.status === 429;
          await response.body?.cancel();
          throw busy
            ? new DiscoveryPortError("busy", "Browser Use discovery broker is busy")
            : new DiscoveryPortError("unavailable", "Browser Use discovery job was unavailable");
        }
        accepted = true;
        for (;;) {
          const job = await readJob(response);
          if (job.jobId !== request.runId) throw new DiscoveryPortError("invalid_result", "Browser Use discovery returned a mismatched job");
          if (job.agentSteps > steps) {
            steps = job.agentSteps;
            await onProgress?.(steps);
          }
          if (job.result) {
            const result = validateResult(job.result, request.runId);
            completed = true;
            failedRequests = 0;
            return result;
          }
          await delay(750, undefined, { signal });
          response = await send("GET", jobPath, signal);
          if (!response.ok) {
            await response.body?.cancel();
            throw new DiscoveryPortError("unavailable", "Browser Use discovery status was unavailable");
          }
        }
      } catch (error) {
        if (!signal.aborted && !busy && ++failedRequests >= 2) {
          unavailableUntil = Date.now() + BROKER_COOLDOWN_MS;
          failedRequests = 0;
        }
        throw error;
      } finally {
        if (!completed && shouldCancel) {
          // Separate signal: the stage's signal has usually already fired. Send cleanup
          // without delaying the normal survey, even if the broker is unavailable.
          void send("DELETE", jobPath, AbortSignal.timeout(5000))
            .then(async (response) => {
              await response.body?.cancel();
              // 404: the job already expired or never started. Anything else unexpected is a cleanup error.
              if (accepted && !response.ok && response.status !== 404) options.onCleanupError?.();
            })
            .catch(() => { if (accepted) options.onCleanupError?.(); });
        }
      }
    },
  };
}
