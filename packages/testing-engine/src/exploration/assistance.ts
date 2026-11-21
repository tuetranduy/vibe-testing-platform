import type { PlannedStep } from "@platform/contracts";

/** Three questions across all scenarios, so an unattended run cannot wait forever (2026-11-21). */
export const MAX_ASSISTANCE_REQUESTS = 3;
export const DEFAULT_ASSISTANCE_TIMEOUT_MS = 10 * 60_000;
export type AssistanceAnswer = { kind: "instruction"; text: string; by: string } | { kind: "stop" } | { kind: "timeout" };
export interface AssistanceRequest {
  requestId: string;
  scenarioId: string;
  failedStep: PlannedStep;
  reason: string;
  url: string;
  screenshotArtifactId: string;
  question: string;
  expiresAt: string;
}
/** Optional: CI and scripted engines keep their existing failure behavior (2026-11-21). */
export interface AssistancePort {
  timeoutMs?: number;
  /** Make the request answerable before its event reaches the browser (2026-11-21). */
  prepare?(request: AssistanceRequest, signal: AbortSignal): Promise<void>;
  ask(request: AssistanceRequest, signal: AbortSignal): Promise<AssistanceAnswer>;
}
