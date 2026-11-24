import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { TestReportSchema } from "@platform/contracts";
import { expect, inject, it } from "vitest";
import { api } from "./support/client";

/**
 * Plan §12.3 "selected scenario execution" and "confirmed test rate": Browser Use candidates from an evaluation run,
 * executed UNEDITED as the requirement of an ordinary staging run on their own disposable fixture, through Stagehand
 * and the independent Playwright rerun. Opt-in (E2E_MODE=live with a real provider), with a hard cost cap.
 *
 *   BROWSER_USE_CONFIRM_CANDIDATES=<json [{ fixture, title, requirement, url }]>  BROWSER_USE_CONFIRM_MAX_COST_USD=0.09
 */
const stack = inject("e2e");
const client = api(stack);
const file = process.env.BROWSER_USE_CONFIRM_CANDIDATES;

it.runIf(Boolean(file) && stack.mode === "live")("executes Browser Use candidates unedited and confirms them with Playwright", async () => {
  const cap = Number(process.env.BROWSER_USE_CONFIRM_MAX_COST_USD ?? "0");
  expect(cap, "BROWSER_USE_CONFIRM_MAX_COST_USD").toBeGreaterThan(0);
  const reserve = Number(process.env.BROWSER_USE_CONFIRM_RUN_RESERVE_USD ?? "0.03");
  const candidates = JSON.parse(readFileSync(file!, "utf8")) as { fixture: string; title: string; requirement: string; url: string }[];
  const rows: Record<string, unknown>[] = [];
  let spent = 0;
  for (const candidate of candidates) {
    if (spent + reserve > cap) {
      rows.push({ fixture: candidate.fixture, title: candidate.title, skipped: "cost cap" });
      continue;
    }
    const started = Date.now();
    const runId = await client.create({
      targetUrl: candidate.url, environment: "staging", requirement: candidate.requirement,
      options: { autoConfirmCriteria: true, rerunGeneratedTest: true },
    });
    const run = await client.finished(runId, 900_000);
    const report = TestReportSchema.parse(await client.report(runId));
    spent += report.usage.estimatedCostUsd;
    rows.push({
      fixture: candidate.fixture, title: candidate.title, runId,
      lifecycle: run.lifecycle, verdict: run.verdict,
      criteria: report.criteria.length,
      // Executed: Stagehand reached a verdict on every criterion (no BLOCKED or INCONCLUSIVE).
      executed: report.criteria.length > 0 && report.criteria.every((c) => c.status === "PASS" || c.status === "FAIL"),
      // Confirmed: the generated Playwright test ran independently and decided every criterion.
      confirmed: report.playwright?.status === "PASSED" && report.criteria.every((c) => c.verdictSource === "PLAYWRIGHT_RERUN"),
      playwright: report.playwright?.status ?? null,
      costUsd: report.usage.estimatedCostUsd,
      durationMs: Date.now() - started,
    });
  }
  const executed = rows.filter((row) => row.executed === true).length;
  const confirmed = rows.filter((row) => row.confirmed === true).length;
  const attempted = rows.filter((row) => !row.skipped).length;
  const out = path.resolve(import.meta.dirname, "../../.artifacts/discovery-benchmark/confirmation.hosted.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    kind: "unedited-candidate-confirmation", provider: process.env.LLM_PROVIDER ?? null, model: process.env.LLM_MODEL ?? null,
    attempted, executed, confirmed,
    executionRate: attempted ? executed / attempted : null, confirmationRate: attempted ? confirmed / attempted : null,
    totalCostUsd: spent, costCapUsd: cap, rows,
  }, null, 2) + "\n");
  expect(attempted).toBeGreaterThan(0);
}, 3_600_000);
