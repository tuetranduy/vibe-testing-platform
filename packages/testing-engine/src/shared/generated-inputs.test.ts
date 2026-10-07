import type { ExplorationStep } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { generatedInputs, generatedTestData } from "./generated-inputs";

const fill = (id: string, index: number, inputRef: ExplorationStep["inputRef"], generatedValue?: string | null): ExplorationStep => ({
  id,
  runId: "run_1",
  index,
  plannedStepId: `PS-${index + 1}`,
  kind: "fill",
  instruction: "Fill the field",
  element: null,
  inputRef,
  onGoldenPath: true,
  urlBefore: "https://shop.test/",
  urlAfter: "https://shop.test/",
  outcome: "SUCCESS",
  blockReason: null,
  error: null,
  startedAt: "2026-10-07T10:00:00.000Z",
  durationMs: 1,
  artifactIds: [],
  llm: null,
  ...(generatedValue !== undefined ? { generatedValue } : {}),
});

describe("generated inputs", () => {
  const steps = [
    fill("st_3", 2, { source: "secret", key: "password" }, "Gen-Pass-1!aB"),
    fill("st_1", 0, { source: "testData", key: "email" }, "ana.tester@example.com"),
    fill("st_2", 1, { source: "testData", key: "city" }), // provided by the user: no generatedValue
    fill("st_4", 3, { source: "testData", key: "email" }, "ana.tester@example.com"), // reused in a later scenario
    fill("st_5", 4, { source: "literal", key: "iPhone" }, null),
  ];

  it("lists each generated source:key once, from its first step in step order", () => {
    expect(generatedInputs(steps)).toEqual([
      { source: "testData", key: "email", value: "ana.tester@example.com", stepId: "st_1" },
      { source: "secret", key: "password", value: "Gen-Pass-1!aB", stepId: "st_3" },
    ]);
  });

  it("gives the generated test data as a key → value map (secrets left out)", () => {
    expect(generatedTestData(steps)).toEqual({ email: "ana.tester@example.com" });
    expect(generatedTestData([])).toEqual({});
  });
});
