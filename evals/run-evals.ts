/**
 * `pnpm eval <suite>` — runs an eval suite against the real LLM provider and prints per-case
 * PASS/FAIL plus totals. Always exits 0 once the suite ran: scores are tracked in evals/BASELINE.md,
 * not enforced. Without ANTHROPIC_API_KEY it validates the cases and explains how to run it.
 */
import { AnthropicTransport, LlmClient } from "@platform/llm";
import { loadCases, runRequirementCompilerSuite } from "./requirement-compiler/suite";

const SUITES = ["requirement-compiler"] as const;
const DEFAULT_MODEL = "claude-sonnet-5";

async function main(): Promise<number> {
  const suite = process.argv[2];
  if (!suite || !(SUITES as readonly string[]).includes(suite)) {
    console.error(`Usage: pnpm eval <suite>\nSuites: ${SUITES.join(", ")}`);
    return 1;
  }

  const cases = loadCases();
  console.log(`${suite}: ${cases.length} cases loaded`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      "ANTHROPIC_API_KEY is not set, so the eval was not run.\n" +
        "Set ANTHROPIC_API_KEY (and optionally LLM_MODEL, default claude-sonnet-5) and re-run:\n" +
        "  ANTHROPIC_API_KEY=sk-ant-... pnpm eval requirement-compiler",
    );
    return 0;
  }

  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  const llm = new LlmClient({ transport: new AnthropicTransport({ apiKey }), model });
  console.log(`provider: anthropic, model: ${model}\n`);
  const started = Date.now();
  const results = await runRequirementCompilerSuite(llm, cases);

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
