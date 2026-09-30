import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, suiteFixture, suiteRunFixture } from "../test/fixtures";
import { AddToSuitePanel } from "./AddToSuitePanel";
import { SuiteDetailView } from "./SuiteDetailView";
import { SuiteRunPage } from "./SuiteRunPage";
import { Suites } from "./Suites";

function api(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    if (!routes[key]) throw new Error(`unexpected ${key}`);
    return routes[key]!(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const view = (patch: Parameters<typeof suiteFixture>[0] = {}) => {
  const { entries: _entries, ...rest } = suiteFixture(patch);
  return rest;
};

afterEach(() => vi.useRealTimers());

describe("Suites", () => {
  it("shows an empty state, then creates a suite and opens it", async () => {
    const fetch = api({
      "GET /api/v1/suites": () => json(200, { items: [] }),
      "POST /api/v1/suites": () => json(201, suiteFixture({ id: "ste_new", name: "Smoke" })),
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<Suites navigate={navigate} />);
    expect(await screen.findByText("No suites yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New suite" }));
    await user.click(screen.getByRole("button", { name: "Create suite" }));
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "Smoke");
    await user.click(screen.getByRole("button", { name: "Create suite" }));
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/suites", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Smoke", description: "" }) }));
    expect(navigate).toHaveBeenCalledWith("/suites/ste_new");
  });

  it("lists each suite with its size and last result", async () => {
    api({
      "GET /api/v1/suites": () =>
        json(200, {
          items: [
            view({ entryCount: 3, lastRun: { id: "srn_1", trigger: "schedule", status: "COMPLETED", verdict: "FAILED", createdAt: "2026-09-30T09:00:00.000Z", finishedAt: "2026-09-30T09:02:00.000Z" } }),
          ],
        }),
    });
    render(<Suites />);
    const card = (await screen.findByRole("link", { name: "Checkout smoke" })).closest("article")!;
    expect(within(card).getByText(/3 tests/)).toBeInTheDocument();
    expect(within(card).getByText("Failed")).toBeInTheDocument();
  });
});

