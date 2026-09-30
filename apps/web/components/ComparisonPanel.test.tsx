import type { RunComparison } from "@platform/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json, summaryFixture } from "../test/fixtures";
import { ComparisonPanel } from "./ComparisonPanel";

const comparison = (patch: Partial<RunComparison> = {}): RunComparison => ({
  runId: "run_2",
  baseline: summaryFixture({ runId: "run_1", lifecycle: "COMPLETED", verdict: "PASSED" }),
  chosenBaseline: false,
  verdict: { before: "PASSED", after: "FAILED" },
  criteria: [
    { id: "AC-1", description: "Cart count is 1", critical: true, before: "PASS", after: "PASS", change: "unchanged" },
    { id: "AC-2", description: "Total is shown", critical: true, before: "PASS", after: "FAIL", change: "regressed" },
  ],
  counts: { regressed: 1, fixed: 0, changed: 0, unchanged: 1, added: 0, removed: 0 },
  durationMs: { before: 60_000, after: 65_000 },
  costUsd: { before: 0.01, after: 0.02 },
  history: [
    { runId: "run_1", verdict: "PASSED", createdAt: "2026-09-26T10:00:00.000Z" },
    { runId: "run_0", verdict: "FAILED", createdAt: "2026-09-25T10:00:00.000Z" },
  ],
  ...patch,
});

function api(routes: Record<string, () => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const key = String(input);
    if (!routes[key]) throw new Error(`unexpected ${key}`);
    return routes[key]!();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("ComparisonPanel (V1.2 F2)", () => {
  it("shows the verdict then and now, with regressions first, and compares with a chosen run", async () => {
    const fetch = api({
      "/api/v1/test-runs/run_2/comparison": () => json(200, comparison()),
      "/api/v1/test-runs/run_2/comparison?baseline=run_0": () =>
        json(200, comparison({ chosenBaseline: true, baseline: summaryFixture({ runId: "run_0" }), verdict: { before: "FAILED", after: "FAILED" } })),
    });
    const user = userEvent.setup();
    render(<ComparisonPanel runId="run_2" />);
    expect(await screen.findByRole("heading", { name: "Compared with the previous run" })).toBeInTheDocument();
    expect(screen.getByText(/1 regressed, 0 fixed, 0 changed/)).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Criteria compared" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Regressed");
    expect(rows[0]).toHaveTextContent("Total is shown");
    expect(rows[1]).toHaveTextContent("Unchanged");

    await user.selectOptions(screen.getByLabelText("Compare with"), "run_0");
    expect(await screen.findByRole("heading", { name: "Compared with a chosen run" })).toBeInTheDocument();
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/test-runs/run_2/comparison?baseline=run_0", expect.anything());
  });

  it("says so when every result is the same, and shows nothing for the first run of a test", async () => {
    api({
      "/api/v1/test-runs/run_2/comparison": () =>
        json(200, comparison({ verdict: { before: "PASSED", after: "PASSED" }, criteria: [comparison().criteria[0]!], counts: { regressed: 0, fixed: 0, changed: 0, unchanged: 1, added: 0, removed: 0 } })),
      "/api/v1/test-runs/run_first/comparison": () =>
        json(200, comparison({ runId: "run_first", baseline: null, history: [], verdict: { before: null, after: "PASSED" } })),
    });
    const { unmount } = render(<ComparisonPanel runId="run_2" />);
    expect(await screen.findByText("Every criterion has the same result as before.")).toBeInTheDocument();
    unmount();
    const { container } = render(<ComparisonPanel runId="run_first" />);
    await vi.waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });
});
