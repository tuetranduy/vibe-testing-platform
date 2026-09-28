import { describe, expect, it } from "vitest";
import {
  CreateTestRunRequestSchema,
  CriterionResultSchema,
  destructiveActionsAllowed,
  ElementRefSchema,
  NormalizedRequirementSchema,
  ObservedFactSchema,
  PlannedStepSchema,
  RerunResultSchema,
  RunLifecycleSchema,
  RunVerdictSchema,
  TEST_EVENT_TYPES,
  TestEventSchema,
  TestPlanSchema,
  TestReportSchema,
  isTerminalEvent,
  isTerminalLifecycle,
  type NormalizedRequirement,
} from "./index";

const baseReq = { targetUrl: "https://x.com", requirement: "Test the login page" };

describe("CreateTestRunRequestSchema", () => {
  it.each(["not-a-url", "javascript:alert(1)", "file:///etc/passwd", "ftp://x.com"])("rejects %s", (targetUrl) => {
    expect(CreateTestRunRequestSchema.safeParse({ ...baseReq, targetUrl }).success).toBe(false);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(CreateTestRunRequestSchema.safeParse({ ...baseReq, targetUrl: "https://u:p@x.com" }).success).toBe(false);
  });

  it("accepts http and https URLs", () => {
    expect(CreateTestRunRequestSchema.safeParse({ ...baseReq, targetUrl: "http://demo-shop:4000/" }).success).toBe(true);
  });

  it("applies nested option defaults when options are omitted", () => {
    // Guards against Zod 4 .default() short-circuit: must use .prefault({})
    const r = CreateTestRunRequestSchema.parse(baseReq);
    expect(r.options.maxExplorationSteps).toBe(40);
    expect(r.options.autoConfirmCriteria).toBe(false);
    expect(r.options.maxRunSeconds).toBe(300);
    expect(r.options.additionalAllowedHosts).toEqual([]);
    expect(r.environment).toBe("staging");
    expect(r.browser).toBe("chromium");
    expect(r.testData).toEqual({});
    expect(r.secrets).toEqual({});
  });

  it("applies nested defaults when options is partially given", () => {
    const r = CreateTestRunRequestSchema.parse({ ...baseReq, options: { maxRunSeconds: 120 } });
    expect(r.options.maxRunSeconds).toBe(120);
    expect(r.options.generatePlaywright).toBe(true);
  });

  it("rejects a requirement shorter than 10 characters after trim", () => {
    expect(CreateTestRunRequestSchema.safeParse({ ...baseReq, requirement: "   short   " }).success).toBe(false);
  });

  describe("destructive actions in production (D9, amended 2026-09-28)", () => {
    const prod = (options: Record<string, unknown>, targetUrl = "https://Shop.Example.com:8443/path") =>
      CreateTestRunRequestSchema.safeParse({ ...baseReq, targetUrl, environment: "production", options });
    const paths = (r: { error?: { issues: { path: PropertyKey[] }[] } }) => r.error?.issues.map((i) => i.path);

    it("need the target host typed as confirmation", () => {
      const r = prod({ allowDestructiveActions: true });
      expect(paths(r)).toEqual([["options", "confirmProductionHost"]]);
      expect(r.error?.issues[0]?.message).toBe(
        "Type the website's host (shop.example.com:8443) to allow destructive actions in production",
      );
    });

    it("reject a different host (the port is part of it)", () => {
      expect(paths(prod({ allowDestructiveActions: true, confirmProductionHost: "shop.example.com" }))).toEqual([
        ["options", "confirmProductionHost"],
      ]);
    });

    it("accept the host in any case, trimmed, with its port", () => {
      expect(prod({ allowDestructiveActions: true, confirmProductionHost: "  SHOP.example.com:8443 " }).success).toBe(true);
    });

    it("leave a URL that doesn't parse to its own issue (no crash, no confirmation issue)", () => {
      const r = prod({ allowDestructiveActions: true }, "not a url");
      expect(r.success).toBe(false);
      expect(paths(r)).toContainEqual(["targetUrl"]);
      expect(paths(r)).not.toContainEqual(["options", "confirmProductionHost"]);
    });

    it.each([
      ["staging", { allowDestructiveActions: true, confirmProductionHost: "x.com" }],
      ["production", { confirmProductionHost: "x.com" }],
    ] as const)("reject the confirmation where it is not used (%s)", (environment, options) => {
      const r = CreateTestRunRequestSchema.safeParse({ ...baseReq, environment, options });
      expect(paths(r)).toEqual([["options", "confirmProductionHost"]]);
      expect(r.error?.issues[0]?.message).toBe("Only used when destructive actions are allowed in production");
    });
  });

  it("defaults the rerun off when destructive actions are allowed, on otherwise, and keeps an explicit value", () => {
    expect(CreateTestRunRequestSchema.parse(baseReq).options.rerunGeneratedTest).toBe(true);
    expect(CreateTestRunRequestSchema.parse({ ...baseReq, options: { allowDestructiveActions: true } }).options.rerunGeneratedTest).toBe(false);
    expect(
      CreateTestRunRequestSchema.parse({ ...baseReq, options: { allowDestructiveActions: true, rerunGeneratedTest: true } }).options
        .rerunGeneratedTest,
    ).toBe(true);
  });

  it("rejects rerun without generation", () => {
    const r = CreateTestRunRequestSchema.safeParse({
      ...baseReq,
      options: { generatePlaywright: false, rerunGeneratedTest: true },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["options", "rerunGeneratedTest"]);
  });

  it("rejects bad secret names, short secret values, and too many secrets", () => {
    expect(CreateTestRunRequestSchema.safeParse({ ...baseReq, secrets: { Password: "abcd" } }).success).toBe(false);
    expect(CreateTestRunRequestSchema.safeParse({ ...baseReq, secrets: { password: "abc" } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`s${i}`, "abcdef"]));
    expect(CreateTestRunRequestSchema.safeParse({ ...baseReq, secrets: many }).success).toBe(false);
  });

  it("limits test data to 50 entries", () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i]));
    expect(CreateTestRunRequestSchema.safeParse({ ...baseReq, testData: many }).success).toBe(false);
  });
});

