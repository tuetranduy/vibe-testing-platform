import { describe, expect, it } from "vitest";
import { isDestructiveStep } from "./action-policy";

describe("isDestructiveStep", () => {
  it.each([
    [{ description: "Click the Add to cart button", destructive: false }, false],
    [{ description: "Click the Delete account button", destructive: false }, true], // worded as one
    [{ description: "Press the red button", destructive: true }, true], // flagged by the planner
  ])("%j → %s", (step, expected) => {
    expect(isDestructiveStep(step)).toBe(expected);
  });
});
