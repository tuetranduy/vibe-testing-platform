import { RequirementRepository, RunRepository, SecretRepository, SiteAnalysisRepository, SuggestionRepository } from "@platform/db";
import { ContractError, ModelProviderError, type EngineStages, type StageContext } from "@platform/testing-engine";
import { encryptSecret } from "@platform/security";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEEDED_SUGGESTIONS, createFakeStages, createHarness, eventsOf, requestCancel, seedRun, type WorkerHarness } from "../test-support";
import { analyzeRunJob } from "./analyze-run";

let h: WorkerHarness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h?.close());

describe("analyze-run", () => {
  it("autoConfirmCriteria=false: QUEUED → ANALYZING_REQUIREMENT → AWAITING_CONFIRMATION, no execute-run", async () => {
    const run = await seedRun(h, { secrets: { password: "pw-123456" } });
    await analyzeRunJob(h.deps(createFakeStages()), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("AWAITING_CONFIRMATION");
    expect(after.heartbeatAt).toBeNull();
    const events = await eventsOf(h, run.id);
    expect(events.map((e) => e.type)).toEqual(["stage.started", "criteria.proposed", "stage.completed"]);
    const proposed = events.find((e) => e.type === "criteria.proposed")!;
    expect(proposed.message).toBe("2 acceptance criteria identified");
    expect(proposed.stage).toBe("ANALYZING_REQUIREMENT");
    expect((await new RequirementRepository(h.tdb.db).getLatest(run.id)).revision).toBe(1);
    expect(h.queue.execute).not.toContain(run.id);
    // Secrets stay until the run ends: the user hasn't confirmed yet.
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(1);
  });

  it("autoConfirmCriteria=true: ends at PLANNING and enqueues execute-run", async () => {
    const run = await seedRun(h, { options: { autoConfirmCriteria: true } });
    await analyzeRunJob(h.deps(createFakeStages()), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("PLANNING");
    expect(after.heartbeatAt).toBeInstanceOf(Date);
    expect(h.queue.execute).toContain(run.id);
    expect((await new RequirementRepository(h.tdb.db).getLatest(run.id)).confirmedAt).not.toBeNull();
    expect((await eventsOf(h, run.id)).map((e) => e.type)).toContain("criteria.confirmed");
  });

  it("stores the live-site analysis; auto-confirmed criteria take its suggested test data into the run (V1.3)", async () => {
    const run = await seedRun(h, { options: { autoConfirmCriteria: true } });
    const fake = createFakeStages();
    await analyzeRunJob(
      h.deps({
        ...fake,
        analyze: async (ctx) => {
          const analyzed = await fake.analyze(ctx);
          return {
            ...analyzed,
            siteAnalysis: {
              ...analyzed.siteAnalysis!,
              testData: [{ key: "email", value: "qa.abc123@example.com", description: "Email to register with", source: "GENERATED" as const }],
            },
          };
        },
      }),
      run.id,
    );
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("PLANNING");
    expect(after.request.testData).toMatchObject({ email: "qa.abc123@example.com" });
    const analysis = await new SiteAnalysisRepository(h.tdb.db).get(run.id);
    expect(analysis).toMatchObject({ status: "READ", appliedKeys: ["email"] });
    expect(analysis!.checks.map((c) => c.criterionId)).toEqual(["AC-1", "AC-2"]);
  });

  it("criteria waiting for review: the suggested test data waits too", async () => {
    const run = await seedRun(h);
    await analyzeRunJob(h.deps(createFakeStages()), run.id);
    expect(await new SiteAnalysisRepository(h.tdb.db).get(run.id)).toMatchObject({ status: "READ", appliedKeys: [] });
    expect((await new RunRepository(h.tdb.db).getById(run.id)).request.testData).toEqual({});
  });

  it("skips runs that are no longer QUEUED (e.g. cancelled before pickup)", async () => {
    const run = await seedRun(h);
    await new RunRepository(h.tdb.db).transition(run.id, "QUEUED", "CANCELLED", { cancelReason: "USER_REQUESTED" });
    await analyzeRunJob(h.deps(createFakeStages()), run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("CANCELLED");
    expect(await eventsOf(h, run.id)).toEqual([]);
  });

  it("maps a model failure to ERRORED / MODEL_PROVIDER and purges secrets", async () => {
    const run = await seedRun(h, { secrets: { password: "pw-123456" } });
    const stages = createFakeStages({ failAt: { stage: "analyze", error: new ModelProviderError("provider 503 for pw-123456") } });
    await analyzeRunJob(h.deps(stages), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("MODEL_PROVIDER");
    const errored = (await eventsOf(h, run.id)).find((e) => e.type === "run.errored")!;
    expect(errored.payload).toEqual({ category: "MODEL_PROVIDER", message: "provider 503 for pw-123456" });
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });

  it("honours a cancel requested while criteria are being saved (no Redis signal)", async () => {
    const run = await seedRun(h);
    const stages = createFakeStages({ onStage: (s) => (s === "analyze" ? requestCancel(h, run.id, false) : undefined) });
    await analyzeRunJob(h.deps(stages), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("CANCELLED");
    expect((await eventsOf(h, run.id)).at(-1)!.type).toBe("run.cancelled");
  });

  it("errors a QUEUED run whose secrets can't be decrypted instead of leaving it QUEUED", async () => {
    const run = await seedRun(h);
    await new SecretRepository(h.tdb.db).insertMany(run.id, [
      { name: "password", ...encryptSecret("pw-123456", { runId: run.id, name: "password" }, Buffer.alloc(32, 1)) },
    ]);
    await analyzeRunJob(h.deps(createFakeStages()), run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("INTERNAL");
  });

  it("times out analysis after ANALYSIS_TIMEOUT_SECONDS → ERRORED / TIMEOUT", async () => {
    const run = await seedRun(h);
    const stages = createFakeStages({ analyzeDelayMs: 5_000 });
    const deps = h.deps(stages);
    deps.config.analysisTimeoutSeconds = 10; // × timeScale 0.01 = 100 ms
    await analyzeRunJob(deps, run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("TIMEOUT");
  });
});

describe("analyze-run: the survey and the selection", () => {
  it("a blank requirement: QUEUED → SURVEYING → AWAITING_SELECTION, the suggestions stored, no heartbeat, no analysis", async () => {
    const run = await seedRun(h, { requirement: "" });
    await analyzeRunJob(h.deps(createFakeStages()), run.id);

    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("AWAITING_SELECTION");
    expect(after.heartbeatAt).toBeNull();
    const set = await new SuggestionRepository(h.tdb.db).get(run.id);
    expect(set?.suggestions.map((s) => s.id)).toEqual(["S-1", "S-2", "S-3"]);
    expect(set?.selected).toBeNull();
    expect(await new RequirementRepository(h.tdb.db).findLatest(run.id)).toBeNull();
    const events = await eventsOf(h, run.id);
    expect(events.map((e) => e.type)).toEqual(["stage.started", "page.surveyed", "page.surveyed", "suggestions.proposed", "stage.completed"]);
    expect(events.every((e) => e.stage === "SURVEYING")).toBe(true);
    expect(h.queue.execute).not.toContain(run.id);
  });

  it("waits for the user even with autoConfirmCriteria: nothing is chosen automatically", async () => {
    const run = await seedRun(h, { requirement: "", options: { autoConfirmCriteria: true } });
    await analyzeRunJob(h.deps(createFakeStages()), run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("AWAITING_SELECTION");
    expect(h.queue.execute).not.toContain(run.id);
  });

  it("the survey's deadline is SURVEY_TIMEOUT_SECONDS and its page budget 60 % of it", async () => {
    const run = await seedRun(h, { requirement: "" });
    const fake = createFakeStages();
    // A holder, not a `let`: TypeScript would keep a `let … = null` narrowed to null after the closure assigns it.
    const seen: { explorationMs?: number; deadlineAt?: StageContext["deadlineAt"] } = {};
    const stages: EngineStages = {
      ...fake,
      survey: async (ctx) => {
        seen.explorationMs = ctx.budgets.explorationMs;
        seen.deadlineAt = ctx.deadlineAt;
        return fake.survey(ctx);
      },
    };
    const deps = h.deps(stages);
    deps.config.surveyTimeoutSeconds = 100; // × timeScale 0.01 = 1 s
    const before = Date.now();
    await analyzeRunJob(deps, run.id);
    expect(seen.explorationMs).toBe(600);
    const deadlineIn = seen.deadlineAt!.getTime() - before;
    expect(deadlineIn).toBeGreaterThanOrEqual(900);
    expect(deadlineIn).toBeLessThanOrEqual(1_500);
  });

  it("a survey past SURVEY_TIMEOUT_SECONDS ends ERRORED / TIMEOUT", async () => {
    const run = await seedRun(h, { requirement: "", secrets: { password: "pw-123456" } });
    const deps = h.deps(createFakeStages({ stepDelayMs: 5_000 }));
    deps.config.surveyTimeoutSeconds = 10; // × timeScale 0.01 = 100 ms
    await analyzeRunJob(deps, run.id);
    const after = await new RunRepository(h.tdb.db).getById(run.id);
    expect(after.lifecycle).toBe("ERRORED");
    expect(after.errorCategory).toBe("TIMEOUT");
    expect(await new SecretRepository(h.tdb.db).listActive(run.id)).toHaveLength(0);
  });

  it("a survey with no valid suggestion ends ERRORED / CONTRACT", async () => {
    const run = await seedRun(h, { requirement: "" });
    await analyzeRunJob(h.deps(createFakeStages({ failAt: { stage: "survey", error: new ContractError("No valid test suggestion") } })), run.id);
    expect(await new RunRepository(h.tdb.db).getById(run.id)).toMatchObject({ lifecycle: "ERRORED", errorCategory: "CONTRACT" });
  });

  it("after a selection: analyses the chosen text from ANALYZING_REQUIREMENT, without the QUEUED transition", async () => {
    const run = await seedRun(h, { lifecycle: "AWAITING_SELECTION", requirement: "" });
    const chosen = SEEDED_SUGGESTIONS.suggestions[0]!;
    await new SuggestionRepository(h.tdb.db).select(run.id, { suggestionId: chosen.id, requirement: chosen.requirement, edited: false });

    await analyzeRunJob(h.deps(createFakeStages()), run.id);

    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("AWAITING_CONFIRMATION");
    expect((await new RequirementRepository(h.tdb.db).getLatest(run.id)).originalText).toBe(chosen.requirement);
    expect((await eventsOf(h, run.id)).map((e) => e.type)).toEqual(["stage.started", "criteria.proposed", "stage.completed"]);
  });

  it("a secret value in a selected text reaches the model and the stored text as typed (secrets are not redacted)", async () => {
    const secret = "pw-Sel3cted-Secret";
    const run = await seedRun(h, { lifecycle: "AWAITING_SELECTION", requirement: "", secrets: { password: secret } });
    const edited = `Sign in with the password ${secret} and see the account page.`;
    await new SuggestionRepository(h.tdb.db).select(run.id, { suggestionId: "S-2", requirement: edited, edited: true });
    const fake = createFakeStages();
    let analysed = "";
    await analyzeRunJob(
      h.deps({
        ...fake,
        analyze: async (ctx) => {
          analysed = ctx.request.requirement;
          return fake.analyze(ctx);
        },
      }),
      run.id,
    );
    expect(analysed).toBe(edited);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).request.requirement).toBe(analysed);
    expect((await new RequirementRepository(h.tdb.db).getLatest(run.id)).originalText).toBe(analysed);
  });

  it("skips an ANALYZING_REQUIREMENT run that has no selection", async () => {
    const run = await seedRun(h, { lifecycle: "ANALYZING_REQUIREMENT" });
    await analyzeRunJob(h.deps(createFakeStages()), run.id);
    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("ANALYZING_REQUIREMENT");
    expect(await eventsOf(h, run.id)).toEqual([]);
  });

  it("skips a selection whose analysis already saved criteria (a duplicate job while the first is still running)", async () => {
    const run = await seedRun(h, { lifecycle: "AWAITING_SELECTION", requirement: "" });
    const chosen = SEEDED_SUGGESTIONS.suggestions[0]!;
    const { run: selected } = await new SuggestionRepository(h.tdb.db).select(run.id, {
      suggestionId: chosen.id,
      requirement: chosen.requirement,
      edited: false,
    });
    // The first job got as far as saving revision 1 (the run is still ANALYZING_REQUIREMENT).
    const draft = await createFakeStages().analyze({ request: selected.request } as never);
    await new RequirementRepository(h.tdb.db).createRevision(run.id, draft);

    await analyzeRunJob(h.deps(createFakeStages()), run.id);

    expect((await new RunRepository(h.tdb.db).getById(run.id)).lifecycle).toBe("ANALYZING_REQUIREMENT");
    expect(await eventsOf(h, run.id)).toEqual([]);
  });
});
