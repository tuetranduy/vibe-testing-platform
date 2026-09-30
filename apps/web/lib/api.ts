import {
  ApiErrorSchema,
  CreateTestRunResponseSchema,
  LlmSettingsViewSchema,
  SuggestionSetResponseSchema,
  NormalizedRequirementSchema,
  SessionViewSchema,
  CredentialProfileListSchema,
  CredentialProfileSchema,
  TestDataSetListSchema,
  UsageReportSchema,
  TestDataSetSchema,
  UserListResponseSchema,
  UserViewSchema,
  TestReportSchema,
  TestRunListResponseSchema,
  TestRunSummarySchema,
  RunSuiteResponseSchema,
  RunComparisonSchema,
  type RunComparison,
  SuiteDetailSchema,
  SuiteListSchema,
  SuiteRunListSchema,
  SuiteRunViewSchema,
  type ApiError,
  type AddSuiteEntryRequest,
  type RunSuiteRequestInput,
  type RunSuiteResponse,
  type SuiteDetail,
  type SuiteInput,
  type SuiteRunBrief,
  type SuiteRunView,
  type SuiteView,
  type CreateTestRunRequestInput,
  type CreateTestRunResponse,
  type RerunRequestInput,
  type CreateUserRequestInput,
  type SessionView,
  type CreateCredentialProfileRequestInput,
  type CredentialProfile,
  type UpdateCredentialProfileRequest,
  type TestDataSet,
  type UsageReport,
  type TestDataSetInput,
  type UpdateUserRequest,
  type UserView,
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

/**
 * The session ended (signed out elsewhere, expired, the account disabled): the proxy has cleared the
 * cookie, so the page goes to sign-in and comes back here afterwards.
 */
function onSessionEnded(): void {
  if (typeof window === "undefined" || window.location.pathname === "/login") return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function request<T>(
  schema: z.ZodType<T>,
  path: string,
  init: { method?: Method; body?: unknown; headers?: Record<string, string> } = {},
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
    if (res.status === 401 && err.success && err.data.code === "SESSION_INVALID") onSessionEnded();
    if (err.success) throw new ApiRequestError(res.status, err.data.code, err.data.message, err.data.issues);
    throw new ApiRequestError(res.status, `HTTP_${res.status}`, `The server answered ${res.status}.`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiRequestError(res.status, "BAD_RESPONSE", "The server sent an unexpected response.");
  return parsed.data;
}

export const createRun = (body: CreateTestRunRequestInput, idempotencyKey: string): Promise<CreateTestRunResponse> =>
  request(CreateTestRunResponseSchema, BASE, { method: "POST", body, headers: { "idempotency-key": idempotencyKey } });

/**
 * The history, newest first; pass the previous page's `nextCursor` for the next page. `owner`: an
 * admin's "My runs" (`me`) or everyone's (`all`, the default); members always get their own.
 */
export const listRuns = (cursor: string | null = null, limit = 50, owner?: "me" | "all"): Promise<TestRunListResponse> => {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  if (owner) q.set("owner", owner);
  return request(TestRunListResponseSchema, `${BASE}?${q}`);
};

/** The report as a Markdown file, downloaded by the browser through this app's proxy (V1.1). */
export const reportMarkdownPath = (runId: string) => `${runPath(runId)}/report.md`;

/** How a completed run changed since an earlier run of the same test (V1.2): the previous one, or `baseline`. */
export const getComparison = (runId: string, baseline?: string): Promise<RunComparison> =>
  request(RunComparisonSchema, `${runPath(runId)}/comparison${baseline ? `?baseline=${seg(baseline)}` : ""}`);

/** The final report (COMPLETED) or a partial one (ERRORED / CANCELLED); 409 while the run is still going. */
export const getReport = (runId: string): Promise<TestReport> => request(TestReportSchema, `${runPath(runId)}/report`);

export const getRun = (runId: string): Promise<TestRunSummary> => request(TestRunSummarySchema, runPath(runId));

/** A manual rerun of a finished run's saved Playwright test (V1.1): a new run, no model call. */
export const rerunRun = (runId: string, body: RerunRequestInput, idempotencyKey: string): Promise<CreateTestRunResponse> =>
  request(CreateTestRunResponseSchema, `${runPath(runId)}/rerun`, { method: "POST", body, headers: { "idempotency-key": idempotencyKey } });

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

const AUTH = "/api/v1/auth";
const NoContentSchema = z.unknown();

/** Signs in: the session goes into an httpOnly cookie (set by this app's proxy); the answer names the user. */
export const login = (email: string, password: string): Promise<SessionView> =>
  request(SessionViewSchema, `${AUTH}/login`, { method: "POST", body: { email, password } });

export const logout = async (): Promise<void> => {
  await request(NoContentSchema, `${AUTH}/logout`, { method: "POST" });
};

/** The signed-in user. */
export const getMe = (): Promise<UserView> => request(UserViewSchema, `${AUTH}/me`);

export const changePassword = async (currentPassword: string, newPassword: string): Promise<void> => {
  await request(NoContentSchema, `${AUTH}/password`, { method: "PUT", body: { currentPassword, newPassword } });
};

const USERS = "/api/v1/users";

/** Admin: every user of the tenant. */
export const listUsers = async (): Promise<UserView[]> => (await request(UserListResponseSchema, USERS)).items;

export const createUser = (body: CreateUserRequestInput): Promise<UserView> => request(UserViewSchema, USERS, { method: "POST", body });

export const updateUser = (userId: string, body: UpdateUserRequest): Promise<UserView> =>
  request(UserViewSchema, `${USERS}/${seg(userId)}`, { method: "PATCH", body });

const SETS = "/api/v1/test-data-sets";

/** Saved test data sets (V1.1 F3), by name. */
export const listTestDataSets = async (): Promise<TestDataSet[]> => (await request(TestDataSetListSchema, SETS)).items;

export const createTestDataSet = (body: TestDataSetInput): Promise<TestDataSet> => request(TestDataSetSchema, SETS, { method: "POST", body });

export const updateTestDataSet = (id: string, body: TestDataSetInput): Promise<TestDataSet> =>
  request(TestDataSetSchema, `${SETS}/${seg(id)}`, { method: "PUT", body });

export const deleteTestDataSet = async (id: string): Promise<void> => {
  await request(NoContentSchema, `${SETS}/${seg(id)}`, { method: "DELETE" });
};

const PROFILES = "/api/v1/credential-profiles";

/** Saved credentials (V1.1 F4): names only, never a value. */
export const listCredentialProfiles = async (): Promise<CredentialProfile[]> => (await request(CredentialProfileListSchema, PROFILES)).items;

export const createCredentialProfile = (body: CreateCredentialProfileRequestInput): Promise<CredentialProfile> =>
  request(CredentialProfileSchema, PROFILES, { method: "POST", body });

/** A value replaces the secret, null removes it, an omitted name is kept. */
export const updateCredentialProfile = (id: string, body: UpdateCredentialProfileRequest): Promise<CredentialProfile> =>
  request(CredentialProfileSchema, `${PROFILES}/${seg(id)}`, { method: "PUT", body });

export const deleteCredentialProfile = async (id: string): Promise<void> => {
  await request(NoContentSchema, `${PROFILES}/${seg(id)}`, { method: "DELETE" });
};

/** Model spend over whole UTC days (V1.1): the last 30 by default; `owner` as for the run list. */
export const getUsage = (range: { from?: string; to?: string; owner?: "me" | "all" } = {}): Promise<UsageReport> => {
  const q = new URLSearchParams(Object.entries(range).filter((e): e is [string, string] => typeof e[1] === "string"));
  return request(UsageReportSchema, `/api/v1/usage${q.size > 0 ? `?${q}` : ""}`);
};

const ExplorationCacheStatsSchema = z.object({ entries: z.number(), hits: z.number(), lastUsedAt: z.string().nullable() });
export type ExplorationCacheStats = z.infer<typeof ExplorationCacheStatsSchema>;
const CACHE = "/api/v1/exploration-cache";

/** The tenant's exploration cache (V1.1): entries and reuse. */
export const getExplorationCache = (): Promise<ExplorationCacheStats> => request(ExplorationCacheStatsSchema, CACHE);

/** Admin: empties the tenant's exploration cache. */
export const clearExplorationCache = (): Promise<{ deleted: number }> =>
  request(z.object({ deleted: z.number() }), CACHE, { method: "DELETE" });

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

const SUITES = "/api/v1/suites";
const SUITE_RUNS = "/api/v1/suite-runs";

/** Suites (V1.2): saved Playwright tests that run together, with no AI. */
export const listSuites = async (): Promise<SuiteView[]> => (await request(SuiteListSchema, SUITES)).items;

export const getSuite = (suiteId: string): Promise<SuiteDetail> => request(SuiteDetailSchema, `${SUITES}/${seg(suiteId)}`);

export const createSuite = (body: SuiteInput): Promise<SuiteDetail> => request(SuiteDetailSchema, SUITES, { method: "POST", body });

export const updateSuite = (suiteId: string, body: SuiteInput): Promise<SuiteDetail> =>
  request(SuiteDetailSchema, `${SUITES}/${seg(suiteId)}`, { method: "PUT", body });

export const deleteSuite = async (suiteId: string): Promise<void> => {
  await request(NoContentSchema, `${SUITES}/${seg(suiteId)}`, { method: "DELETE" });
};

export const addSuiteEntry = (suiteId: string, body: AddSuiteEntryRequest): Promise<SuiteDetail> =>
  request(SuiteDetailSchema, `${SUITES}/${seg(suiteId)}/entries`, { method: "POST", body });

export const removeSuiteEntry = async (suiteId: string, sourceRunId: string): Promise<void> => {
  await request(NoContentSchema, `${SUITES}/${seg(suiteId)}/entries/${seg(sourceRunId)}`, { method: "DELETE" });
};

export const reorderSuiteEntries = (suiteId: string, sourceRunIds: string[]): Promise<SuiteDetail> =>
  request(SuiteDetailSchema, `${SUITES}/${seg(suiteId)}/entries/order`, { method: "PUT", body: { sourceRunIds } });

export const runSuite = (suiteId: string, body: RunSuiteRequestInput, idempotencyKey: string): Promise<RunSuiteResponse> =>
  request(RunSuiteResponseSchema, `${SUITES}/${seg(suiteId)}/runs`, { method: "POST", body, headers: { "idempotency-key": idempotencyKey } });

export const listSuiteRuns = async (suiteId: string): Promise<SuiteRunBrief[]> =>
  (await request(SuiteRunListSchema, `${SUITES}/${seg(suiteId)}/runs?limit=20`)).items;

export const getSuiteRun = (suiteRunId: string): Promise<SuiteRunView> => request(SuiteRunViewSchema, `${SUITE_RUNS}/${seg(suiteRunId)}`);

export const cancelSuiteRun = (suiteRunId: string): Promise<SuiteRunView> =>
  request(SuiteRunViewSchema, `${SUITE_RUNS}/${seg(suiteRunId)}/cancel`, { method: "POST" });
