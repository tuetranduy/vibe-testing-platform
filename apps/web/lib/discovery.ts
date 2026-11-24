import type { DiscoverySummary } from "@platform/contracts";

/**
 * One sentence for the report: what happened to Browser Use discovery, never a test verdict. `context`: the
 * blank-prompt survey (the default), or (Phase B) a written requirement's analysis.
 */
export function discoveryOutcomeText(
  summary: Pick<DiscoverySummary, "status" | "fallbackUsed" | "acceptedCount" | "candidateCount" | "pageCount">,
  context: "survey" | "requirement" = "survey",
): string {
  if (!summary.fallbackUsed) {
    return context === "requirement"
      ? `${summary.acceptedCount} of ${summary.candidateCount} observed routes were used for these instructions. The candidates referenced ${summary.pageCount} pages.`
      : `${summary.acceptedCount} of ${summary.candidateCount} candidate ideas were offered for review. The candidates referenced ${summary.pageCount} pages.`;
  }
  const fallback = context === "requirement" ? "The requirement was analyzed without it." : "This run used the standard survey suggestions.";
  switch (summary.status) {
    case "TIMED_OUT": return `Browser Use reached its time limit. ${fallback}`;
    case "BUSY": return `Browser Use was busy with other runs. ${fallback}`;
    case "BLOCKED": return `Browser Use was not available for this run. ${fallback}`;
    case "PARTIAL": return `Browser Use returned no reviewable ideas. ${fallback}`;
    case "CANCELLED": return `Browser Use stopped before it finished. ${fallback}`;
    default: return `Browser Use was unavailable. ${fallback}`;
  }
}
