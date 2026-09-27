import type {
  CriterionStatus,
  ExplorationStep,
  RerunOutcome,
  RunVerdict,
  StatusReason,
} from "@platform/contracts";
import type { IconName } from "./Icon";

/**
 * Presentation of report data: labels, icons and plain-language text. Every status is shown as
 * text + icon + color together (never color alone), and BLOCKED / INCONCLUSIVE never look like FAIL.
 */
export type StatusTone = "pass" | "fail" | "blocked" | "inconclusive";

export interface StatusUi {
  label: string;
  icon: IconName;
  tone: StatusTone;
}

export const CRITERION_STATUS_UI: Record<CriterionStatus, StatusUi> = {
  PASS: { label: "Pass", icon: "pass", tone: "pass" },
  FAIL: { label: "Fail", icon: "fail", tone: "fail" },
  BLOCKED: { label: "Blocked", icon: "blocked", tone: "blocked" },
  INCONCLUSIVE: { label: "Inconclusive", icon: "unknown", tone: "inconclusive" },
};

export const VERDICT_UI: Record<RunVerdict, StatusUi> = {
  PASSED: { label: "Passed", icon: "pass", tone: "pass" },
  FAILED: { label: "Failed", icon: "fail", tone: "fail" },
  BLOCKED: { label: "Blocked", icon: "blocked", tone: "blocked" },
  INCONCLUSIVE: { label: "Inconclusive", icon: "unknown", tone: "inconclusive" },
};

/** One plain-language sentence for every BLOCKED and INCONCLUSIVE reason in the contracts (Section 2.2). */
export const STATUS_REASON_TEXT: Record<StatusReason, string> = {
  // BLOCKED
  MISSING_SECRET: "A secret this check needs (for example a password) was not provided",
  MISSING_TEST_DATA: "Test data this check needs was not provided",
  DESTRUCTIVE_ACTION_NOT_AUTHORIZED: "Checking it needs an action that could change or delete data, which this run was not allowed to take",
  TARGET_BLOCKED_BY_POLICY: "The page it needs is not allowed by the network policy",
  OFF_DOMAIN_NAVIGATION: "Checking it would have meant leaving the allowed website",
  LOGIN_FAILED: "Logging in failed with the credentials provided",
  PRECONDITION_NOT_MET: "An earlier step it depends on could not be completed",
  // INCONCLUSIVE
  STEP_LIMIT_REACHED: "The run reached its step limit before this could be checked",
  EXPLORATION_BUDGET_EXHAUSTED: "Exploring the site ran out of time before this could be checked",
  FACT_NOT_OBSERVED: "The information needed to check this was not found on the page",
  UNVERIFIED_EVIDENCE: "The evidence was read by the AI model and could not be confirmed from the page itself",
  DISCOVERY_RERUN_DISAGREE: "Exploring the site and rerunning the generated test gave different results",
  AI_JUDGED_ONLY: "This can only be judged by the AI model, so it gets no pass or fail",
  AMBIGUOUS_CRITERION: "The criterion was too ambiguous to check reliably",
};

export const reasonText = (reason: StatusReason | null): string => (reason ? STATUS_REASON_TEXT[reason] : "No reason was recorded");

/** How a PASS / FAIL was decided (Section 2.3): the rerun confirmed it, or only exploration saw it. */
export const VERDICT_SOURCE_TEXT = {
  PLAYWRIGHT_RERUN: "Confirmed by rerun",
  EXPLORATION_ONLY: "Not confirmed by rerun",
} as const;

/** Why a PASS / FAIL was not confirmed by the rerun (EXPLORATION_ONLY comes with NOT_REACHED or UNAVAILABLE). */
export function unconfirmedWhy(rerun: RerunOutcome): string {
  return rerun === "NOT_REACHED"
    ? "The rerun stopped before it reached this check; exploration read the result directly from the page."
    : "No rerun covered this check; exploration read the result directly from the page.";
}

/** What the rerun of the generated test did at this criterion's assertion. */
export const RERUN_OUTCOME_TEXT: Record<RerunOutcome, string> = {
  PASSED: "the rerun's assertion passed",
  ASSERTION_FAILED: "the rerun's assertion failed",
  NOT_REACHED: "the rerun stopped before reaching it",
  UNAVAILABLE: "it was not rerun",
};

/** "Exploration found it passing, but the rerun's assertion failed." (DISCOVERY_RERUN_DISAGREE) */
export function disagreementText(provisional: CriterionStatus, rerun: RerunOutcome): string {
  const found = provisional === "PASS" ? "passing" : provisional === "FAIL" ? "failing" : CRITERION_STATUS_UI[provisional].label.toLowerCase();
  return `Exploration found it ${found}, but ${RERUN_OUTCOME_TEXT[rerun]}.`;
}

export const STEP_KIND_LABEL: Record<ExplorationStep["kind"], string> = {
  navigate: "Navigate",
  act: "Action",
  fill: "Fill",
  observe: "Observe",
  extract: "Read",
  checkpoint: "Checkpoint",
  screenshot: "Screenshot",
};

/** "42s", "1m 35s", "1h 2m"; "< 1s" under a second; "—" when unknown. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "< 1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const durationBetween = (start: string | null, end: string | null): number | null =>
  start && end ? new Date(end).getTime() - new Date(start).getTime() : null;

/**
 * An estimated cost in US dollars: cents from $0.10 up, a tenth of a cent below that (model calls
 * are cheap, and "$0.04" would hide a 2× difference), and "< $0.001" for anything smaller than that.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.001) return "< $0.001";
  if (usd < 0.1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** 34500 → "34.5k". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The host (with port) of a target URL; the raw string when it isn't a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** A target URL as people read it: no scheme, no bare trailing slash ("shop.example.com/cart?x=1"). */
export const displayUrl = (url: string): string => url.replace(/^https?:\/\//i, "").replace(/^([^/?#]+)\/$/, "$1");

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** When something happened, in the viewer's local time: "Today, 14:30", "Yesterday, 17:45", "20 Sep, 09:30", "31 Dec 2025, 09:30". */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS); // rounded: DST days are 23 or 25 hours
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  return `${date}, ${time}`;
}
