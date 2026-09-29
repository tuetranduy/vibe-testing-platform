import type { Database } from "@platform/db";
import type { ArtifactStorage } from "@platform/storage";
import type { StageContext, SurveySandbox, SurveyStageDeps } from "@platform/testing-engine";
import { storeArtifact } from "./artifacts";
import type { WorkerLogger } from "./deps";
import type { ExplorationConfig } from "./exploration";
import { countEgressBlock, type WorkerMetrics } from "./metrics";
import { openRunSandbox } from "./sandbox/run-sandbox";

export interface SurveyDepsInput {
  db: Database;
  storage: ArtifactStorage;
  logger: WorkerLogger;
  /** TARGET_PRIVATE_ALLOWLIST and the artifact retention (as for exploration). */
  config: ExplorationConfig;
  metrics?: WorkerMetrics;
  now?: () => Date;
}

/**
 * The real survey stage's dependencies (spec section 5): the run's browser sandbox — egress proxy,
 * navigation guard, the run's allowed hosts — opened WITHOUT the Stagehand extension (platform code
 * drives the page by URL; no model ever does), and screenshot storage like exploration's.
 */
export function createSurveyDeps(input: SurveyDepsInput): SurveyStageDeps {
  return {
    async openSandbox(ctx: StageContext): Promise<SurveySandbox> {
      const sandbox = await openRunSandbox(ctx, {
        privateAllowlist: input.config.privateAllowlist,
        logger: input.logger,
        onEgressBlock: countEgressBlock(input.metrics),
      });
      // Closed by the stage and by its registered cleanup: count it down once.
      input.metrics?.browserSessions.inc();
      let open = true;
      const close = sandbox.close.bind(sandbox);
      return Object.assign(sandbox, {
        close: async () => {
          if (open) {
            open = false;
            input.metrics?.browserSessions.dec();
          }
          await close();
        },
      });
    },
    store: (ctx) => ({
      saveScreenshot: ({ png, fileName, sensitivity }) =>
        storeArtifact(
          { db: input.db, storage: input.storage, config: input.config, metrics: input.metrics, now: input.now },
          { tenantId: ctx.tenantId, runId: ctx.runId, type: "SCREENSHOT", fileName, body: png, contentType: "image/png", sensitivity },
        ),
    }),
    logger: input.logger,
  };
}
