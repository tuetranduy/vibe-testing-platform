import type { TestReport } from "@platform/contracts";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
afterAll(() => store.close());

/** The result of the criterion whose check has this kind (by what it checks, so live mode holds too). */
function resultOf(report: TestReport, kind: string) {
  const criterion = report.requirement!.criteria.find((c) => c.expectedOutcome.kind === kind);
  expect(criterion, `a ${kind} criterion`).toBeDefined();
  return report.criteria.find((r) => r.criterionId === criterion!.id)!;
}

describe("Task 21 step 2 — FAIL", () => {
  it("?bug=empty_cart: the cart count still PASSES, the cart contents FAIL (rerun-confirmed); verdict FAILED; the failure keeps a trace and a screenshot", async () => {
    const runId = await client.create({ targetUrl: `${stack.shopUrl}/?bug=empty_cart`, requirement: REQUIREMENTS.cart, options: { autoConfirmCriteria: true } });

    expect(await client.finished(runId)).toMatchObject({ lifecycle: "COMPLETED", verdict: "FAILED" });
    const report = await client.report(runId);

    expect(resultOf(report, "numeric_compare")).toMatchObject({ status: "PASS", verdictSource: "PLAYWRIGHT_RERUN" });
    const contents = resultOf(report, "collection_contains");
    expect(contents).toMatchObject({ status: "FAIL", verdictSource: "PLAYWRIGHT_RERUN", rerunOutcome: "ASSERTION_FAILED" });

    // Evidence: the failed rerun keeps its trace and screenshot, and the failed criterion points at evidence.
    const artifacts = await store.artifacts(runId);
    const types = new Set(artifacts.map((a) => a.type));
    expect(types).toContain("TRACE");
    expect(types).toContain("SCREENSHOT");
    expect(contents.evidenceArtifactIds.length).toBeGreaterThan(0);
    for (const id of contents.evidenceArtifactIds) expect(artifacts.map((a) => a.id)).toContain(id);

    // The trace is downloadable through the API.
    const trace = artifacts.find((a) => a.type === "TRACE")!;
    const signed = await client.artifactUrl(runId, trace.id, trace.sensitivity === "SECRET_BEARING");
    expect((await fetch(signed.url)).status).toBe(200);
  });
});