function requirement(overrides: Partial<NormalizedRequirement> = {}): unknown {
  return {
    runId: "run_1",
    revision: 1,
    originalText: "A user can add a product to the cart. The cart count should increase.",
    criteria: [
      {
        id: "AC-1",
        sourceText: "The cart count should increase.",
        statement: "Cart count increases after adding a product",
        expectedOutcome: {
          kind: "numeric_compare",
          left: { key: "cartCount", checkpoint: "after_add" },
          operator: "gt",
          right: { key: "cartCount", checkpoint: "before_add" },
        },
        preconditions: [],
        ambiguity: null,
      },
      {
        id: "AC-2",
        sourceText: "A user can add a product to the cart.",
        statement: "Cart page URL is reached",
        expectedOutcome: {
          kind: "text_matches",
          fact: { key: "url", checkpoint: "after_add" },
          match: { mode: "contains", value: "/cart" },
        },
        ambiguity: null,
      },
    ],
    facts: [
      { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
      { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
    ],
    confirmedAt: null,
    ...overrides,
  };
}

describe("NormalizedRequirementSchema", () => {
  it("accepts a well-formed requirement, including the reserved url fact at a declared checkpoint", () => {
    const r = NormalizedRequirementSchema.safeParse(requirement());
    expect(r.error?.issues).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("rejects a FactRef that points to an undeclared fact", () => {
    const req = requirement() as NormalizedRequirement;
    (req.criteria[0]!.expectedOutcome as { left: { key: string } }).left.key = "badgeCount";
    const r = NormalizedRequirementSchema.safeParse(req);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["criteria", 0, "expectedOutcome", "left"]);
  });

  it("rejects the url fact at an undeclared checkpoint", () => {
    const req = requirement() as NormalizedRequirement;
    (req.criteria[1]!.expectedOutcome as { fact: { checkpoint: string } }).fact.checkpoint = "cart_page";
    expect(NormalizedRequirementSchema.safeParse(req).success).toBe(false);
  });

  it("rejects declaring the reserved url fact", () => {
    const req = requirement() as NormalizedRequirement;
    req.facts.push({ key: "url", checkpoint: "after_add", description: "the url", valueType: "string" });
    expect(NormalizedRequirementSchema.safeParse(req).success).toBe(false);
  });

  it("rejects duplicate (key, checkpoint) facts", () => {
    const req = requirement() as NormalizedRequirement;
    req.facts.push({ ...req.facts[0]! });
    expect(NormalizedRequirementSchema.safeParse(req).success).toBe(false);
  });

  it("rejects sourceText that is not a verbatim substring of originalText", () => {
    const req = requirement() as NormalizedRequirement;
    req.criteria[0]!.sourceText = "The cart count must go up.";
    const r = NormalizedRequirementSchema.safeParse(req);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["criteria", 0, "sourceText"]);
  });

  it("rejects duplicate criterion ids", () => {
    const req = requirement() as NormalizedRequirement;
    req.criteria[1]!.id = "AC-1";
    const r = NormalizedRequirementSchema.safeParse(req);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["criteria", 1, "id"]);
  });

  it("requires at least one criterion", () => {
    expect(NormalizedRequirementSchema.safeParse(requirement({ criteria: [] })).success).toBe(false);
  });

  it("accepts a semantic outcome with no fact refs", () => {
    const req = requirement() as NormalizedRequirement;
    req.criteria[0]!.expectedOutcome = { kind: "semantic", description: "The page should feel fast" };
    expect(NormalizedRequirementSchema.safeParse(req).success).toBe(true);
  });
});

const scenario = {
  id: "SC-1",
  title: "Add to cart",
  criterionIds: ["AC-1"],
  steps: [{ id: "PS-1", kind: "navigate", description: "Open the home page" }],
};

describe("TestPlanSchema", () => {
  const plan = { runId: "run_1", requirementRevision: 1, scenarios: [scenario], blockedCriteria: [], stopConditions: [] };

  it("accepts exactly one scenario", () => {
    expect(TestPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects more than one scenario in V1", () => {
    expect(TestPlanSchema.safeParse({ ...plan, scenarios: [scenario, scenario] }).success).toBe(false);
  });

  it("rejects a capture_checkpoint step without a checkpoint", () => {
    expect(PlannedStepSchema.safeParse({ id: "PS-2", kind: "capture_checkpoint", description: "Capture" }).success).toBe(
      false,
    );
  });
});

const envelope = {
  id: "evt_1",
  runId: "run_1",
  sequence: 1,
  timestamp: "2026-09-25T10:00:00.000Z",
  stage: "VERIFYING",
  message: "AC-1 evaluated",
};

describe("TestEventSchema", () => {
  it("rejects a payload that does not match the event type", () => {
    expect(TestEventSchema.safeParse({ ...envelope, type: "criterion.evaluated", payload: {} }).success).toBe(false);
  });

  it("accepts a matching payload", () => {
    const r = TestEventSchema.safeParse({
      ...envelope,
      type: "criterion.evaluated",
      payload: { criterionId: "AC-1", status: "PASS", reason: null, provisional: true },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown event type", () => {
    expect(TestEventSchema.safeParse({ ...envelope, type: "model.thought", payload: {} }).success).toBe(false);
  });

  it("rejects messages over 300 characters", () => {
    expect(
      TestEventSchema.safeParse({ ...envelope, type: "run.created", message: "x".repeat(301), payload: { targetHost: "x.com" } })
        .success,
    ).toBe(false);
  });

  it("never carries a fact value", () => {
    const r = TestEventSchema.parse({
      ...envelope,
      type: "fact.observed",
      payload: { key: "cartCount", checkpoint: "after_add", provenance: "DOM_VERIFIED", value: 3 },
    });
    expect(r.payload).not.toHaveProperty("value");
  });

  it("playwright.completed carries each criterion's rerun outcome (Ruling R43); older events without it still parse", () => {
    const base = { ...envelope, stage: "RUNNING_PLAYWRIGHT", type: "playwright.completed" };
    const current = TestEventSchema.parse({
      ...base,
      payload: { status: "FAILED", durationMs: 12, perCriterion: { "AC-1": "ASSERTION_FAILED", "AC-2": "NOT_REACHED" } },
    });
    expect(current.payload).toEqual({ status: "FAILED", durationMs: 12, perCriterion: { "AC-1": "ASSERTION_FAILED", "AC-2": "NOT_REACHED" } });
    const older = TestEventSchema.parse({ ...base, payload: { status: "PASSED", durationMs: 5 } });
    expect(older.payload).toEqual({ status: "PASSED", durationMs: 5, perCriterion: {} });
    expect(TestEventSchema.safeParse({ ...base, payload: { status: "FAILED", durationMs: 1, perCriterion: { "AC-1": "FAILED" } } }).success).toBe(false);
    expect(TestEventSchema.safeParse({ ...base, payload: { status: "FAILED", durationMs: 1, perCriterion: { "criterion one": "PASSED" } } }).success).toBe(false);
  });

  it("lists every type and knows the terminal ones", () => {
    expect(TEST_EVENT_TYPES).toHaveLength(19);
    expect(isTerminalEvent({ type: "run.completed" })).toBe(true);
    expect(isTerminalEvent({ type: "stage.completed" })).toBe(false);
  });
});

describe("statuses", () => {
  it("keeps lifecycle and verdict separate", () => {
    expect(RunLifecycleSchema.options).not.toContain("PASSED");
    expect(RunVerdictSchema.options).not.toContain("COMPLETED");
  });

  it("knows the terminal lifecycles", () => {
    expect(RunLifecycleSchema.options.filter(isTerminalLifecycle)).toEqual(["COMPLETED", "ERRORED", "CANCELLED"]);
  });
});

describe("exploration and results", () => {
  const el = { candidates: [{ strategy: "role", role: "button", name: "Add to cart", exact: true }], chosenIndex: 0 };

  it("rejects chosenIndex outside candidates", () => {
    expect(ElementRefSchema.safeParse({ ...el, chosenIndex: 1 }).success).toBe(false);
  });

  it("requires a read for DOM_VERIFIED facts other than url", () => {
    const base = { key: "cartCount", checkpoint: "after_add", value: 1, provenance: "DOM_VERIFIED", read: null, stepId: "s1" };
    expect(ObservedFactSchema.safeParse(base).success).toBe(false);
    expect(ObservedFactSchema.safeParse({ ...base, key: "url", value: "https://x.com" }).success).toBe(true);
    expect(ObservedFactSchema.safeParse({ ...base, read: { element: el, mode: "number" } }).success).toBe(true);
  });

  it("keeps a disagreeing DOM reading next to the model value on MODEL_EXTRACTED facts", () => {
    const fact = {
      key: "cartCount",
      checkpoint: "after_add",
      value: 2,
      provenance: "MODEL_EXTRACTED",
      read: { element: el, mode: "number" },
      modelValue: 2,
      domValue: 1,
      stepId: "s1",
    };
    expect(ObservedFactSchema.parse(fact)).toMatchObject({ value: 2, modelValue: 2, domValue: 1 });
  });

  it("requires verdictSource exactly for PASS/FAIL", () => {
    const r = {
      criterionId: "AC-1",
      status: "PASS",
      reason: null,
      factRefs: [],
      expected: "x",
      actual: "y",
      verdictSource: null,
      rerunOutcome: "PASSED",
      provisional: { status: "PASS", reason: null },
      evidenceArtifactIds: [],
      relatedStepIds: [],
      aiNote: null,
    };
    expect(CriterionResultSchema.safeParse(r).success).toBe(false);
    expect(CriterionResultSchema.safeParse({ ...r, verdictSource: "PLAYWRIGHT_RERUN" }).success).toBe(true);
    expect(
      CriterionResultSchema.safeParse({ ...r, status: "INCONCLUSIVE", reason: "DISCOVERY_RERUN_DISAGREE" }).success,
    ).toBe(true);
  });

  it("parses a minimal partial report", () => {
    const report = {
      runId: "run_1",
      lifecycle: "ERRORED",
      verdict: null,
      error: { category: "TIMEOUT", message: "Hard deadline exceeded" },
      partial: true,
      targetUrl: "https://x.com",
      requirement: null,
      summary: { totalCriteria: 0, passed: 0, failed: 0, blocked: 0, inconclusive: 0, confirmedByRerun: 0 },
      criteria: [],
      generatedTest: null,
      playwright: null,
      diagnostics: [],
      usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    };
    expect(TestReportSchema.safeParse(report).success).toBe(true);
  });
});

describe("RerunResultSchema", () => {
  it("carries the ids of the uploaded rerun evidence, defaulting to none (Ruling R27)", () => {
    const base = { status: "FAILED", perCriterion: { "AC-1": "ASSERTION_FAILED" }, durationMs: 1200 };
    expect(RerunResultSchema.parse(base)).toEqual({ ...base, errorText: {}, artifactIds: [] });
    expect(RerunResultSchema.parse({ ...base, artifactIds: ["art_1", "art_2"] }).artifactIds).toEqual(["art_1", "art_2"]);
    expect(RerunResultSchema.safeParse({ ...base, artifactIds: [1] }).success).toBe(false);
  });
});

describe("destructiveActionsAllowed", () => {
  const defaults = CreateTestRunRequestSchema.parse(baseReq).options;
  const req = (environment: "staging" | "production", allowDestructiveActions: boolean, confirmProductionHost?: string) => ({
    targetUrl: "https://shop.example.com/",
    environment,
    options: { ...defaults, allowDestructiveActions, ...(confirmProductionHost === undefined ? {} : { confirmProductionHost }) },
  });

  it.each([
    ["staging", false, undefined, false],
    ["staging", true, undefined, true],
    ["production", false, undefined, false],
    ["production", true, undefined, false],
    ["production", true, "other.example.com", false],
    ["production", true, "SHOP.example.com", true],
  ] as const)("%s, allowDestructiveActions=%s, confirmProductionHost=%s → %s", (environment, allow, host, expected) => {
    expect(destructiveActionsAllowed(req(environment, allow, host))).toBe(expected);
  });
});
