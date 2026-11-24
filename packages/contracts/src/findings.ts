import { z } from "zod";
import { HttpUrlSchema, IsoDateTime } from "./common";
import { DiscoveryFixturePathSchema, MAX_DISCOVERY_FINDINGS } from "./discovery";
import type { RunLifecycle, RunVerdict } from "./run";

/**
 * Phase C (plan §15): exploratory findings. Something Browser Use saw that looks wrong is stored apart from every
 * criterion result and verdict, as a HYPOTHESIS. It changes status only through a person's review (DISMISSED) or
 * an independent reproduction: a new run of the platform's own Stagehand → verification → Playwright pipeline,
 * whose verdict alone decides REPRODUCED / DISMISSED (not reproduced) / BLOCKED / INCONCLUSIVE.
 */

export const FindingIdSchema = z.string().regex(/^F-[1-5]$/);
export type FindingId = z.infer<typeof FindingIdSchema>;

export const FindingStatusSchema = z.enum(["HYPOTHESIS", "REPRODUCED", "DISMISSED", "BLOCKED", "INCONCLUSIVE"]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

/** Why a finding has its status: codes only. */
export const FindingStatusReasonSchema = z.enum([
  "not_reviewed", "reproduction_running", "dismissed_by_reviewer",
  "reproduced", "not_reproduced", "reproduction_blocked", "reproduction_inconclusive", "reproduction_failed_to_run",
]);
export type FindingStatusReason = z.infer<typeof FindingStatusReasonSchema>;

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

/** What `run_findings` stores (status changes are recorded on the row; the derived status is computed on read). */
export const StoredFindingSchema = z.strictObject({
  id: FindingIdSchema,
  source: z.literal("browser_use"),
  title: text(3, 80),
  observation: text(10, 300),
  expected: text(3, 180),
  path: DiscoveryFixturePathSchema,
  /** The target's origin with `path`: where the reproduction starts. */
  url: HttpUrlSchema,
  reproduction: z.array(text(1, 180)).min(1).max(6),
  severity: z.enum(["low", "medium", "high"]),
  /** Set by a reviewer's dismissal; null otherwise. */
  dismissedAt: IsoDateTime.nullable(),
  /** The run that reproduces it; null until a person starts one. */
  reproductionRunId: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type StoredFinding = z.infer<typeof StoredFindingSchema>;

export const ExploratoryFindingSchema = StoredFindingSchema.extend({
  status: FindingStatusSchema,
  statusReason: FindingStatusReasonSchema,
  /**
   * The same problem (same site, page and title words) in the tenant's other runs. Informational: another run's
   * reproduction or dismissal never changes this finding's own status.
   */
  recurrence: z.object({
    otherRuns: z.number().int().min(0),
    reproducedElsewhere: z.boolean(),
    dismissedElsewhere: z.boolean(),
  }).optional(),
});
export type ExploratoryFinding = z.infer<typeof ExploratoryFindingSchema>;

export const FindingsResponseSchema = z.object({ findings: z.array(ExploratoryFindingSchema).max(MAX_DISCOVERY_FINDINGS) });
export type FindingsResponse = z.infer<typeof FindingsResponseSchema>;

/**
 * A finding's status from what is recorded: a dismissal wins, then the reproduction run's own outcome. A finding
 * is REPRODUCED only when that run ended COMPLETED with FAILED, the pipeline's independently confirmed verdict
 * (its criteria state what a user would expect, so a failure is the reported problem seen again).
 */
export function findingStatus(
  finding: Pick<StoredFinding, "dismissedAt" | "reproductionRunId">,
  reproduction: { lifecycle: RunLifecycle; verdict: RunVerdict | null } | null,
): { status: FindingStatus; statusReason: FindingStatusReason } {
  if (finding.dismissedAt) return { status: "DISMISSED", statusReason: "dismissed_by_reviewer" };
  if (!finding.reproductionRunId || !reproduction) return { status: "HYPOTHESIS", statusReason: "not_reviewed" };
  if (reproduction.lifecycle === "ERRORED" || reproduction.lifecycle === "CANCELLED") {
    return { status: "INCONCLUSIVE", statusReason: "reproduction_failed_to_run" };
  }
  if (reproduction.lifecycle !== "COMPLETED") return { status: "HYPOTHESIS", statusReason: "reproduction_running" };
  switch (reproduction.verdict) {
    case "FAILED": return { status: "REPRODUCED", statusReason: "reproduced" };
    case "PASSED": return { status: "DISMISSED", statusReason: "not_reproduced" };
    case "BLOCKED": return { status: "BLOCKED", statusReason: "reproduction_blocked" };
    default: return { status: "INCONCLUSIVE", statusReason: "reproduction_inconclusive" };
  }
}

const STOP = new Set(["the", "a", "an", "is", "are", "of", "on", "in", "to", "and", "or", "page", "link", "button", "does", "not"]);

/**
 * One problem across runs: the target's origin, the page path and the title's content words in order of appearance
 * (deduplicated, so "Help link broken" and "Broken help link" match). Bounded and plain, never a page's text.
 */
export function findingFingerprint(finding: Pick<StoredFinding, "url" | "path" | "title">): string {
  const words = [...new Set(finding.title.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((w) => !STOP.has(w)).sort();
  return `${new URL(finding.url).origin}${finding.path}|${words.join(" ")}`.slice(0, 400);
}

/**
 * The reproduction run's requirement: what a user would expect, reached by the reported steps. Plain language for
 * the requirement analysis (a person confirms its criteria); never the agent's own actions or code.
 */
/** "The Help page opens" → "the Help page opens"; an acronym ("API errors") keeps its case. */
const sentenceCase = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text);

export function reproductionRequirement(finding: Pick<StoredFinding, "path" | "reproduction" | "expected">): string {
  const steps = finding.reproduction.map((step, i) => `${i + 1}. ${step}`).join("\n");
  return [
    `Starting on ${finding.path}:`,
    steps,
    // The observation is left out: the analysis would read it as something to check.
    `Verify that ${sentenceCase(finding.expected.replace(/[.\s]+$/, ""))}.`,
  ].join("\n").slice(0, 2000);
}
