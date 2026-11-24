import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { CoveragePanel } from "./CoveragePanel";

describe("coverage across runs (Phase C)", () => {
  it("lists pages Browser Use found that no verified test reached first", async () => {
    const fetch = vi.fn(async () => json(200, {
      origin: "https://shop.example.com", runs: 3,
      pages: [{ path: "/tea", discovered: 2, tested: 1, findings: 0, reproduced: 0 }, { path: "/cart", discovered: 2, tested: 0, findings: 1, reproduced: 1 }],
      edges: [{ from: "/tea", to: "/cart", count: 2 }], gaps: ["/cart"],
    }));
    vi.stubGlobal("fetch", fetch);
    render(<CoveragePanel targetUrl="https://shop.example.com/tea" />);
    expect(await screen.findByText(/Coverage across runs \(2 pages\)/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/v1/discovery/coverage?url=https%3A%2F%2Fshop.example.com%2Ftea", expect.anything());
    await userEvent.click(screen.getByText(/Coverage across runs \(2 pages\)/));
    const rows = within(await screen.findByRole("table")).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("/cartNot tested yet");
    expect(rows[1]).toHaveTextContent("1 (1 reproduced)");
  });
});
