import type { UsageReport } from "@platform/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { testMe, userFixture } from "../test/me";
import { UsageDashboard, formatUsd, niceTicks } from "./UsageDashboard";

const usage = (patch: Partial<UsageReport> = {}): UsageReport => ({
  from: "2026-09-23",
  to: "2026-09-29",
  scope: "all",
  totals: { runs: 3, llmCalls: 42, inputTokens: 120_000, outputTokens: 9_500, estimatedCostUsd: 0.4375 },
  byDay: ["23", "24", "25", "26", "27", "28", "29"].map((d, i) => ({
    day: `2026-09-${d}`,
    llmCalls: i,
    estimatedCostUsd: i === 3 ? 0.3 : i * 0.01,
  })),
  byModel: [
    {
      provider: "anthropic",
      model: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      llmCalls: 42,
      inputTokens: 120_000,
      outputTokens: 9_500,
      estimatedCostUsd: 0.4375,
    },
  ],
  byStage: [{ stage: "EXPLORING", llmCalls: 30, estimatedCostUsd: 0.3 }],
  topRuns: [
    {
      runId: "run_9",
      targetUrl: "https://shop.example.com/",
      requirementPreview: "Search for an iPhone",
      createdAt: "2026-09-26T10:00:00.000Z",
      owner: { id: "usr_1", name: "Ann" },
      llmCalls: 20,
      estimatedCostUsd: 0.3,
    },
  ],
  ...patch,
});

const TODAY = () => new Date("2026-09-29T12:00:00Z");

describe("formatUsd / niceTicks", () => {
  it.each([
    [0, "$0"],
    [0.0042, "$0.0042"],
    [0.029, "$0.029"],
    [0.4375, "$0.44"],
    [12.5, "$12.50"],
    [1234.4, "$1,234"],
  ])("%d → %s", (usd, text) => expect(formatUsd(usd)).toBe(text));

  it("covers the maximum with 1/2/5 steps", () => {
    expect(niceTicks(0.3)).toEqual([0, 0.1, 0.2, 0.3]);
    expect(niceTicks(0.43)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(niceTicks(0)).toEqual([0]);
  });
});

describe("UsageDashboard (V1.1)", () => {
  it("asks for the last 30 days, then shows totals, the daily chart with its table, models, stages and top runs", async () => {
    const fetch = vi.fn(async () => json(200, usage()));
    vi.stubGlobal("fetch", fetch);
    render(<UsageDashboard today={TODAY} />);
    expect(await screen.findByRole("group", { name: "Estimated cost" })).toHaveTextContent("$0.44");
    expect(fetch).toHaveBeenCalledWith("/api/v1/usage?from=2026-08-31&to=2026-09-29", expect.anything());
    expect(screen.getByRole("group", { name: "Model calls" })).toHaveTextContent("42in 3 runs");
    expect(screen.getByRole("group", { name: "Tokens" })).toHaveTextContent("130K");
    expect(screen.getByRole("img")).toHaveAccessibleName(/7 days, \$0\.48 in total; highest on Sep 26 \(\$0\.30\)/);
    await userEvent.click(screen.getByText("Show as a table"));
    const table = screen.getByRole("table", { name: "Estimated cost per day" });
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    expect(screen.getByRole("cell", { name: "Claude Sonnet 5" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Exploring" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search for an iPhone" })).toHaveAttribute("href", "/runs/run_9");
  });

  it("changes the period, and lets an admin see only their own runs", async () => {
    testMe.current = userFixture({ role: "admin" });
    const fetch = vi.fn(async () => json(200, usage()));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<UsageDashboard today={TODAY} />);
    await screen.findByRole("group", { name: "Estimated cost" });
    await user.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/usage?from=2026-09-23&to=2026-09-29", expect.anything());
    await user.click(screen.getByRole("button", { name: "My runs" }));
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/usage?from=2026-09-23&to=2026-09-29&owner=me", expect.anything());
  });

  it("says so when there were no model calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          200,
          usage({
            totals: { runs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
            byModel: [],
            byStage: [],
            topRuns: [],
          }),
        ),
      ),
    );
    render(<UsageDashboard today={TODAY} />);
    expect(await screen.findByText("No model calls in this period.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Average per run" })).getByText("—")).toBeInTheDocument();
  });
});
