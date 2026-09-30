import { describe, expect, it } from "vitest";
import { buildPlannerPrompt } from "../planner/prompts";
import { buildRequirementPrompt } from "../requirement/prompts";
import { inlineInputsLine } from "./inline-inputs";

const found = [
  { kind: "secret" as const, name: "password" },
  { kind: "testData" as const, name: "email" },
];

describe("credentials taken from the requirement reach the prompts by name (V1.3.1)", () => {
  it("names the test data keys and secrets, never a value", () => {
    expect(inlineInputsLine(found)).toEqual(["Taken from the requirement text (use them; they were provided): test data email; secret password"]);
    expect(inlineInputsLine([])).toEqual([]);
    expect(inlineInputsLine(undefined)).toEqual([]);
  });

  it("the compiler and the planner are told", () => {
    const text = "Log in as admin@shop.test with password [secret: password] and see the dashboard.";
    const compile = buildRequirementPrompt({ originalText: text, testDataKeys: ["email"], secretNames: ["password"], inlineInputs: found });
    expect(compile).toContain("Taken from the requirement text (use them; they were provided): test data email; secret password");
    const plan = buildPlannerPrompt({
      targetUrl: "https://shop.test/",
      requirement: { originalText: text, criteria: [], facts: [] },
      testDataKeys: ["email"],
      secretNames: ["password"],
      inlineInputs: found,
    });
    expect(plan).toContain("secret password");
    expect(buildPlannerPrompt({ targetUrl: "https://shop.test/", requirement: { originalText: text, criteria: [], facts: [] }, testDataKeys: [], secretNames: [] })).not.toContain(
      "Taken from the requirement",
    );
  });
});
