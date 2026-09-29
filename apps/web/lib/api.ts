import {
  ApiErrorSchema,
  CreateTestRunResponseSchema,
  LlmSettingsViewSchema,
  SuggestionSetResponseSchema,
  NormalizedRequirementSchema,
  TestReportSchema,
  TestRunListResponseSchema,
  TestRunSummarySchema,
  type ApiError,
  type CreateTestRunRequestInput,
  type CreateTestRunResponse,
  type LlmDefaultsInput,
  type LlmKeyProvider,
  type LlmSettingsView,
  type NormalizedRequirement,
  type SelectSuggestionRequest,
  type SuggestionSetResponse,
  type TestReport,
  type TestRunListResponse,
  type TestRunSummary,
} from "@platform/contracts";
import { z } from "zod";

/**
 * Typed browser client for the platform API. Every call goes through this app's own `/api` proxy
 * (app/api/[...path]/route.ts), which adds the API token on the server; the browser never has it.
 */
const BASE = "/api/v1/test-runs";

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues?: ApiError["issues"],
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const ConfirmResultSchema = z.object({ revision: z.number().int(), warnings: z.array(z.string()) });
export type ConfirmResult = z.infer<typeof ConfirmResultSchema>;
const ArtifactUrlSchema = z.object({ url: z.string(), expiresAt: z.string() });
export type ArtifactUrl = z.infer<typeof ArtifactUrlSchema>;

const seg = (s: string) => encodeURIComponent(s);
export const runPath = (runId: string) => `${BASE}/${seg(runId)}`;
export const runEventsPath = (runId: string) => `${runPath(runId)}/events`;

async function request<T>(
  schema: z.ZodType<T>,
  path: string,
  init: { method?: "GET" | "POST" | "PUT"; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new ApiRequestError(0, "NETWORK_ERROR", "Could not reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = ApiErrorSchema.safeParse(data);
    if (err.success) throw new ApiRequestError(res.status, err.data.code, err.data.message, err.data.issues);
    throw new ApiRequestError(res.status, `HTTP_${res.status}`, `The server answered ${res.status}.`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiRequestError(res.status, "BAD_RESPONSE", "The server sent an unexpected response.");
  return parsed.data;
}

export const createRun = (body: CreateTestRunRequestInput, idempotencyKey: string): Promise<CreateTestRunResponse> =>
  request(CreateTestRunResponseSchema, BASE, { method: "POST", body, headers: { "idempotency-key": idempotencyKey } });

/** The history, newest first; pass the previous page's `nextCursor` for the next page. */
export const listRuns = (cursor: string | null = null, limit = 50): Promise<TestRunListResponse> => {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return request(TestRunListResponseSchema, `${BASE}?${q}`);
};

/** The final report (COMPLETED) or a partial one (ERRORED / CANCELLED); 409 while the run is still going. */
export const getReport = (runId: string): Promise<TestReport> => request(TestReportSchema, `${runPath(runId)}/report`);

export const getRun = (runId: string): Promise<TestRunSummary> => request(TestRunSummarySchema, runPath(runId));

export const cancelRun = (runId: string): Promise<TestRunSummary> =>
  request(TestRunSummarySchema, `${runPath(runId)}/cancel`, { method: "POST" });

export const getCriteria = (runId: string): Promise<NormalizedRequirement> =>
  request(NormalizedRequirementSchema, `${runPath(runId)}/criteria`);

/** Saves a new criteria revision; the API takes the full requirement. */
export const updateCriteria = (runId: string, requirement: NormalizedRequirement): Promise<NormalizedRequirement> =>
  request(NormalizedRequirementSchema, `${runPath(runId)}/criteria`, { method: "PUT", body: requirement });

/** A blank-requirement run's suggested tests (409 while it is still exploring, 404 for a run with a requirement). */
export const getSuggestions = (runId: string): Promise<SuggestionSetResponse> =>
  request(SuggestionSetResponseSchema, `${runPath(runId)}/suggestions`);

/** Chooses a suggested test (`requirement` only when edited): the run's new summary, now analysing it. */
export const selectSuggestion = (runId: string, body: SelectSuggestionRequest): Promise<TestRunSummary> =>
  request(TestRunSummarySchema, `${runPath(runId)}/suggestions/select`, { method: "POST", body });

export const confirmCriteria = (runId: string): Promise<ConfirmResult> =>
  request(ConfirmResultSchema, `${runPath(runId)}/criteria/confirm`, { method: "POST" });

const SETTINGS = "/api/v1/settings/llm";

/** Settings → AI providers and defaults: key statuses (never a key), the defaults, and the offered models. */
export const getLlmSettings = (): Promise<LlmSettingsView> => request(LlmSettingsViewSchema, SETTINGS);

/** Saves the defaults for new tests; 422 MODEL_NOT_AVAILABLE when the model or level can't be used. */
export const saveLlmDefaults = (defaults: LlmDefaultsInput): Promise<LlmSettingsView> =>
  request(LlmSettingsViewSchema, SETTINGS, { method: "PUT", body: { defaults } });

/** Saves (or, with null, removes) a provider's API key. The answer never contains it. */
export const saveProviderKey = (provider: LlmKeyProvider, apiKey: string | null): Promise<LlmSettingsView> =>
  request(LlmSettingsViewSchema, `${SETTINGS}/keys/${provider}`, { method: "PUT", body: { apiKey } });

/** Prefer `fetchArtifactUrl` (lib/artifacts.ts), which applies the reveal rule. */
export const getArtifactUrl = (runId: string, artifactId: string, reveal: boolean): Promise<ArtifactUrl> =>
  request(ArtifactUrlSchema, `${runPath(runId)}/artifacts/${seg(artifactId)}/url${reveal ? "?reveal=true" : ""}`);
