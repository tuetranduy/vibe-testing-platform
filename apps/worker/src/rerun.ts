import type { Database } from "@platform/db";
import { defaultResolver } from "@platform/security";
import type { ArtifactStorage } from "@platform/storage";
import type { EvidenceStore, RunTestStageDeps, StageContext } from "@platform/testing-engine";
import { storeArtifact, type ArtifactRetention } from "./artifacts";
import type { WorkerLogger } from "./deps";
import { createEgressEventReporter } from "./sandbox/egress-events";
import { startEgressProxy } from "./sandbox/egress-proxy";
import { createRunnerSpawn } from "./sandbox/runner-process";

export interface RerunConfig extends ArtifactRetention {
  /** TARGET_PRIVATE_ALLOWLIST: the same admission as exploration (Ruling R31). */
  privateAllowlist: string[];
  /** RUNNER_WORKSPACE_DIR (Ruling R32). */
  workspaceDir: string;
  /** RUNNER_NODE_MODULES_DIR; unset → the worker's own @playwright/test install. */
  nodeModulesDir?: string | undefined;
}

/** The rerun evidence port for one run: object storage + `artifacts` row (retention by sensitivity). */
export function createRerunEvidenceStore(
  deps: { db: Database; storage: ArtifactStorage; config: ArtifactRetention; now?: () => Date },
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
      ((ctx) =>
        startEgressProxy({
          resolve: defaultResolver,
          privateAllowlist: config.privateAllowlist,
          onBlock: createEgressEventReporter({ publish: (e) => ctx.publish(e), logger }),
        })),
    spawn: overrides.spawn ?? createRunnerSpawn({ logger }),
    workspace: overrides.workspace ?? { baseDir: config.workspaceDir, nodeModulesDir: config.nodeModulesDir },
    evidence: overrides.evidence ?? ((ctx) => createRerunEvidenceStore({ db, storage, config }, ctx)),
    // Infrastructure failures (proxy, workspace, spawn, browser launch) reach the worker log with their cause.
    logger: overrides.logger ?? logger,
    ...(overrides.actionTimeoutMs !== undefined ? { actionTimeoutMs: overrides.actionTimeoutMs } : {}),
    ...(overrides.expectTimeoutMs !== undefined ? { expectTimeoutMs: overrides.expectTimeoutMs } : {}),
  };
}
