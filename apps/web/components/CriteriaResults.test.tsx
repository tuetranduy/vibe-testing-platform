import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactInfo, StepInfo } from "../lib/progress-reducer";
import { json, reportFixture, resultFixture } from "../test/fixtures";
import { CriteriaResults } from "./CriteriaResults";

const artifacts = new Map<string, ArtifactInfo>([
  [
    "art_1",
    {
      artifactId: "art_1",
      type: "SCREENSHOT",
      sensitivity: "STANDARD",
      message: "Screenshot saved at checkpoint after_add",
      timestamp: "2026-09-26T10:01:00.000Z",
    },
  ],
]);
const steps = new Map<string, StepInfo>([
  ["st_1", { stepId: "st_1", index: 0, kind: "navigate", outcome: "SUCCESS", message: "Step 1: navigate succeeded" }],
  ["st_2", { stepId: "st_2", index: 1, kind: "act", outcome: "SUCCESS", message: "Step 2: act succeeded" }],
]);

function renderResults(report = reportFixture()) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(200, { url: "https://s3.test/after_add.png", expiresAt: "2099-01-01T00:00:00.000Z" })),
  );
  return render(
    <CriteriaResults
      runId="run_1"
      criteria={report.criteria}
      requirement={report.requirement}
      diagnostics={report.diagnostics}
      artifacts={artifacts}
      steps={steps}
    />,
  );
}

/** The collapsed row of a criterion: its toggle button's list item. */
const row = (id: string) => screen.getByRole("button", { name: new RegExp(`^${id}\\b`) }).closest("li")!;
const badge = (id: string) => within(row(id)).getByTestId("criterion-status");

