import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { testMe, userFixture } from "../test/me";
import { ExplorationCacheCard } from "./ExplorationCacheCard";

describe("ExplorationCacheCard (V1.1)", () => {
  it("shows the cache's size; an admin clears it after confirming", async () => {
    testMe.current = userFixture({ role: "admin" });
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "DELETE" ? json(200, { deleted: 12 }) : json(200, { entries: 12, hits: 40, lastUsedAt: "2026-09-29T10:00:00.000Z" }),
    );
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<ExplorationCacheCard />);
    expect(await screen.findByText(/12 entries, reused 40 times/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear cache" }));
    await user.click(screen.getByRole("button", { name: "Yes, clear it" }));
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/exploration-cache", expect.objectContaining({ method: "DELETE" }));
    expect(await screen.findByRole("status")).toHaveTextContent("12 entries deleted.");
    expect(screen.getByText(/0 entries, reused 0 times/)).toBeInTheDocument();
  });

  it("offers members no way to clear it", async () => {
    testMe.current = userFixture({ role: "member" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { entries: 3, hits: 1, lastUsedAt: null })),
    );
    render(<ExplorationCacheCard />);
    expect(await screen.findByText(/3 entries, reused once/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear cache" })).not.toBeInTheDocument();
  });
});
