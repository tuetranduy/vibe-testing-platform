import type { Database } from "@platform/db";
import { defaultResolver } from "@platform/security";
import type { ArtifactStorage } from "@platform/storage";
import type { EvidenceStore, RunTestStageDeps, StageContext } from "@platform/testing-engine";
import { storeArtifact, type ArtifactRetention } from "./artifacts";
import type { WorkerLogger } from "./deps";
import { countEgressBlock, type WorkerMetrics } from "./metrics";
import { createEgressEventReporter } from "./sandbox/egress-events";
import { startEgressProxy } from "./sandbox/egress-proxy";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { createRunnerSpawn } from "./sandbox/runner-process";
import { createRemoteRunnerSpawn, openRunnerForward, type RunnerClientOptions } from "./sandbox/runner-service";

export interface RerunConfig extends ArtifactRetention {
  /** TARGET_PRIVATE_ALLOWLIST: the same admission as exploration (Ruling R31). */
  privateAllowlist: string[];
  /** RUNNER_WORKSPACE_DIR (Ruling R32). */
  workspaceDir: string;
  /** RUNNER_NODE_MODULES_DIR; unset → the worker's own @playwright/test install. */
  nodeModulesDir?: string | undefined;
  /** RUNNER_URL / RUNNER_TOKEN: reruns run in the runner container (KI-029); unset → a child process here. */
  runner?: RunnerClientOptions;
}

/** The runner service's addresses: its egress proxy accepts only these (the runner network). */
async function runnerAddresses(runnerUrl: string): Promise<string[]> {
  const host = new URL(runnerUrl).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return [host];
  return (await lookup(host, { all: true })).map((a) => a.address);
}

/** The rerun evidence port for one run: object storage + `artifacts` row (retention by sensitivity). */
export function createRerunEvidenceStore(
  deps: { db: Database; storage: ArtifactStorage; config: ArtifactRetention; now?: () => Date; metrics?: WorkerMetrics },
  ctx: Pick<StageContext, "runId" | "tenantId">,
): EvidenceStore {
  return {
    save: ({ type, fileName, body, contentType, sha256, sensitivity }) =>
      storeArtifact(deps, { tenantId: ctx.tenantId, runId: ctx.runId, type, fileName, body: Buffer.from(body), contentType, sensitivity, sha256 }),
  };
}

export interface RerunDepsInput {
  db: Database;
  storage: ArtifactStorage;
  logger: WorkerLogger;
  config: RerunConfig;
  metrics?: WorkerMetrics;
  /** Test seams: replace the proxy, the child process or the evidence store. */
  overrides?: Partial<RunTestStageDeps>;
}

/**
 * The real RUNNING_PLAYWRIGHT stage's dependencies (Task 17): the rerun's own egress proxy (Ruling
 * R31: same private allowlist as exploration, blocks published as `egress.blocked` the same way;
 * closed by the stage and by its registered cleanup), the runner child process (env allow-list,
 * process-group kill), the workspace location, the evidence store, and the worker logger for the
 * cause of an infrastructure failure (the run itself records only a template message).
 */
export function createRunTestDeps(input: RerunDepsInput): RunTestStageDeps {
  const { db, storage, logger, config } = input;
  const overrides = input.overrides ?? {};
  return {
    openProxy:
      overrides.openProxy ??
      (async (ctx) => {
        const report = createEgressEventReporter({ publish: (e) => ctx.publish(e), logger });
        const count = countEgressBlock(input.metrics);
        const runner = config.runner;
        const proxy = await startEgressProxy({
          resolve: defaultResolver,
          privateAllowlist: config.privateAllowlist,
          onBlock: (e) => {
            count(e);
            report(e);
          },
          // In the runner container, the browser reaches this proxy over the runner network (KI-029).
          ...(runner ? { listen: { host: "0.0.0.0", allowedClients: await runnerAddresses(runner.url) } } : {}),
        });
        if (!runner) return proxy;
        try {
          const forward = await openRunnerForward(runner, proxy.port);
          return {
            url: `http://127.0.0.1:${forward.port}`,
            async close() {
              await forward.close();
              await proxy.close();
            },
          };
        } catch (err) {
          await proxy.close();
          throw err;
        }
      }),
    spawn: countedSpawn(overrides.spawn ?? (config.runner ? createRemoteRunnerSpawn(config.runner) : createRunnerSpawn({ logger })), input.metrics),
    workspace: overrides.workspace ?? { baseDir: config.workspaceDir, nodeModulesDir: config.nodeModulesDir },
    evidence: overrides.evidence ?? ((ctx) => createRerunEvidenceStore({ db, storage, config, metrics: input.metrics }, ctx)),
    // Infrastructure failures (proxy, workspace, spawn, browser launch) reach the worker log with their cause.
    logger: overrides.logger ?? logger,
    ...(overrides.actionTimeoutMs !== undefined ? { actionTimeoutMs: overrides.actionTimeoutMs } : {}),
    ...(overrides.expectTimeoutMs !== undefined ? { expectTimeoutMs: overrides.expectTimeoutMs } : {}),
  };
}

/** A rerun child runs its own Chromium: it counts as a browser session while it runs. */
function countedSpawn(spawn: RunTestStageDeps["spawn"], metrics: WorkerMetrics | undefined): RunTestStageDeps["spawn"] {
  if (!metrics) return spawn;
  const counted: RunTestStageDeps["spawn"] = async (runnerInput) => {
    metrics.browserSessions.inc();
    try {
      return await spawn(runnerInput);
    } finally {
      metrics.browserSessions.dec();
    }
  };
  return Object.assign(counted, spawn);
}
