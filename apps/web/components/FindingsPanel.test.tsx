import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { FindingsPanel } from "./FindingsPanel";

const finding = (id: string, extra: Record<string, unknown> = {}) => ({
  id, source: "browser_use", title: `Help link is broken ${id}`,
  observation: "The Help link opened a page that says Not Found.", expected: "The help page opens",
  path: "/help", url: "https://shop.example.com/help", reproduction: ["Click Help"], severity: "medium",
  dismissedAt: null, reproductionRunId: null, createdAt: "2026-11-24T00:00:00.000Z",
  status: "HYPOTHESIS", statusReason: "not_reviewed", ...extra,
});

describe("exploratory findings panel (Phase C)", () => {
  it("shows unverified findings apart from results and starts an independent reproduction", async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith("/findings")
      ? json(200, { findings: [finding("F-1"), finding("F-2", { status: "REPRODUCED", statusReason: "reproduced", reproductionRunId: "run_9" })] })
      : json(202, { finding: finding("F-1", { statusReason: "reproduction_running", reproductionRunId: "run_3" }), run: { runId: "run_3", lifecycle: "QUEUED", eventsUrl: "/e" } }));
    vi.stubGlobal("fetch", fetch);
    const navigate = vi.fn();
    render(<FindingsPanel runId="run_1" navigate={navigate} />);
    expect(await screen.findByRole("heading", { name: "Exploratory findings (unverified)" })).toBeInTheDocument();
    expect(screen.getByText(/do not change this run’s verdict/)).toBeInTheDocument();
    const reproduced = screen.getByRole("listitem", { name: /F-2/ });
    expect(within(reproduced).getByText("Reproduced")).toBeInTheDocument();
    expect(within(reproduced).queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    expect(within(reproduced).getByRole("link", { name: "Open reproduction" })).toHaveAttribute("href", "/runs/run_9");
    await userEvent.click(within(screen.getByRole("listitem", { name: /F-1/ })).getByRole("button", { name: "Reproduce" }));
    expect(fetch).toHaveBeenCalledWith("/api/v1/test-runs/run_1/findings/F-1/reproduce", expect.objectContaining({ method: "POST" }));
    expect(navigate).toHaveBeenCalledWith("/runs/run_3");
  });

  it("dismisses a finding in review", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/findings")
      ? json(200, { findings: [finding("F-1")] })
      : json(200, finding("F-1", { status: "DISMISSED", statusReason: "dismissed_by_reviewer", dismissedAt: "2026-11-24T01:00:00.000Z" }))));
    render(<FindingsPanel runId="run_1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Dismissed in review.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reproduce" })).not.toBeInTheDocument();
  });

  it("renders nothing for a run without findings", async () => {
    const fetch = vi.fn(async () => json(200, { findings: [] }));
    vi.stubGlobal("fetch", fetch);
    const { container } = render(<FindingsPanel runId="run_1" />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
