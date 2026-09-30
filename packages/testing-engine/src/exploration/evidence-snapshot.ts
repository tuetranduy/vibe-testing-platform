import { CancelledError, ExplorationStepSchema, type ExplorationStep } from "@platform/contracts";
import type { StageContext } from "../orchestrator/stages";
import { race, screenshotSensitivity, type SurveySandbox } from "../survey/site-reader";
import { newStepId, type ExplorationStore } from "./executor";

/** Loading the start page and taking its screenshot get at most this long. */
export const EVIDENCE_SNAPSHOT_TIMEOUT_MS = 30_000;

export interface CaptureEvidenceDeps {
  /** The run's sandbox without Stagehand (as for the survey): platform code loads the page, no model. */
  openSandbox(ctx: StageContext): Promise<SurveySandbox>;
  /** Persistence for the step and its screenshot (the exploration store). */
  store(ctx: StageContext): Pick<ExplorationStore, "saveStep" | "saveScreenshot">;
  logger?: { warn(obj: object, msg?: string): void };
  /** Test seam; EVIDENCE_SNAPSHOT_TIMEOUT_MS by default. */
  timeoutMs?: number;
}

const INSTRUCTION = "Capture the start page as evidence: every criterion was blocked before exploration";

/**
 * The real `captureEvidence` stage (V1.3): when the plan blocks every criterion, nothing is explored, yet the
 * report should still show what the site looked like. Loads the target URL read-only (nothing clicked, typed
 * or submitted; no model) and stores a full-page screenshot, recorded as one `screenshot` step (off the golden
 * path: the compiler never replays it). Best effort: any failure but cancel / the hard deadline returns []
 * with `artifact.omitted`. The sandbox is always closed.
 */
export function createCaptureEvidenceStage(deps: CaptureEvidenceDeps): (ctx: StageContext) => Promise<ExplorationStep[]> {
  const timeoutMs = deps.timeoutMs ?? EVIDENCE_SNAPSHOT_TIMEOUT_MS;
  return async (ctx) => {
    const omitted = async (reason: string) => {
      await ctx.publish({ type: "artifact.omitted", message: "Screenshot of the start page could not be taken", payload: { type: "SCREENSHOT", reason } });
      return [];
    };
    const startedAt = ctx.now();
    let sandbox: SurveySandbox;
    try {
      sandbox = await deps.openSandbox(ctx);
    } catch (err) {
      if (ctx.signal.aborted || err instanceof CancelledError) throw ctx.signal.reason ?? err;
      deps.logger?.warn({ err: err instanceof Error ? err.message : String(err), runId: ctx.runId }, "evidence snapshot: the browser sandbox failed to start");
      return omitted("The browser could not be started");
    }
    ctx.addCleanup(() => sandbox.close());
    try {
      const limit = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
      let png: Buffer;
      try {
        await race(sandbox.page.goto(ctx.request.targetUrl, { waitUntil: "load", timeout: timeoutMs }), limit);
        png = await race(sandbox.page.screenshot({ type: "png", fullPage: true }), limit);
      } catch {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        return omitted("The start page could not be loaded");
      }
      const store = deps.store(ctx);
      const sensitivity = screenshotSensitivity(ctx);
      const { artifactId } = await store.saveScreenshot({ png, fileName: "blocked-start-page.png", sensitivity });
      await ctx.publish({
        type: "artifact.created",
        message: "Full-page screenshot of the start page saved as evidence",
        payload: { artifactId, type: "SCREENSHOT", sensitivity },
      });
      let urlAfter = "about:blank";
      try {
        urlAfter = sandbox.page.url();
      } catch {
        // closed: keep about:blank
      }
      const finishedAt = ctx.now();
      const step = ExplorationStepSchema.parse(
        ctx.redact({
          id: newStepId(),
          runId: ctx.runId,
          index: 0,
          plannedStepId: null,
          kind: "screenshot",
          instruction: INSTRUCTION,
          element: null,
          inputRef: null,
          onGoldenPath: false,
          urlBefore: "about:blank",
          urlAfter,
          outcome: "SUCCESS",
          blockReason: null,
          error: null,
          startedAt: startedAt.toISOString(),
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          artifactIds: [artifactId],
          llm: null,
        }),
      );
      await store.saveStep(step);
      await ctx.publish({
        type: "step.recorded",
        message: "Step 1: screenshot of the start page",
        payload: { stepId: step.id, index: 0, kind: "screenshot", outcome: "SUCCESS", blockReason: null },
      });
      return [step];
    } finally {
      await sandbox.close().catch(() => {});
    }
  };
}
