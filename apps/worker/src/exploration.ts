import { ArtifactRepository, ExplorationStepRepository, ObservedFactRepository, type Database } from "@platform/db";
import type { StructuredLlm } from "@platform/stagehand-adapter";
import { StagehandExplorer, resolveStagehandExtensionDir } from "@platform/stagehand-adapter";
import type { ArtifactStorage } from "@platform/storage";
import type { ExplorationStore, ExploreStageDeps, StageContext } from "@platform/testing-engine";
import type { WorkerLogger } from "./deps";
import { computeExtensionId, type BrowserExtension } from "./sandbox/browser-launcher";
import { openRunSandbox } from "./sandbox/run-sandbox";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExplorationConfig {
  /** TARGET_PRIVATE_ALLOWLIST (non-production only; see @platform/config). */
  privateAllowlist: string[];
  artifactRetentionDays: number;
  secretArtifactRetentionDays: number;
}

export interface ExplorationStoreDeps {
  db: Database;
  storage: ArtifactStorage;
  config: Pick<ExplorationConfig, "artifactRetentionDays" | "secretArtifactRetentionDays">;
  now?: () => Date;
}

/**
 * The executor's persistence ports for one run: steps and facts in PostgreSQL (validated by the
 * repositories), screenshots in artifact storage with an `artifacts` row whose expiry depends on
 * sensitivity (SECRET_BEARING artifacts are kept for a shorter time).
 */
export function createExplorationStore(deps: ExplorationStoreDeps, ctx: Pick<StageContext, "runId" | "tenantId">): ExplorationStore {
  const now = deps.now ?? (() => new Date());
  const steps = new ExplorationStepRepository(deps.db);
  const facts = new ObservedFactRepository(deps.db);
  const artifacts = new ArtifactRepository(deps.db);
  return {
    async saveStep(step) {
      await steps.insert(step);
    },
    async saveFact(fact) {
      await facts.upsert(ctx.runId, fact);
    },
    async saveScreenshot({ png, fileName, sensitivity }) {
      const contentType = "image/png";
      const stored = await deps.storage.put({ tenantId: ctx.tenantId, runId: ctx.runId, type: "SCREENSHOT", fileName, body: png, contentType, sensitivity });
      const days = sensitivity === "SECRET_BEARING" ? deps.config.secretArtifactRetentionDays : deps.config.artifactRetentionDays;
      try {
        const row = await artifacts.create({
          tenantId: ctx.tenantId,
          runId: ctx.runId,
          type: "SCREENSHOT",
          objectKey: stored.objectKey,
          sha256: stored.sha256,
          bytes: stored.bytes,
          contentType,
          sensitivity,
          expiresAt: new Date(now().getTime() + days * DAY_MS),
        });
        return { artifactId: row.id };
      } catch (err) {
        // No row → nothing would ever expire the object: remove it now.
        await deps.storage.delete(stored.objectKey).catch(() => {});
        throw err;
      }
    },
  };
}

export interface ExplorationDepsInput {
  db: Database;
  storage: ArtifactStorage;
  logger: WorkerLogger;
  /** The LlmClient (the explorer's ClientLLM bridge records its calls as EXPLORING). */
  llm: StructuredLlm;
  config: ExplorationConfig;
  /** Test seams: replace the sandbox, the explorer or the recorder. */
  overrides?: Partial<ExploreStageDeps>;
}

let extension: BrowserExtension | undefined;

/** The Stagehand runtime extension (Ruling R9), resolved once; throws when it cannot be found. */
export function stagehandExtension(): BrowserExtension {
  if (!extension) {
    const dir = resolveStagehandExtensionDir();
    extension = { dir, id: computeExtensionId(dir) };
  }
  return extension;
}

/**
 * The real explore stage's dependencies (Ruling R12): the run sandbox (Task 13) with the Stagehand
 * runtime extension preloaded (Ruling R9), the Stagehand explorer, and the run's persistence.
 */
export function createExplorationDeps(input: ExplorationDepsInput): ExploreStageDeps {
  const { db, storage, logger, config } = input;
  const overrides = input.overrides ?? {};
  return {
    openSandbox:
      overrides.openSandbox ??
      ((ctx) =>
        openRunSandbox(ctx, {
          privateAllowlist: config.privateAllowlist,
          logger,
          extensions: [stagehandExtension()],
        })),
    explorer:
      overrides.explorer ??
      {
        // Built on first use so the extension id is resolved once, from the loaded extension.
        start: (startInput) => new StagehandExplorer({ llm: input.llm, extensionId: stagehandExtension().id, logger }).start(startInput),
      },
    store: overrides.store ?? ((ctx) => createExplorationStore({ db, storage, config }, ctx)),
    // Start-up failures (e.g. Chromium's stderr tail) are logged here; the run records a template message.
    logger: overrides.logger ?? logger,
    ...(overrides.recorder ? { recorder: overrides.recorder } : {}),
    ...(overrides.pollIntervalMs !== undefined ? { pollIntervalMs: overrides.pollIntervalMs } : {}),
  };
}
