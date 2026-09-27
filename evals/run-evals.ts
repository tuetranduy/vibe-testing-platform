/**
 * `pnpm eval <suite>` — runs an eval suite against the real LLM provider (LLM_PROVIDER=gemini, or
 * anthropic when unset or fake; LLM_MODEL and GEMINI_THINKING_LEVEL as for the worker) and prints
 * per-case PASS/FAIL plus totals. Always exits 0 once the suite ran: scores are tracked in
 * evals/BASELINE.md, not enforced. Without the provider's API key it validates the cases and explains
 * how to run it; invalid LLM settings exit 1.
 */
import { EnvValidationError, defaultLlmModel, loadLiveLlmEnv } from "@platform/config";
import { LlmClient, createTransport } from "@platform/llm";
import { loadPlannerCases, runPlannerSuite } from "./planner/suite";
import { loadCases, runRequirementCompilerSuite } from "./requirement-compiler/suite";
import { createUsageMeter, type CaseResult, type UsageMeter } from "./usage";

interface LoadedSuite {
  count: number;
  run(llm: LlmClient, meter: UsageMeter): Promise<CaseResult[]>;
}

/** `load` validates the cases (throws on an invalid case file) before any model call. */
const suite =
  <C>(load: () => C[], run: (llm: LlmClient, cases: C[], meter: UsageMeter) => Promise<CaseResult[]>) =>
  (): LoadedSuite => {
    const cases = load();
    return { count: cases.length, run: (llm, meter) => run(llm, cases, meter) };
  };

const SUITES: Record<string, () => LoadedSuite> = {
  "requirement-compiler": suite(loadCases, runRequirementCompilerSuite),
  planner: suite(loadPlannerCases, runPlannerSuite),
};

async function main(): Promise<number> {
  const name = process.argv[2];
  const load = name && Object.hasOwn(SUITES, name) ? SUITES[name] : undefined;
  if (!name || !load) {
    console.error(`Usage: pnpm eval <suite>\nSuites: ${Object.keys(SUITES).join(", ")}`);
    return 1;
  }

  const loaded = load();
  console.log(`${name}: ${loaded.count} cases loaded`);

  let env: ReturnType<typeof loadLiveLlmEnv>;
  try {
    env = loadLiveLlmEnv();
  } catch (err) {
    if (!(err instanceof EnvValidationError)) throw err;
    console.error(err.message);
    return 1;
  }
  if ("missingKey" in env) {
    console.log(
      `${env.missingKey} is not set, so the eval was not run. Set the provider's API key and re-run, e.g.:\n` +
        `  ANTHROPIC_API_KEY=sk-ant-... pnpm eval ${name}\n` +
        `  LLM_PROVIDER=gemini GEMINI_API_KEY=... pnpm eval ${name}\n` +
        `LLM_MODEL overrides the provider's default model (anthropic: ${defaultLlmModel("anthropic")}, gemini: ${defaultLlmModel("gemini")}).`,
    );
    return 0;
  }

  // Usage is counted per provider request (failed attempts included) through the call-record sink.
  const meter = createUsageMeter();
  const transport = createTransport({
    provider: env.LLM_PROVIDER,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiThinkingLevel: env.GEMINI_THINKING_LEVEL,
  });
  const llm = new LlmClient({ transport, model: env.LLM_MODEL, recordCall: meter.sink });
  const thinking = env.LLM_PROVIDER === "gemini" ? `, thinking: ${env.GEMINI_THINKING_LEVEL ?? "model default"}` : "";
  console.log(`provider: ${env.LLM_PROVIDER}, model: ${env.LLM_MODEL}${thinking}\n`);
  const started = Date.now();
  const results = await loaded.run(llm, meter);

  const passed = results.filter((r) => r.passed).length;
  const sum = (k: "inputTokens" | "outputTokens" | "costUsd") => results.reduce((a, r) => a + r[k], 0);
  console.log(
    `\nTotal: ${passed}/${results.length} passed (${((100 * passed) / results.length).toFixed(1)}%)` +
      ` · tokens in ${sum("inputTokens")} / out ${sum("outputTokens")}` +
      ` · est. cost $${sum("costUsd").toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