describe("SuiteDetailView", () => {
  const routes = (suite = suiteFixture(), extra: Record<string, (init?: RequestInit) => Response> = {}) => ({
    "GET /api/v1/suites/ste_1": () => json(200, suite),
    "GET /api/v1/suites/ste_1/runs?limit=20": () => json(200, { items: [] }),
    "GET /api/v1/credential-profiles": () => json(200, { items: [] }),
    "GET /api/v1/suites/ste_1/schedules": () => json(200, { items: [] }),
    ...extra,
  });

  it("runs the suite, asking only for the secrets nothing saved provides, and opens the suite run", async () => {
    const fetch = api(
      routes(suiteFixture({ secretNames: ["password", "username"], missingSecretNames: ["password"] }), {
        "POST /api/v1/suites/ste_1/runs": () => json(202, { suiteRunId: "srn_9", runIds: ["run_x"] }),
      }),
    );
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<SuiteDetailView suiteId="ste_1" navigate={navigate} />);
    await user.click(await screen.findByRole("button", { name: "Run suite" }));
    expect(screen.queryByLabelText("username")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run 1 test" }));
    expect(screen.getByText("Enter password, or choose saved credentials that have it.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("password"), "typed-secret");
    await user.click(screen.getByRole("button", { name: "Run 1 test" }));
    const call = fetch.mock.calls.find((c) => String(c[0]) === "/api/v1/suites/ste_1/runs")!;
    expect(call[1]!.body).toBe(JSON.stringify({ secrets: { password: "typed-secret" } }));
    expect((call[1]!.headers as Record<string, string>)["idempotency-key"]).toMatch(/.+/);
    expect(navigate).toHaveBeenCalledWith("/suite-runs/srn_9");
  });

  it("moves and removes tests", async () => {
    const two = suiteFixture({
      entryCount: 2,
      entries: [suiteFixture().entries[0]!, { ...suiteFixture().entries[0]!, sourceRunId: "run_two", title: "Check out", position: 2 }],
    });
    const fetch = api(
      routes(two, {
        "PUT /api/v1/suites/ste_1/entries/order": (init) => {
          const ids = JSON.parse(String(init!.body)).sourceRunIds as string[];
          return json(200, { ...two, entries: ids.map((id) => two.entries.find((e) => e.sourceRunId === id)!) });
        },
        "DELETE /api/v1/suites/ste_1/entries/run_src": () => new Response(null, { status: 204 }),
      }),
    );
    const user = userEvent.setup();
    render(<SuiteDetailView suiteId="ste_1" />);
    await user.click(await screen.findByRole("button", { name: "Move “Check out” up" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/suites/ste_1/entries/order",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ sourceRunIds: ["run_two", "run_src"] }) }),
    );
    await waitFor(() =>
      expect(within(screen.getByRole("list", { name: "Tests in run order" })).getAllByRole("listitem")[0]).toHaveTextContent("Check out"),
    );
    await user.click(screen.getByRole("button", { name: "Remove “Add a product to the cart” from the suite" }));
    expect(fetch).toHaveBeenCalledWith("/api/v1/suites/ste_1/entries/run_src", expect.objectContaining({ method: "DELETE" }));
  });
});

describe("SuiteRunPage", () => {
  it("shows the CI job and the API token that started it", async () => {
    api({
      "GET /api/v1/suite-runs/srn_1": () =>
        json(200, suiteRunFixture({
          trigger: "api",
          startedWithToken: { id: "tok_1", name: "Deploy" },
          ci: { repository: "acme/shop", ref: "refs/heads/main", sha: "abcdef1234", runUrl: "https://github.com/acme/shop/actions/runs/9" },
        })),
    });
    render(<SuiteRunPage suiteRunId="srn_1" pollMs={60_000} />);
    expect(await screen.findByRole("link", { name: /CI job/ })).toHaveAttribute("href", "https://github.com/acme/shop/actions/runs/9");
    expect(screen.getByText(/With the API token “Deploy”/)).toBeInTheDocument();
    expect(screen.getByText(/for acme\/shop · main/)).toBeInTheDocument();
  });

  it("shows each test's result and refreshes until the suite run has settled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    api({
      "GET /api/v1/suite-runs/srn_1": () => {
        calls += 1;
        return json(
          200,
          calls === 1
            ? suiteRunFixture()
            : suiteRunFixture({
                status: "COMPLETED",
                verdict: "FAILED",
                counts: { total: 2, active: 0, passed: 1, failed: 1, blocked: 0, inconclusive: 0, noVerdict: 0 },
                changes: { regressed: 1, fixed: 0 },
                children: suiteRunFixture().children.map((c) =>
                  c.runId === "run_b" ? { ...c, lifecycle: "COMPLETED", verdict: "FAILED", change: "regressed", baselineRunId: "run_prev_b" } : c,
                ),
              }),
        );
      },
    });
    render(<SuiteRunPage suiteRunId="srn_1" pollMs={50} />);
    expect(await screen.findByText("2 tests: 1 passed, 1 still running")).toBeInTheDocument();
    expect(within(screen.getByRole("link", { name: "Add to cart" }).closest("tr")!).getByText("Unchanged")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add to cart" })).toHaveAttribute("href", "/runs/run_a");
    expect(screen.getByRole("button", { name: "Cancel suite run" })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(await screen.findByText("2 tests: 1 passed, 1 failed")).toBeInTheDocument();
    expect(screen.getByText(/1 test regressed/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download JUnit XML/ })).toHaveAttribute("href", "/api/v1/suite-runs/srn_1/junit.xml");
    expect(screen.queryByRole("button", { name: "Cancel suite run" })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(calls).toBe(2);
  });
});

describe("AddToSuitePanel", () => {
  it("adds the run's test to a chosen suite", async () => {
    const fetch = api({
      "GET /api/v1/suites": () => json(200, { items: [view()] }),
      "POST /api/v1/suites/ste_1/entries": () => json(201, suiteFixture()),
    });
    const user = userEvent.setup();
    render(<AddToSuitePanel runId="run_1" />);
    await user.click(screen.getByRole("button", { name: "Add to suite" }));
    await user.click(await screen.findByRole("button", { name: "Add" }));
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/suites/ste_1/entries", expect.objectContaining({ body: JSON.stringify({ sourceRunId: "run_1" }) }));
    expect(await screen.findByRole("link", { name: "Checkout smoke" })).toHaveAttribute("href", "/suites/ste_1");
  });

  it("creates a new suite for it, and a destructive run needs the confirmation", async () => {
    const fetch = api({
      "GET /api/v1/suites": () => json(200, { items: [] }),
      "POST /api/v1/suites": () => json(201, suiteFixture({ id: "ste_2", name: "Payments", entries: [] })),
      "POST /api/v1/suites/ste_2/entries": () => json(201, suiteFixture({ id: "ste_2", name: "Payments" })),
    });
    const user = userEvent.setup();
    render(<AddToSuitePanel runId="run_1" destructive />);
    await user.click(screen.getByRole("button", { name: "Add to suite" }));
    await user.type(await screen.findByLabelText("New suite's name"), "Payments");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Confirm that every run of the suite repeats destructive actions.")).toBeInTheDocument();
    await user.click(screen.getByLabelText(/repeat the destructive actions on every run/));
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/suites/ste_2/entries",
      expect.objectContaining({ body: JSON.stringify({ sourceRunId: "run_1", confirmDestructiveActions: true }) }),
    );
    expect(await screen.findByRole("link", { name: "Payments" })).toBeInTheDocument();
  });
});
