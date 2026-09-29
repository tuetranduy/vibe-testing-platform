import type { LlmTransport, LlmTransportRequest, LlmTransportResponse } from "@platform/llm";
import { DIAGNOSTICS_SYSTEM_PROMPT, PLANNER_SYSTEM_PROMPT, REQUIREMENT_SYSTEM_PROMPT, SURVEY_SYSTEM_PROMPT } from "@platform/testing-engine";
import { DEMO_SHOP_SUGGESTIONS, type Scenario } from "./scenarios";

const textOf = (req: LlmTransportRequest) =>
  req.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((p) => (p.type === "text" ? p.text : "")))).join("\n");

/**
 * The scripted model of CI-mode E2E: routes each call by its stage's system prompt and answers
 * from the scenario whose requirement text the prompt contains. Diagnostics add nothing. A call it
 * cannot place fails loudly (the run errors with the provider's category), never silently passes.
 * The survey's call (`test_suggestions`) gets DEMO_SHOP_SUGGESTIONS.
 */
export class ScenarioTransport implements LlmTransport {
  readonly provider = "scripted";

  constructor(private readonly scenarios: Scenario[]) {}

  async complete(req: LlmTransportRequest): Promise<LlmTransportResponse> {
    const prompt = textOf(req);
    let json: unknown;
    if (req.system === DIAGNOSTICS_SYSTEM_PROMPT) {
      json = { findings: [], notes: [] };
    } else if (req.system === SURVEY_SYSTEM_PROMPT) {
      // A blank requirement's survey: the prompt holds page inventories, not a scenario's requirement.
      json = DEMO_SHOP_SUGGESTIONS;
    } else {
      const scenario = this.scenarios.find((s) => prompt.includes(s.requirement));
      if (!scenario) throw new Error(`scripted model: no scenario for this "${req.system.slice(0, 40)}…" prompt`);
      if (req.system === REQUIREMENT_SYSTEM_PROMPT) json = scenario.compiled;
      else if (req.system === PLANNER_SYSTEM_PROMPT) {
        // One-scenario fixtures are written as `{ title, steps }`; the planner's output has `scenarios` (V1.1 F9).
        const plan = scenario.plan;
        json = "scenarios" in plan ? plan : { scenarios: [{ title: plan.title, steps: plan.steps }], stopConditions: plan.stopConditions };
      }
      else throw new Error("scripted model: unknown stage prompt");
    }
    return { text: JSON.stringify(json), model: req.model, usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: 50 } };
  }
}
