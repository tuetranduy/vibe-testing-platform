import {
  MAX_SECRETS,
  MAX_TEST_DATA_ENTRIES,
  SelectSuggestionRequestSchema,
  destructiveActionsAllowed,
  extractInlineInputs,
  type StoredTestRunRequest,
  type SuggestionSetResponse,
  type TestRunSummary,
} from "@platform/contracts";
import {
  EventRepository,
  RunRepository,
  SecretRepository,
  StaleTransitionError,
  SuggestionRepository,
  UnknownSuggestionError,
  type RunScope,
} from "@platform/db";
import { createRunEventPublisher, type RunEventPublisher } from "@platform/event-bus";
import { encryptSecret, redactByKey, redactFingerprintedSecrets, secretFingerprint } from "@platform/security";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";
import { NO_VERDICT, observeStage } from "../metrics";
import { summaryOf } from "./test-run-service";

const ENQUEUE_FAILED = "Queue unavailable after selection";


const notAwaiting = (lifecycle: string) =>
  new HttpError(409, "RUN_NOT_AWAITING_SELECTION", `Run is ${lifecycle}; a suggested test can only be chosen while the run awaits a choice`);

const unknownSuggestion = (id: string) =>
  new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [
    { path: ["suggestionId"], message: `${id} is not one of this run's suggested tests` },
  ]);

/**
 * A blank-requirement run's suggested tests (spec 2026-09-28-suggest-tests, section 4): read them,
 * and choose one — which becomes the run's requirement and releases the run into analysis. This is
 * the selection gate; D5's confirmation gate follows for the chosen test's criteria.
 */
export class SuggestionService {
  private readonly runs: RunRepository;
  private readonly suggestions: SuggestionRepository;

  constructor(private readonly deps: ApiDeps) {
    this.runs = new RunRepository(deps.db);
    this.suggestions = new SuggestionRepository(deps.db);
  }

  /** Secret plaintext never reaches the API (D7): events are redacted by key only, as for criteria. */
  private publisher(): RunEventPublisher {
    return createRunEventPublisher({ events: new EventRepository(this.deps.db), redis: this.deps.redis, redact: redactByKey });
  }

  async get(scope: RunScope, runId: string): Promise<SuggestionSetResponse> {
    const run = await this.runs.getRequired(scope, runId);
    const set = await this.suggestions.get(runId);
    if (!set) {
      if (run.request.requirement === "" && (run.lifecycle === "QUEUED" || run.lifecycle === "SURVEYING")) {
        throw new HttpError(409, "SUGGESTIONS_NOT_READY", "The website is still being explored for test ideas");
      }
      throw new HttpError(404, "NO_SUGGESTIONS", "This run has no suggested tests");
    }
    return {
      ...set,
      run: {
        secretNames: run.request.secretNames,
        testDataKeys: Object.keys(run.request.testData),
        destructiveActionsAllowed: destructiveActionsAllowed(run.request),
      },
    };
  }

  /**
   * Chooses a suggested test (its text, or the user's edit of it): section 3's transaction, then
   * `suggestion.selected`, then the analyze-run job. A queue failure after the transition errors the
   * run, as confirm does.
   */
  async select(scope: RunScope, runId: string, body: unknown): Promise<TestRunSummary> {
    const run = await this.runs.getRequired(scope, runId);
    const parsed = SelectSuggestionRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(parsed.error));
    if (run.lifecycle !== "AWAITING_SELECTION") throw notAwaiting(run.lifecycle);

