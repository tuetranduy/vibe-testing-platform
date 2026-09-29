import type { LlmChoice } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { addKeyHint, checkModel, offeredModels, resolveRunLlm, type LlmAvailability } from "./llm-choice";

const ALL_KEYS: LlmAvailability = { keys: { anthropic: true, gemini: true }, fakeAllowed: true };
const ANTHROPIC_ONLY: LlmAvailability = { keys: { anthropic: true, gemini: false }, fakeAllowed: true };
const NO_KEYS: LlmAvailability = { keys: { anthropic: false, gemini: false }, fakeAllowed: true };
const ENV: LlmChoice = { provider: "anthropic", model: "claude-sonnet-5", reasoning: "default" };
const resolve = (input: Partial<Parameters<typeof resolveRunLlm>[0]>) =>
  resolveRunLlm({ override: undefined, saved: null, env: ENV, availability: ANTHROPIC_ONLY, ...input });

describe("offeredModels / addKeyHint", () => {
  it("offers the fake engine only outside production", () => {
    expect(offeredModels(ALL_KEYS).map((m) => m.id)).toContain("fake");
    expect(offeredModels({ ...ALL_KEYS, fakeAllowed: false }).map((m) => m.id)).not.toContain("fake");
  });

  it("names the fix", () => {
    expect(addKeyHint("anthropic")).toBe("Add an Anthropic API key in Settings");
    expect(addKeyHint("gemini")).toBe("Add a Google Gemini API key in Settings");
  });
});

describe("checkModel (Settings defaults)", () => {
  const at = { model: ["defaults", "model"], reasoning: ["defaults", "reasoning"] };

  it("accepts an offered model whose provider has a key, at one of its levels", () => {
    expect(checkModel("gemini-3.5-flash", "minimal", ALL_KEYS, at)).toEqual({ ok: true, choice: { provider: "gemini", model: "gemini-3.5-flash", reasoning: "minimal" } });
  });

  it.each([
    ["an unknown model", "gpt-x", "default", ALL_KEYS, ["defaults", "model"], /not a model offered here/],
    ["a provider without a key", "gemini-3.8-flash", "default", ANTHROPIC_ONLY, ["defaults", "model"], /^Add a Google Gemini API key in Settings$/],
    ["a level the model does not take", "claude-haiku-4-5", "high", ALL_KEYS, ["defaults", "reasoning"], /Claude Haiku 4.5 takes the reasoning levels default, not high/],
    ["minimal on Claude", "claude-sonnet-5", "minimal", ALL_KEYS, ["defaults", "reasoning"], /not minimal/],
    ["the fake engine in production", "fake", "default", { ...ALL_KEYS, fakeAllowed: false }, ["defaults", "model"], /not a model offered here/],
  ] as const)("refuses %s", (_what, model, level, availability, path, message) => {
    const r = checkModel(model, level, availability, at);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issue.path).toEqual(path);
    expect(r.issue.message).toMatch(message);
  });
});

describe("resolveRunLlm: request → Settings → environment", () => {
  const saved = { model: "claude-opus-5-5", reasoning: "medium" as const };

  it("the request's model wins, with its level or default", () => {
    expect(resolve({ override: { model: "claude-fable-5-1", reasoning: "low" }, saved })).toEqual({
      ok: true,
      choice: { provider: "anthropic", model: "claude-fable-5-1", reasoning: "low" },
    });
    expect(resolve({ override: { model: "claude-fable-5-1" }, saved })).toMatchObject({ choice: { reasoning: "default" } });
  });

  it("the request's model is checked: offered, with a key, at one of its levels", () => {
    expect(resolve({ override: { model: "gemini-3.8-flash" } })).toEqual({
      ok: false,
      issue: { path: ["llm", "model"], message: "Add a Google Gemini API key in Settings" },
    });
    expect(resolve({ override: { model: "claude-sonnet-4-6" } })).toMatchObject({ ok: false, issue: { path: ["llm", "model"] } });
    expect(resolve({ override: { model: "claude-haiku-4-5", reasoning: "low" } })).toMatchObject({ ok: false, issue: { path: ["llm", "reasoning"] } });
  });

  it("no model in the request: the saved defaults, with the request's level when their model takes it", () => {
    expect(resolve({ saved })).toEqual({ ok: true, choice: { provider: "anthropic", model: "claude-opus-5-5", reasoning: "medium" } });
    expect(resolve({ saved, override: { reasoning: "high" } })).toMatchObject({ choice: { model: "claude-opus-5-5", reasoning: "high" } });
    expect(resolve({ saved: { model: "claude-haiku-4-5", reasoning: "default" }, override: { reasoning: "high" } })).toMatchObject({
      ok: false,
      issue: { path: ["llm", "reasoning"] },
    });
  });

  it("saved defaults whose provider lost its key: refused at the defaults, naming the fix", () => {
    expect(resolve({ saved: { model: "gemini-3.8-flash", reasoning: "low" } })).toEqual({
      ok: false,
      issue: { path: ["llm"], message: "Add a Google Gemini API key in Settings: the default model (Gemini 3.8 Flash) needs it" },
    });
  });

  it("nothing saved: the environment's choice, even a model outside the catalog (as the operator configured it)", () => {
    expect(resolve({})).toEqual({ ok: true, choice: ENV });
    const custom: LlmChoice = { provider: "anthropic", model: "claude-opus-5", reasoning: "default" };
    expect(resolve({ env: custom })).toEqual({ ok: true, choice: custom });
    expect(resolve({ env: custom, override: { reasoning: "default" } })).toEqual({ ok: true, choice: custom });
    expect(resolve({ env: custom, override: { reasoning: "high" } })).toMatchObject({ ok: false, issue: { path: ["llm", "reasoning"] } });
    expect(resolve({ env: { provider: "gemini", model: "gemini-3.8-flash", reasoning: "low" }, availability: ALL_KEYS })).toMatchObject({
      choice: { provider: "gemini", reasoning: "low" },
    });
  });

  it("the environment's provider without a key: refused at the defaults", () => {
    expect(resolve({ availability: NO_KEYS })).toEqual({
      ok: false,
      issue: { path: ["llm"], message: "Add an Anthropic API key in Settings: the default model (Claude Sonnet 5) needs it" },
    });
  });

  it("the fake engine needs no key, and is refused in production", () => {
    const fake: LlmChoice = { provider: "fake", model: "fake", reasoning: "default" };
    expect(resolve({ env: fake, availability: NO_KEYS })).toEqual({ ok: true, choice: fake });
    expect(resolve({ override: { model: "fake" }, availability: NO_KEYS })).toEqual({ ok: true, choice: fake });
    expect(resolve({ override: { model: "fake" }, availability: { ...NO_KEYS, fakeAllowed: false } })).toMatchObject({ ok: false, issue: { path: ["llm", "model"] } });
  });
});
