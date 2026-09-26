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
  it("lists runs with created time, target host, requirement preview, result and duration", async () => {
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
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Created", "Target", "Requirement", "Result", "Duration"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);

    const first = rows[0]!;
    expect(within(first).getByRole("link", { name: "shop1.example.com" })).toHaveAttribute("href", "/runs/run_1");
    expect(within(first).getByText("Requirement number 1")).toBeInTheDocument();
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
    await screen.findByRole("link", { name: "shop2.example.com" });
    await user.click(screen.getByRole("button", { name: /load more/i }));

    expect(await screen.findByRole("link", { name: "shop3.example.com" })).toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "shop1.example.com" })).toBeInTheDocument();

    fail = false;
    await user.click(screen.getByRole("button", { name: /load more/i }));
    expect(await screen.findByRole("link", { name: "shop2.example.com" })).toBeInTheDocument();
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
    expect(await screen.findByRole("link", { name: "shop1.example.com" })).toBeInTheDocument();
  });

  it("shows a loading state first", async () => {
    listFetch({ [FIRST]: () => json(200, { items: [], nextCursor: null }) });
    render(<RunHistory />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
  });
});
