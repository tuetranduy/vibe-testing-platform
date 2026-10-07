import type { AcceptanceCriterion, PlannedStep } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { applyBlocking, type BlockingInput } from "./blocking";

const criterion = (id: string, checkpoint: string | null, preconditions: AcceptanceCriterion["preconditions"] = []): AcceptanceCriterion => ({
  id,
  sourceText: "x",
  statement: `Statement ${id}`,
  expectedOutcome: checkpoint
    ? { kind: "visible", fact: { key: "thing", checkpoint }, expected: true }
    : { kind: "semantic", description: "Looks right" },
  preconditions,
  critical: true,
  ambiguity: null,
});

let n = 0;
const s = (kind: PlannedStep["kind"], description: string, extra: Partial<PlannedStep> = {}): PlannedStep => ({
  id: `PS-${++n}`,
  kind,
  description,
  criterionIds: [],
  destructive: false,
  ...extra,
});

function input(criteria: AcceptanceCriterion[], steps: PlannedStep[], extra: Partial<BlockingInput> = {}): BlockingInput {
  return {
    criteria,
    steps,
    targetUrl: "https://shop.example.com",
    policy: { allowDestructive: false },
    ...extra,
  };
}

const reasons = (r: ReturnType<typeof applyBlocking>) => r.blockedCriteria.map((b) => [b.criterionId, b.reason]);

describe("applyBlocking", () => {
  it("a secret or test data value nobody provided never blocks (it is generated at fill time); a destructive step still does", () => {
    n = 0;
    const steps = [
      s("fill", "Enter the email", { inputRef: { source: "testData", key: "email" } }),
      s("fill", "Enter the password", { inputRef: { source: "secret", key: "password" } }),
      s("click", "Click Delete account"),
      s("capture_checkpoint", "Capture", { checkpoint: "done" }),
    ];
    expect(reasons(applyBlocking(input([criterion("AC-1", "done")], steps)))).toEqual([["AC-1", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"]]);
    const fills = steps.slice(0, 2).concat(steps[3]!);
    expect(applyBlocking(input([criterion("AC-1", "done")], fills)).blockedCriteria).toEqual([]);
  });

  it("steps after a criterion's last needed checkpoint do not affect it", () => {
    n = 0;
    const steps = [
      s("capture_checkpoint", "Capture home", { checkpoint: "home" }),
      s("fill", "Enter the password", { inputRef: { source: "secret", key: "password" } }),
      s("click", "Click Delete account"),
      s("capture_checkpoint", "Capture after", { checkpoint: "after" }),
    ];
    const r = applyBlocking(input([criterion("AC-1", "home"), criterion("AC-2", "after")], steps));
    expect(reasons(r)).toEqual([["AC-2", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"]]);
    expect(r.steps.map((x) => x.id)).toEqual(["PS-1", "PS-2"]);
  });

  it("a semantic criterion depends on the steps up to the last step that references it", () => {
    n = 0;
    const steps = [
      s("navigate", "Open home", { criterionIds: ["AC-2"] }),
      s("click", "Click Delete account", { criterionIds: ["AC-1"] }),
    ];
    expect(reasons(applyBlocking(input([criterion("AC-1", null), criterion("AC-2", null)], steps)))).toEqual([
      ["AC-1", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"],
    ]);
  });

  it("a semantic criterion no step references depends on the whole scenario: a destructive step blocks it", () => {
    n = 0;
    const steps = [s("navigate", "Open the account page"), s("click", "Click Delete account"), s("other", "Look at the page")];
    const r = applyBlocking(input([criterion("AC-1", null)], steps));
    expect(reasons(r)).toEqual([["AC-1", "DESTRUCTIVE_ACTION_NOT_AUTHORIZED"]]);
    expect(r.steps.map((x) => x.id)).toEqual(["PS-1"]);
  });

  it("a semantic criterion no step references depends on the whole scenario: a missing secret does not block it", () => {
    n = 0;
    const steps = [
      s("navigate", "Open the login page"),
      s("fill", "Enter the password", { inputRef: { source: "secret", key: "password" } }),
      s("login", "Click Log in"),
    ];
    expect(reasons(applyBlocking(input([criterion("AC-1", null)], steps)))).toEqual([]);
  });

  it("test_data and secret preconditions never block, with or without a ref, provided or not", () => {
    n = 0;
    const steps = [s("capture_checkpoint", "Capture", { checkpoint: "home" })];
    const r = applyBlocking(
      input(
        [
          criterion("AC-1", "home", [{ kind: "test_data", description: "Some order" }]),
          criterion("AC-2", "home", [{ kind: "test_data", ref: "orderNumber", description: "Order number" }]),
          criterion("AC-3", "home", [{ kind: "test_data", ref: "sku", description: "SKU" }]),
          criterion("AC-4", "home", [{ kind: "secret", ref: "admin_token", description: "Admin token" }]),
        ],
        steps,
      ),
    );
    expect(reasons(r)).toEqual([]);
  });

  it("literal inputRefs never block", () => {
    n = 0;
    const steps = [
      s("search", "Search for the product", { inputRef: { source: "literal", key: "shoes" } }),
      s("capture_checkpoint", "Capture", { checkpoint: "results" }),
    ];
    expect(applyBlocking(input([criterion("AC-1", "results")], steps)).blockedCriteria).toEqual([]);
  });

  it("marks steps the policy matches as destructive when destructive actions are allowed", () => {
    n = 0;
    const steps = [s("click", "Click Pay now"), s("capture_checkpoint", "Capture", { checkpoint: "paid" })];
    const r = applyBlocking(input([criterion("AC-1", "paid")], steps, { policy: { allowDestructive: true } }));
    expect(r.blockedCriteria).toEqual([]);
    expect(r.steps.map((x) => x.destructive)).toEqual([true, false]);
  });
});
