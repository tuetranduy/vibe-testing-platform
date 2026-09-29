import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactInfo } from "../lib/progress-reducer";
import { json, reportFixture, resultFixture } from "../test/fixtures";
import { RunReport } from "./RunReport";

const REPORT = "/api/v1/test-runs/run_1/report";

function reportFetch(handler: () => Response) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === REPORT) return handler();
    if (String(input).includes("/artifacts/")) return json(200, { url: "https://s3.test/x.png", expiresAt: "2099-01-01T00:00:00.000Z" });
    throw new Error(`unexpected request ${String(input)}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const renderReport = (artifacts: ArtifactInfo[] = []) =>
  render(<RunReport runId="run_1" artifacts={artifacts} steps={[]} fallback={<p>Fallback outcome</p>} />);

const card = (name: RegExp) => screen.getByRole("group", { name });

describe("RunReport", () => {
  it("summarizes a completed run: verdict, counts, rerun confirmations, duration and cost", async () => {
    reportFetch(() => json(200, reportFixture()));
    renderReport();
    const verdict = await screen.findByRole("heading", { name: /verdict: failed/i });
    expect(verdict).toBeInTheDocument();
    expect(screen.queryByText(/partial report/i)).not.toBeInTheDocument();

    const counts = card(/criteria/i);
    expect(counts).toHaveTextContent("5");
    expect(within(counts).getByText(/1 passed/i)).toBeInTheDocument();
    expect(within(counts).getByText(/1 failed/i)).toBeInTheDocument();
    expect(within(counts).getByText(/1 blocked/i)).toBeInTheDocument();
    expect(within(counts).getByText(/2 inconclusive/i)).toBeInTheDocument();
    expect(card(/confirmed by rerun/i)).toHaveTextContent(/1 of 2/); // of the PASS / FAIL results
    expect(card(/duration/i)).toHaveTextContent("1m 35s");
    const cost = card(/estimated model cost/i);
    expect(cost).toHaveTextContent("$0.042");
    expect(cost).toHaveTextContent(/12 model calls/);

    expect(screen.getByRole("heading", { name: /^results by criterion$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^AC-1\b/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /generated playwright test/i })).toBeInTheDocument();
    // Report-level diagnostics (not tied to a criterion).
    expect(screen.getByText("The site loaded slowly on the first visit.")).toBeInTheDocument();
  });

  it("tags non-critical results and says the verdict ignores the ones that did not pass (V1.1)", async () => {
    const base = reportFixture();
    const criteria = base.criteria.map((c) => (c.criterionId === "AC-2" ? { ...c, critical: false } : c));
    reportFetch(() => json(200, { ...base, criteria, summary: { ...base.summary, nonCritical: { total: 1, notPassed: 1 } } }));
    renderReport();
    expect(await screen.findByText("1 non-critical criterion did not pass; the verdict ignores it.")).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /^AC-2\b/ }).closest("li")!;
    expect(within(row).getByText("Non-critical")).toBeInTheDocument();
    expect(screen.getAllByText("Non-critical")).toHaveLength(1);
  });

  it("offers a rerun of the saved test only when told the run's secrets and the test checks something (V1.1)", async () => {
    reportFetch(() => json(200, reportFixture()));
    const { unmount } = render(<RunReport runId="run_1" artifacts={[]} steps={[]} secretNames={["password"]} />);
    expect(await screen.findByRole("heading", { name: "Rerun the saved test" })).toBeInTheDocument();
    expect(screen.getByText(/It checks 3 criteria/)).toBeInTheDocument();
    unmount();
    reportFetch(() => json(200, reportFixture()));
    renderReport();
    await screen.findByRole("heading", { name: /verdict/i });
    expect(screen.queryByRole("heading", { name: "Rerun the saved test" })).not.toBeInTheDocument();
  });

  it("shows a partial report for an errored run: lifecycle, error category and message, and what exists", async () => {
    reportFetch(() =>
      json(
        200,
        reportFixture({
          lifecycle: "ERRORED",
          verdict: null,
          partial: true,
          error: { category: "BROWSER_PROVIDER", message: "chromium: No usable sandbox!" },
          summary: { totalCriteria: 1, passed: 0, failed: 0, blocked: 0, inconclusive: 1, confirmedByRerun: 0, nonCritical: { total: 0, notPassed: 0 } },
          criteria: [resultFixture({ criterionId: "AC-1", status: "INCONCLUSIVE", reason: "FACT_NOT_OBSERVED" })],
          generatedTest: null,
          playwright: null,
          diagnostics: [],
          finishedAt: "2026-09-26T10:01:00.000Z",
          durationMs: 30000,
        }),
      ),
    );
    renderReport();
    expect(await screen.findByRole("heading", { name: /run errored/i })).toBeInTheDocument();
    expect(screen.getByText(/partial report/i)).toBeInTheDocument();
    expect(screen.getByText("Browser error")).toBeInTheDocument();
    expect(screen.getByText(/infrastructure errors never count as a failed criterion/i)).toBeInTheDocument();
    // The technical message is available, but secondary: inside a collapsed disclosure.
    const details = screen.getByText(/technical details/i).closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("chromium: No usable sandbox!")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /verdict/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^AC-1\b/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /generated playwright test/i })).not.toBeInTheDocument();
    expect(card(/duration/i)).toHaveTextContent("30s");
  });

  it("shows a partial report for a cancelled run with no results yet", async () => {
    reportFetch(() =>
      json(
        200,
        reportFixture({
          lifecycle: "CANCELLED",
          verdict: null,
          partial: true,
          error: null,
          requirement: null,
          summary: { totalCriteria: 0, passed: 0, failed: 0, blocked: 0, inconclusive: 0, confirmedByRerun: 0, nonCritical: { total: 0, notPassed: 0 } },
          criteria: [],
          generatedTest: null,
          playwright: null,
          diagnostics: [],
          usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          startedAt: null,
          durationMs: null,
        }),
      ),
    );
    renderReport();
    expect(await screen.findByRole("heading", { name: /run cancelled/i })).toBeInTheDocument();
    expect(screen.getByText(/partial report/i)).toBeInTheDocument();
    expect(screen.getByText(/no criterion results/i)).toBeInTheDocument();
    expect(card(/duration/i)).toHaveTextContent("—");
    expect(card(/estimated model cost/i)).toHaveTextContent("$0.00");
  });

  it("lists every artifact of the run on request", async () => {
    const user = userEvent.setup();
    reportFetch(() => json(200, reportFixture()));
    renderReport([
      { artifactId: "art_1", type: "SCREENSHOT", sensitivity: "STANDARD", message: "Screenshot saved at checkpoint after_add", timestamp: "2026-09-26T10:01:00.000Z" },
      { artifactId: "art_9", type: "TRACE", sensitivity: "SECRET_BEARING", message: "Rerun trace stored", timestamp: "2026-09-26T10:01:30.000Z" },
    ]);
    const toggle = await screen.findByRole("button", { name: /all evidence \(2\)/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("img", { name: /after_add/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reveal (may contain entered credentials)" })).toBeInTheDocument();
  });

  it("falls back to the outcome and offers a retry when the report can't be loaded", async () => {
    const user = userEvent.setup();
    let fail = true;
    reportFetch(() => (fail ? json(500, { code: "INTERNAL", message: "Boom" }) : json(200, reportFixture())));
    renderReport();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/report couldn.t be loaded/i);
    expect(screen.getByText("Fallback outcome")).toBeInTheDocument();
    fail = false;
    await user.click(within(alert).getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("heading", { name: /verdict: failed/i })).toBeInTheDocument();
  });
});