describe("CriteriaResults", () => {
  it("renders PASS, FAIL, BLOCKED and INCONCLUSIVE with a distinct label, icon and color", () => {
    renderResults();
    const shown = ["AC-1", "AC-2", "AC-3", "AC-4"].map((id) => {
      const b = badge(id);
      return { label: b.textContent?.trim(), icon: b.querySelector("svg")?.getAttribute("data-icon"), tone: b.className };
    });
    expect(shown.map((s) => s.label)).toEqual(["Pass", "Fail", "Blocked", "Inconclusive"]);
    expect(new Set(shown.map((s) => s.icon)).size).toBe(4);
    expect(new Set(shown.map((s) => s.tone)).size).toBe(4);
    expect(shown.every((s) => s.icon)).toBe(true);
  });

  it("never presents BLOCKED or INCONCLUSIVE as a failure", () => {
    renderResults();
    const fail = badge("AC-2");
    for (const id of ["AC-3", "AC-4", "AC-5"]) {
      const b = badge(id);
      expect(b).not.toHaveTextContent(/fail/i);
      expect(b.className).not.toBe(fail.className);
      expect(b.querySelector("svg")!.getAttribute("data-icon")).not.toBe(fail.querySelector("svg")!.getAttribute("data-icon"));
    }
  });

  it("gives every BLOCKED / INCONCLUSIVE result its reason in plain language", () => {
    renderResults();
    expect(within(row("AC-3")).getByText("A secret this check needs (for example a password) was not provided")).toBeInTheDocument();
    expect(within(row("AC-4")).getByText(/can only be judged by the AI model/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/MISSING_SECRET|AI_JUDGED_ONLY|DISCOVERY_RERUN_DISAGREE/);
  });

  it("shows how a PASS / FAIL was confirmed", () => {
    renderResults();
    expect(within(row("AC-1")).getByText("Confirmed by rerun")).toBeInTheDocument();
    expect(within(row("AC-2")).getByText("Not confirmed by rerun")).toBeInTheDocument();
    expect(within(row("AC-1")).queryByText("Not confirmed by rerun")).not.toBeInTheDocument();
    // Only PASS / FAIL carry a confirmation source.
    expect(within(row("AC-3")).queryByText(/confirmed by rerun/i)).not.toBeInTheDocument();
  });

  it("shows the AI note as a note, separate from the status", () => {
    renderResults();
    const note = within(row("AC-4")).getByRole("note", { name: "AI note" });
    expect(note).toHaveTextContent("The page appeared to respond within about a second.");
    expect(badge("AC-4")).not.toHaveTextContent(/respond within/);
    expect(note.contains(badge("AC-4"))).toBe(false);
    expect(within(row("AC-1")).queryByRole("note", { name: "AI note" })).not.toBeInTheDocument();
  });

  it("explains a discovery / rerun disagreement without showing the provisional status as final", () => {
    renderResults();
    expect(badge("AC-5")).toHaveTextContent("Inconclusive");
    expect(within(row("AC-5")).getByText(/exploration found it passing, but the rerun's assertion failed/i)).toBeInTheDocument();
    expect(within(row("AC-5")).queryByText(/^pass$/i)).not.toBeInTheDocument();
  });

  it("expands a criterion into its details, in order, from a real button", async () => {
    const user = userEvent.setup();
    renderResults();
    const toggle = screen.getByRole("button", { name: /^AC-1\b/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: /AC-1/ })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const detail = screen.getByRole("region", { name: /AC-1/ });
    expect(toggle).toHaveAttribute("aria-controls", detail.id);
    expect(within(detail).getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Requirement",
      "Expected",
      "Actual",
      "Related steps",
      "Evidence",
      "Diagnostics",
    ]);
    expect(within(detail).getByText(/add it to the cart/)).toBeInTheDocument(); // the source text
    expect(within(detail).getByText("Cart items contain “iPhone”")).toBeInTheDocument();
    expect(within(detail).getByText("Cart items: iPhone 15 Pro")).toBeInTheDocument();
    expect(within(detail).getByText("Step 1: navigate succeeded")).toBeInTheDocument();
    expect(within(detail).getByText("Step 2: act succeeded")).toBeInTheDocument();
    expect(await within(detail).findByRole("img", { name: /after_add/ })).toHaveAttribute("src", "https://s3.test/after_add.png");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("is keyboard operable and shows the criterion's diagnostics", async () => {
    const user = userEvent.setup();
    renderResults();
    screen.getByRole("button", { name: /^AC-2\b/ }).focus();
    await user.keyboard("{Enter}");
    const detail = screen.getByRole("region", { name: /AC-2/ });
    expect(within(detail).getByText("The add-to-cart button click did not update the cart badge.")).toBeInTheDocument();
    // Only this criterion's findings (the general one belongs to the report).
    expect(within(detail).queryByText(/loaded slowly/)).not.toBeInTheDocument();
    await user.keyboard(" ");
    expect(screen.queryByRole("region", { name: /AC-2/ })).not.toBeInTheDocument();
  });

  it("says when there is nothing to show in a detail section", async () => {
    const user = userEvent.setup();
    renderResults();
    await user.click(screen.getByRole("button", { name: /^AC-3\b/ }));
    const detail = screen.getByRole("region", { name: /AC-3/ });
    expect(within(detail).getByText(/not observed/i)).toBeInTheDocument(); // actual: null
    expect(within(detail).getByText(/no steps/i)).toBeInTheDocument();
    expect(within(detail).getByText(/no evidence/i)).toBeInTheDocument();
  });

  it("still lists results when the requirement text is not available", () => {
    const report = reportFixture({ requirement: null, criteria: [resultFixture({ criterionId: "AC-9", status: "INCONCLUSIVE", reason: "FACT_NOT_OBSERVED" })] });
    renderResults(report);
    expect(badge("AC-9")).toHaveTextContent("Inconclusive");
  });

  it("says so when there are no results", () => {
    renderResults(reportFixture({ criteria: [] }));
    expect(screen.getByText(/no criterion results/i)).toBeInTheDocument();
  });
});
