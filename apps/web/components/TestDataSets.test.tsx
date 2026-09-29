import type { TestDataSet } from "@platform/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { TestDataSets } from "./TestDataSets";

const set = (patch: Partial<TestDataSet> = {}): TestDataSet => ({
  id: "tds_1",
  name: "Shopper",
  values: { email: "qa@demo.test", quantity: 2 },
  createdBy: { id: "usr_1", name: "Ann" },
  createdAt: "2026-09-29T10:00:00.000Z",
  updatedAt: "2026-09-29T10:00:00.000Z",
  ...patch,
});

function api(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    if (!routes[key]) throw new Error(`unexpected ${key}`);
    return routes[key]!(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("TestDataSets", () => {
  it("shows an empty state, then creates a set from key/value rows", async () => {
    const fetch = api({
      "GET /api/v1/test-data-sets": () => json(200, { items: [] }),
      "POST /api/v1/test-data-sets": (init) => json(201, set({ ...JSON.parse(String(init!.body)), id: "tds_new", createdBy: null })),
    });
    const user = userEvent.setup();
    render(<TestDataSets />);
    expect(await screen.findByText("No test data sets yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New test data set" }));
    await user.click(screen.getByRole("button", { name: "Save test data set" }));
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Buyer");
    await user.type(screen.getByLabelText("Key 1"), "not a key");
    await user.click(screen.getByRole("button", { name: "Save test data set" }));
    expect(screen.getByText("Use letters, digits and _ (starting with a letter).")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Key 1"));
    await user.type(screen.getByLabelText("Key 1"), "searchTerm");
    await user.type(screen.getByLabelText("Value 1"), "iPhone");
    await user.click(screen.getByRole("button", { name: "Save test data set" }));
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/test-data-sets",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Buyer", values: { searchTerm: "iPhone" } }) }),
    );
    expect(await screen.findByRole("heading", { name: "Buyer" })).toBeInTheDocument();
  });

  it("lists sets with their values, and an edit keeps an untouched number a number", async () => {
    const fetch = api({
      "GET /api/v1/test-data-sets": () => json(200, { items: [set()] }),
      "PUT /api/v1/test-data-sets/tds_1": (init) => json(200, set(JSON.parse(String(init!.body)))),
    });
    const user = userEvent.setup();
    render(<TestDataSets />);
    const card = await screen.findByRole("article", { name: "Shopper" });
    expect(within(card).getByText("qa@demo.test")).toBeInTheDocument();
    expect(within(card).getByText(/2 values · updated .* · added by Ann/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Edit Shopper" }));
    await user.clear(screen.getByLabelText("Value 1"));
    await user.type(screen.getByLabelText("Value 1"), "new@demo.test");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/test-data-sets/tds_1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ name: "Shopper", values: { email: "new@demo.test", quantity: 2 } }),
      }),
    );
  });

  it("asks before deleting, then removes the set", async () => {
    const fetch = api({
      "GET /api/v1/test-data-sets": () => json(200, { items: [set()] }),
      "DELETE /api/v1/test-data-sets/tds_1": () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<TestDataSets />);
    await user.click(await screen.findByRole("button", { name: "Delete Shopper" }));
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/test-data-sets/tds_1", expect.objectContaining({ method: "DELETE" }));
    expect(await screen.findByText("No test data sets yet")).toBeInTheDocument();
  });

  it("puts a duplicate name on the name field", async () => {
    api({
      "GET /api/v1/test-data-sets": () => json(200, { items: [] }),
      "POST /api/v1/test-data-sets": () =>
        json(409, {
          code: "NAME_TAKEN",
          message: "x",
          issues: [{ path: ["name"], message: "A test data set with this name already exists" }],
        }),
    });
    const user = userEvent.setup();
    render(<TestDataSets />);
    await user.click(await screen.findByRole("button", { name: "New test data set" }));
    await user.type(screen.getByLabelText("Name"), "Dup");
    await user.click(screen.getByRole("button", { name: "Save test data set" }));
    expect(await screen.findByText("A test data set with this name already exists")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
  });
});
