import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { json, reportFixture, summaryFixture } from "../test/fixtures";
import { PrintableReport } from "./PrintableReport";

describe("PrintableReport (V1.1)", () => {
  it("lays out the whole report and opens the print dialog once", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/report")
          ? json(200, reportFixture())
          : json(200, summaryFixture({ lifecycle: "COMPLETED", verdict: "FAILED", owner: { id: "usr_1", name: "Ann" } })),
      ),
    );
    const print = vi.fn();
    vi.stubGlobal("print", print);
    render(<PrintableReport runId="run_1" />);
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Criteria" })).toBeInTheDocument();
    expect(screen.getByText("Ann")).toBeInTheDocument();
    for (const c of reportFixture().criteria)
      expect(screen.getByRole("heading", { name: new RegExp(`^${c.criterionId} — `) })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Generated Playwright test" })).toBeInTheDocument();
    await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  });

  it("does not print when the report can't be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(409, { code: "REPORT_NOT_READY", message: "The report is available once the run ends" })),
    );
    const print = vi.fn();
    vi.stubGlobal("print", print);
    render(<PrintableReport runId="run_1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The report is available once the run ends");
    expect(print).not.toHaveBeenCalled();
  });
});
