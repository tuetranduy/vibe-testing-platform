import type { DiscoverySummary } from "@platform/contracts";

/** One sentence for the report: what happened to Browser Use discovery, never a test verdict. */
export function discoveryOutcomeText(summary: Pick<DiscoverySummary, "status" | "fallbackUsed" | "acceptedCount" | "candidateCount" | "pageCount">): string {
  if (!summary.fallbackUsed) {
    return `${summary.acceptedCount} of ${summary.candidateCount} candidate ideas were offered for review. The candidates referenced ${summary.pageCount} fixture pages.`;
  }
  switch (summary.status) {
    case "TIMED_OUT": return "Browser Use reached its time limit. This run used the standard survey suggestions.";
    case "BUSY": return "Browser Use was busy with other runs. This run used the standard survey suggestions.";
    case "BLOCKED": return "Browser Use was not available for this run. This run used the standard survey suggestions.";
    case "PARTIAL": return "Browser Use returned no reviewable ideas. This run used the standard survey suggestions.";
    case "CANCELLED": return "Browser Use stopped before it finished. This run used the standard survey suggestions.";
    default: return "Browser Use was unavailable. This run used the standard survey suggestions.";
  }
}
