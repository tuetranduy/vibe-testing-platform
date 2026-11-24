import { z } from "zod";
import { DiscoveryFixturePathSchema } from "./discovery";

/**
 * Phase C (plan §15.6): a read-only coverage graph of one site across the caller's recent runs. A page is
 * `discovered` when Browser Use referenced it (a suggestion, a route or a finding) and `tested` when a run's verified
 * golden path reached it. `gaps` are pages discovery found that no test has reached yet: candidates for the next run.
 */
export const COVERAGE_MAX_RUNS = 50;

export const CoveragePageSchema = z.object({
  path: DiscoveryFixturePathSchema,
  /** Runs whose Browser Use output referenced the page. */
  discovered: z.number().int().min(0),
  /** Runs whose recorded golden path reached the page. */
  tested: z.number().int().min(0),
  /** Exploratory findings on the page, and how many of them an independent run reproduced. */
  findings: z.number().int().min(0),
  reproduced: z.number().int().min(0),
});
export type CoveragePage = z.infer<typeof CoveragePageSchema>;

export const CoverageResponseSchema = z.object({
  origin: z.string(),
  runs: z.number().int().min(0).max(COVERAGE_MAX_RUNS),
  pages: z.array(CoveragePageSchema).max(300),
  /** Consecutive pages of one Browser Use journey (a suggestion's or a route's paths), counted across runs. */
  edges: z.array(z.object({ from: DiscoveryFixturePathSchema, to: DiscoveryFixturePathSchema, count: z.number().int().min(1) })).max(500),
  gaps: z.array(DiscoveryFixturePathSchema).max(300),
});
export type CoverageResponse = z.infer<typeof CoverageResponseSchema>;

/** `GET /v1/discovery/coverage?url=`: any page URL of the site; only its origin is used. */
export const CoverageQuerySchema = z.object({ url: z.url().max(2048) });
