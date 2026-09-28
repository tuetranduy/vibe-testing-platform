import type { TestRunSummary } from "@platform/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json, summaryFixture } from "../test/fixtures";
import { RunHistory } from "./RunHistory";

const run = (n: number, patch: Partial<TestRunSummary> = {}) =>
  summaryFixture({
    runId: `run_${n}`,
    lifecycle: "COMPLETED",
    verdict: "PASSED",
    targetUrl: `https://shop${n}.example.com/path`,
    requirementPreview: `Requirement number ${n}`,
    createdAt: `2026-09-26T10:${String(n).padStart(2, "0")}:00.000Z`,
    startedAt: `2026-09-26T10:${String(n).padStart(2, "0")}:05.000Z`,
    finishedAt: `2026-09-26T10:${String(n + 1).padStart(2, "0")}:40.000Z`,
    ...patch,
  });

function listFetch(pages: Record<string, () => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const handler = pages[String(input)];
    if (!handler) throw new Error(`unexpected request ${String(input)}`);
    return handler();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const FIRST = "/api/v1/test-runs?limit=50";

describe("RunHistory", () => {
  it("lists runs with result, requirement preview, target host, created time and duration", async () => {
    listFetch({
      [FIRST]: () =>
        json(200, {
          items: [
            run(1),
            run(2, { verdict: "FAILED" }),
            run(3, { lifecycle: "ERRORED", verdict: null, errorCategory: "TIMEOUT" }),
            run(4, { lifecycle: "EXPLORING", verdict: null, finishedAt: null }),
          ],
          nextCursor: null,
        }),
    });
    render(<RunHistory />);
    const table = await screen.findByRole("table", { name: /test runs/i });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Result", "Requirement", "Created", "Duration"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);

    const first = rows[0]!;
    expect(within(first).getByRole("link", { name: "Requirement number 1" })).toHaveAttribute("href", "/runs/run_1");
    expect(within(first).getByText("shop1.example.com")).toBeInTheDocument();
    expect(within(first).getByText("Passed")).toBeInTheDocument();
    expect(within(first).getByText("1m 35s")).toBeInTheDocument();
    expect(first.querySelector("time")).toHaveAttribute("dateTime", "2026-09-26T10:01:00.000Z");

    expect(within(rows[1]!).getByText("Failed")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Errored")).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/time limit reached/i)).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Exploring")).toBeInTheDocument();
    expect(within(rows[3]!).getByText(/running/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("loads more runs with the cursor and appends them", async () => {
    const user = userEvent.setup();
    const fetch = listFetch({
      [FIRST]: () => json(200, { items: [run(1), run(2)], nextCursor: "c/2+" }),
      [`${FIRST}&cursor=c%2F2%2B`]: () => json(200, { items: [run(3)], nextCursor: null }),
    });
    render(<RunHistory />);
    await screen.findByRole("link", { name: "Requirement number 2" });
    await user.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByRole("link", { name: "Requirement number 3" })).toBeInTheDocument();
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("keeps the loaded runs and offers a retry when loading more fails", async () => {
    const user = userEvent.setup();
    let fail = true;
    listFetch({
      [FIRST]: () => json(200, { items: [run(1)], nextCursor: "c2" }),
      [`${FIRST}&cursor=c2`]: () => (fail ? json(500, { code: "INTERNAL", message: "Boom" }) : json(200, { items: [run(2)], nextCursor: null })),
    });
    render(<RunHistory />);
    await user.click(await screen.findByRole("button", { name: /load more/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t load more/i);
    expect(screen.getByRole("link", { name: "Requirement number 1" })).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole("button", { name: /load more/i }));
    expect(await screen.findByRole("link", { name: "Requirement number 2" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an empty state with a way to start a test", async () => {
    listFetch({ [FIRST]: () => json(200, { items: [], nextCursor: null }) });
    render(<RunHistory />);
    expect(await screen.findByRole("heading", { name: /no test runs yet/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new test/i })).toHaveAttribute("href", "/runs/new");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows an error state and retries", async () => {
    const user = userEvent.setup();
    let fail = true;
    listFetch({ [FIRST]: () => (fail ? json(502, { code: "API_UNREACHABLE", message: "The API is unreachable" }) : json(200, { items: [run(1)], nextCursor: null })) });
    render(<RunHistory />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn.t load the test runs/i);
    expect(alert).toHaveTextContent("The API is unreachable");
    fail = false;
    await user.click(within(alert).getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("link", { name: "Requirement number 1" })).toBeInTheDocument();
  });

  it("summarizes the results of the loaded runs", async () => {
    listFetch({
      [FIRST]: () =>
        json(200, {
          items: [run(1), run(2), run(3, { verdict: "FAILED" }), run(4, { lifecycle: "CANCELLED", verdict: null, cancelReason: "USER_REQUESTED" })],
          nextCursor: null,
        }),
    });
    render(<RunHistory />);
    const overview = await screen.findByRole("region", { name: /results of the last 4 runs/i });
    expect(overview).toHaveTextContent("2 of 3");
    expect(overview).toHaveTextContent(/finished runs passed/i);
    expect(within(overview).getByText(/2 passed/)).toBeInTheDocument();
    expect(within(overview).getByText(/1 failed/)).toBeInTheDocument();
    expect(within(overview).getByText(/1 running, cancelled or errored/)).toBeInTheDocument();
  });

  it("links to the newest run that is still going", async () => {
    listFetch({
      [FIRST]: () =>
        json(200, {
          items: [
            run(5, { lifecycle: "EXPLORING", verdict: null, finishedAt: null }),
            run(4, { lifecycle: "AWAITING_CONFIRMATION", verdict: null, startedAt: null, finishedAt: null }),
            run(3),
          ],
          nextCursor: null,
        }),
    });
    render(<RunHistory />);
    const running = await screen.findByRole("link", { name: /running now/i });
    expect(running).toHaveAttribute("href", "/runs/run_5");
    expect(running).toHaveTextContent("Requirement number 5");
    expect(running).toHaveTextContent("Exploring website");
    expect(running).toHaveTextContent("Stage 4 of 8");
    expect(running).toHaveTextContent("+1 more in progress");
  });

  it("offers a new test when nothing is running", async () => {
    listFetch({ [FIRST]: () => json(200, { items: [run(1)], nextCursor: null }) });
    render(<RunHistory />);
    const idle = await screen.findByRole("region", { name: /test something new/i });
    expect(within(idle).getByRole("link", { name: /new test/i })).toHaveAttribute("href", "/runs/new");
    expect(screen.queryByRole("link", { name: /running now/i })).not.toBeInTheDocument();
  });

  it("filters the list by result", async () => {
    const user = userEvent.setup();
    listFetch({
      [FIRST]: () =>
        json(200, {
          items: [run(1), run(2, { verdict: "FAILED" }), run(3, { verdict: "BLOCKED" }), run(4, { lifecycle: "EXPLORING", verdict: null, finishedAt: null })],
          nextCursor: null,
        }),
    });
    render(<RunHistory />);
    const filters = await screen.findByRole("group", { name: "Show" });
    expect(within(filters).getByRole("button", { name: /^all 4$/i })).toHaveAttribute("aria-pressed", "true");
    // Only results that occur are offered.
    expect(within(filters).queryByRole("button", { name: /cancelled or errored/i })).not.toBeInTheDocument();

    await user.click(within(filters).getByRole("button", { name: /^failed 1$/i }));
    expect(within(filters).getByRole("button", { name: /^failed 1$/i })).toHaveAttribute("aria-pressed", "true");
    const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByRole("link", { name: "Requirement number 2" })).toBeInTheDocument();
    expect(screen.getByText("1 of 4 runs")).toBeInTheDocument();

    await user.click(within(filters).getByRole("button", { name: /^in progress 1$/i }));
    expect(within(rows()[0]!).getByRole("link", { name: "Requirement number 4" })).toBeInTheDocument();
    await user.click(within(filters).getByRole("button", { name: /^blocked or inconclusive 1$/i }));
    expect(within(rows()[0]!).getByRole("link", { name: "Requirement number 3" })).toBeInTheDocument();
  });

  it("filters the list by website or requirement text, and says when nothing matches", async () => {
    const user = userEvent.setup();
    listFetch({ [FIRST]: () => json(200, { items: [run(1), run(2), run(3, { requirementPreview: "Checkout needs a postcode" })], nextCursor: "c2" }) });
    render(<RunHistory />);
    const search = await screen.findByRole("searchbox", { name: /filter runs/i });

    await user.type(search, "SHOP2.example");
    expect(within(screen.getByRole("table")).getAllByRole("row").slice(1)).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Requirement number 2" })).toBeInTheDocument();
    expect(screen.getByText("1 of 3 runs loaded so far")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "postcode");
    expect(screen.getByRole("link", { name: "Checkout needs a postcode" })).toBeInTheDocument();

    await user.type(search, " and a phone number");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(/no runs match/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /show all runs/i }));
    expect(search).toHaveValue("");
    expect(within(screen.getByRole("table")).getAllByRole("row").slice(1)).toHaveLength(3);
  });

  it("shows a loading state first", async () => {
    listFetch({ [FIRST]: () => json(200, { items: [], nextCursor: null }) });
    render(<RunHistory />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
  });

  it("tags production runs that allow destructive actions", async () => {
    listFetch({
      [FIRST]: () =>
        json(200, {
          items: [
            run(1, { environment: "production", allowDestructiveActions: true }),
            run(2, { environment: "staging", allowDestructiveActions: true }),
            run(3),
            run(4, { environment: "production", allowDestructiveActions: false }),
          ],
          nextCursor: null,
        }),
    });
    render(<RunHistory />);
    const tagged = await screen.findByText("Production · destructive");
    expect(tagged.closest("tr")).toHaveTextContent("Requirement number 1");
    expect(screen.getAllByText("Production · destructive")).toHaveLength(1);
  });
});