    const { suggestionId } = parsed.data;
    const suggestion = (await this.suggestions.get(runId))?.suggestions.find((s) => s.id === suggestionId);
    if (!suggestion) throw unknownSuggestion(suggestionId);
    const text = parsed.data.requirement ?? suggestion.requirement;
    const edited = text !== suggestion.requirement;
    // Secret plaintext never reaches the API (D7): the run's secret values are found by their
    // fingerprints and masked before the text is stored, so a value typed into the edit never lands
    // in the database even if no worker ever picks the run up. The worker's run redactor also masks
    // encoded forms before any model sees it.
    const secretRepo = new SecretRepository(this.deps.db);
    const fingerprints = await secretRepo.listFingerprints(runId);
    // Credentials written into the chosen text are used, not ignored (V1.3.1), as at creation: passwords become
    // the run's secrets (encrypted here) and leave the text, emails and usernames become its test data.
    const inline = await this.takeInlineInputs(runId, run.request, text, await secretRepo.listNames(runId));
    const requirement = redactFingerprintedSecrets(redactByKey(inline) as string, fingerprints, this.deps.config.secretsKey);

    let selected: Awaited<ReturnType<SuggestionRepository["select"]>>;
    try {
      selected = await this.suggestions.select(runId, { suggestionId, requirement, edited });
    } catch (err) {
      // Lost a race: another selection, a cancel or the reaper moved the run first.
      if (err instanceof StaleTransitionError) throw notAwaiting(err.actual);
      if (err instanceof UnknownSuggestionError) throw unknownSuggestion(suggestionId);
      throw err;
    }
    observeStage(this.deps.metrics, "AWAITING_SELECTION", run.lifecycleChangedAt, selected.run.lifecycleChangedAt);

    await this.publisher().publish({
      runId,
      stage: "AWAITING_SELECTION", // the lifecycle the choice was made in, as criteria.confirmed does
      type: "suggestion.selected",
      message: `Suggestion ${suggestionId} selected${edited ? " (edited)" : ""}`,
      payload: { suggestionId, edited },
    });

    try {
      await this.deps.queue.enqueueAnalyzeAfterSelection(runId);
    } catch {
      await this.failEnqueue(runId, selected.run.lifecycleChangedAt);
      throw new HttpError(503, "QUEUE_UNAVAILABLE", "The run could not be queued; please retry");
    }
    return summaryOf(this.deps.db, selected.run);
  }

  /** Stores the credentials `text` names (extractInlineInputs) on the run; returns the text with passwords replaced. */
  private async takeInlineInputs(runId: string, request: StoredTestRunRequest, text: string, secretNames: string[]): Promise<string> {
    // The API holds no secret plaintext: existing secrets are passed by name only, so theirs are never reused.
    const inline = extractInlineInputs(text, {
      testData: request.testData,
      secrets: Object.fromEntries(secretNames.map((n) => [n, "\u0000"])),
      maxSecrets: MAX_SECRETS,
      maxTestData: MAX_TEST_DATA_ENTRIES,
    });
    if (inline.found.length === 0) return text;
    const key = this.deps.config.secretsKey;
    await new SecretRepository(this.deps.db).insertMany(
      runId,
      Object.entries(inline.secrets).map(([name, value]) => ({
        name,
        ...encryptSecret(value, { runId, name }, key),
        fingerprint: secretFingerprint(value, key).digest,
      })),
    );
    await this.runs.addInlineInputs(runId, { testData: inline.testData, secretNames: Object.keys(inline.secrets), found: inline.found });
    return inline.text;
  }

  private async failEnqueue(runId: string, analyzingAt: Date): Promise<void> {
    try {
      const errored = await this.runs.transition(runId, "ANALYZING_REQUIREMENT", "ERRORED", {
        errorCategory: "INTERNAL",
        errorMessage: ENQUEUE_FAILED,
      });
      observeStage(this.deps.metrics, "ANALYZING_REQUIREMENT", analyzingAt, errored.lifecycleChangedAt);
      this.deps.metrics?.testRuns.inc({ lifecycle: "ERRORED", verdict: NO_VERDICT });
      await new SecretRepository(this.deps.db).purge(runId);
      await this.publisher().publish({
        runId,
        stage: "ERRORED",
        type: "run.errored",
        message: "Run could not be queued",
        payload: { category: "INTERNAL", message: ENQUEUE_FAILED },
      });
    } catch {
      // best effort; mirrors CriteriaService.failEnqueue
    }
  }
}
