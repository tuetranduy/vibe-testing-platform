/**
 * `pnpm eval <suite>` — runs an eval suite against the real LLM provider and prints per-case
 * PASS/FAIL plus totals. Always exits 0 once the suite ran: scores are tracked in evals/BASELINE.md,
 * not enforced. Without ANTHROPIC_API_KEY it validates the cases and explains how to run it.
 */
import { AnthropicTransport, LlmClient } from "@platform/llm";
import { loadPlannerCases, runPlannerSuite } from "./planner/suite";
import { loadCases, runRequirementCompilerSuite } from "./requirement-compiler/suite";
import type { CaseResult } from "./usage";

interface LoadedSuite {
  count: number;
  run(llm: LlmClient): Promise<CaseResult[]>;
}

/** `load` validates the cases (throws on an invalid case file) before any model call. */
const suite =
  <C>(load: () => C[], run: (llm: LlmClient, cases: C[]) => Promise<CaseResult[]>) =>
  (): LoadedSuite => {
    const cases = load();
    return { count: cases.length, run: (llm) => run(llm, cases) };
  };

const SUITES: Record<string, () => LoadedSuite> = {
  "requirement-compiler": suite(loadCases, runRequirementCompilerSuite),
  planner: suite(loadPlannerCases, runPlannerSuite),
};

const DEFAULT_MODEL = "claude-sonnet-5";

async function main(): Promise<number> {
  const name = process.argv[2];
  const load = name && Object.hasOwn(SUITES, name) ? SUITES[name] : undefined;
  if (!name || !load) {
    console.error(`Usage: pnpm eval <suite>\nSuites: ${Object.keys(SUITES).join(", ")}`);
    return 1;
  }

  const loaded = load();
  console.log(`${name}: ${loaded.count} cases loaded`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      "ANTHROPIC_API_KEY is not set, so the eval was not run.\n" +
        "Set ANTHROPIC_API_KEY (and optionally LLM_MODEL, default claude-sonnet-5) and re-run:\n" +
        `  ANTHROPIC_API_KEY=sk-ant-... pnpm eval ${name}`,
    );
    return 0;
  }

  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  const llm = new LlmClient({ transport: new AnthropicTransport({ apiKey }), model });
  console.log(`provider: anthropic, model: ${model}\n`);
  const started = Date.now();
  const results = await loaded.run(llm);

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
