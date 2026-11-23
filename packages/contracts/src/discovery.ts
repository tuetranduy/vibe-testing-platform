import { z } from "zod";
import { HttpUrlSchema } from "./common";

const version = z.literal("discovery.v1");
const runId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

/** Exact fixture URL. Do not transmit query parameters, fragments or credentials to the launcher. */
export const DiscoveryFixtureUrlSchema = HttpUrlSchema
  .refine((value) => value.length <= 2048 && !/[?#]/.test(value), "Discovery requires a fixture URL of up to 2048 characters without a query or fragment")
  .transform((value) => new URL(value))
  .refine((url) => url.protocol === "http:" && Number(url.port) >= 1024, "Discovery requires an HTTP fixture on a port of 1024 or higher")
  .transform((url) => url.href);

export const DiscoveryInputSchema = z.strictObject({ schemaVersion: version, runId, targetUrl: DiscoveryFixtureUrlSchema });
export type DiscoveryInput = z.infer<typeof DiscoveryInputSchema>;

const candidateText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Use plain text");

const FixturePathSchema = z.string().max(180).regex(
  /^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._~-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._~-]*)*\/?)?$/,
  "Expected a fixture path without a host, query, fragment or dot segments",
);

const DiscoveryCandidateSchema = z.strictObject({
  title: candidateText(3, 80),
  goal: candidateText(10, 500),
  rationale: candidateText(1, 300),
  relevantPaths: z.array(FixturePathSchema).min(1).max(8),
  expectedBehavior: z.array(candidateText(1, 180)).min(1).max(5),
  negativeCases: z.array(candidateText(1, 180)).max(5),
});

const responseFields = { schemaVersion: version, runId };
export const DiscoveryResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...responseFields, status: z.literal("COMPLETED"), candidates: z.array(DiscoveryCandidateSchema).min(1).max(12) }),
  z.strictObject({
    ...responseFields,
    status: z.enum(["PARTIAL", "BLOCKED", "FAILED", "CANCELLED"]),
    candidates: z.tuple([]),
  }),
]);
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;
