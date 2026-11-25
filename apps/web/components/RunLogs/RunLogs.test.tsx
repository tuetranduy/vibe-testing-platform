import type { LlmCallView, RunLogLine } from "@platform/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json, summaryFixture } from "../../test/fixtures";
import { testMe, userFixture } from "../../test/me";
import { RunLogs, RunLogsPage, RunLogsSection } from "./RunLogs";

const admin = userFixture({ role: "admin" });

let seq = 0;
const line = (over: Partial<RunLogLine> = {}): RunLogLine => ({
  id: `log_${Math.random()}`,
  seq: ++seq,
  time: "2026-11-25T10:00:01.000Z",
  source: "worker",
  level: "info",
  stage: "EXPLORING",
  component: "worker",
  message: "step done",
  fields: {},
  ...over,
});

const call = (over: Partial<LlmCallView> = {}): LlmCallView => ({
  id: "llm_1",
  time: "2026-11-25T10:00:02.000Z",
  stage: "EXPLORING",
  purpose: "Observation",
  provider: "anthropic",
  model: "claude-sonnet-5",
  inputTokens: 3100,
  outputTokens: 420,
  estimatedCostUsd: 0.0156,
  latencyMs: 2400,
  status: "SUCCESS",
  exchange: "available",
  ...over,
});

const page = (lines: RunLogLine[], pollSeq: number | null = lines.at(-1)?.seq ?? null) => ({ lines, nextCursor: null, pollSeq });
const calls = (items: LlmCallView[]) => ({
  calls: items,
  totals: {
    calls: items.length,
    inputTokens: items.reduce((n, c) => n + c.inputTokens, 0),
    outputTokens: items.reduce((n, c) => n + c.outputTokens, 0),
    estimatedCostUsd: items.reduce((n, c) => n + c.estimatedCostUsd, 0),
  },
});

function api(handler: (url: string) => Response) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const urls = (fetch: ReturnType<typeof api>) => fetch.mock.calls.map((c) => String(c[0]));

describe("RunLogs", () => {
  it("renders nothing for a member", async () => {
    testMe.current = userFixture({ role: "member" });
    const fetch = api(() => json(200, page([])));
    const { container } = render(<RunLogs runId="run_1" summary={summaryFixture({ lifecycle: "COMPLETED", verdict: "PASSED" })} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the empty state", async () => {
    testMe.current = admin;
    api((url) => (url.includes("/llm-calls") ? json(200, calls([])) : json(200, page([]))));
    render(<RunLogs runId="run_1" summary={summaryFixture({ lifecycle: "COMPLETED", verdict: "PASSED" })} />);
    expect(await screen.findByText("No logs were recorded for this run.")).toBeInTheDocument();
  });

  it("shows every source in one timeline, model calls inline", async () => {
    testMe.current = admin;
    api((url) =>
      url.includes("/llm-calls")
        ? json(200, calls([call()]))
        : json(200, page([line({ message: "sandbox preflight passed", source: "infra", time: "2026-11-25T10:00:00.000Z" }), line({ source: "target_site", level: "error", message: "target site: console" })])),
    );
    render(<RunLogs runId="run_1" summary={summaryFixture({ lifecycle: "COMPLETED", verdict: "PASSED" })} />);
    const timeline = await screen.findByRole("list", { name: "Timeline" });
    const rows = within(timeline).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("sandbox preflight passed"),
      expect.stringContaining("target site: console"),
      expect.stringContaining("Observation · claude-sonnet-5"),
    ]);
  });

  it("shows the failure summary for an errored run from its last errors, not the first page", async () => {
    testMe.current = admin;
    const ended = line({ level: "error", message: "run errored", fields: { err: { message: "No API key for Anthropic" } } });
    api((url) =>
      url.includes("/llm-calls")
        ? json(200, calls([]))
        : url.includes("tail=1") && url.includes("minLevel=error")
          ? json(200, page([ended]))
          : json(200, page([line({ message: "fine" })])),
    );
    render(<RunLogs runId="run_1" summary={summaryFixture({ lifecycle: "ERRORED", errorCategory: "MODEL_PROVIDER" })} />);
    const why = await screen.findByRole("region", { name: "Why it failed" });
    expect(why).toHaveTextContent("Model provider error");
    await waitFor(() => expect(why).toHaveTextContent("run errored"));
    expect(why).toHaveTextContent("No API key for Anthropic");
    expect(within(why).getByRole("button", { name: /Jump to line/ })).toBeInTheDocument();
  });

  it("explains any run that did not pass, and not a passed one", async () => {
    testMe.current = admin;
    api((url) =>
      url.includes("/llm-calls")
        ? json(200, calls([]))
        : url.includes("minLevel=error")
          ? json(200, page([]))
          : url.includes("tail=1") && url.includes("minLevel=warn")
            ? json(200, page([line({ level: "warn", message: "egress blocked" })]))
            : json(200, page([line()])),
    );
    const { unmount } = render(<RunLogs runId="run_1" summary={summaryFixture({ lifecycle: "COMPLETED", verdict: "INCONCLUSIVE" })} />);
    const why = await screen.findByRole("region", { name: "Why it did not pass" });
    expect(why).toHaveTextContent("Inconclusive");
    await waitFor(() => expect(why).toHaveTextContent("egress blocked"));
    unmount();
    render(<RunLogs runId="run_1" summary={summaryFixture({ lifecycle: "COMPLETED", verdict: "PASSED" })} />);
    await screen.findByRole("list", { name: "Timeline" });
    expect(screen.queryByRole("region", { name: /Why it/ })).not.toBeInTheDocument();
  });

  it("filters by source and level", async () => {
    testMe.current = admin;
    const fetch = api((url) => (url.includes("/llm-calls") ? json(200, calls([])) : json(200, page([line()]))));
    render(<RunLogs runId="run_1" summary={summaryFixture({ lifecycle: "COMPLETED", verdict: "PASSED" })} />);
    await screen.findByRole("list", { name: "Timeline" });
    await userEvent.selectOptions(screen.getByLabelText("Minimum level"), "warn");
    await waitFor(() => expect(urls(fetch).some((u) => u.includes("minLevel=warn"))).toBe(true));
    await userEvent.click(screen.getByRole("checkbox", { name: "Infrastructure" }));
    await waitFor(() => expect(urls(fetch).some((u) => u.includes("source=infra") && u.includes("minLevel=warn"))).toBe(true));
  });

  it("polls by sequence while running, keeps going briefly after the end, then stops", async () => {
    testMe.current = admin;
    const first = line({ message: "first" });
    let late: RunLogLine | null = null;
    const fetch = api((url) => {
      if (url.includes("/llm-calls")) return json(200, calls([]));
      if (url.includes(`afterSeq=${first.seq}`) && late) return json(200, page([late]));
      if (url.includes("afterSeq=")) return json(200, page([], first.seq));
      return json(200, page([first]));
    });
    const live = summaryFixture({ lifecycle: "EXPLORING" });
    const { rerender } = render(<RunLogs runId="run_1" summary={live} pollMs={30} />);
    await waitFor(() => expect(urls(fetch).filter((u) => u.includes(`/logs?afterSeq=${first.seq}`)).length).toBeGreaterThanOrEqual(2));
    // The run ends; its last line is stored a moment later, with an earlier time than the newest one shown.
    rerender(<RunLogs runId="run_1" summary={summaryFixture({ lifecycle: "ERRORED", errorCategory: "INTERNAL" })} pollMs={30} />);
    late = line({ level: "error", message: "run errored", time: "2026-11-25T10:00:00.500Z" });
    expect(await within(await screen.findByRole("list", { name: "Timeline" })).findByText("run errored")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 200));
    const before = fetch.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(fetch.mock.calls.length).toBe(before);
  });

  it("opens a prompt", async () => {
    testMe.current = admin;
    api((url) =>
      url.endsWith("/exchange")
        ? json(200, { system: "You test websites.", messages: [{ role: "user", content: "What is on the page?" }], response: '{"ok":true}', error: null, truncated: false })
        : url.includes("/llm-calls")
          ? json(200, calls([call()]))
          : json(200, page([])),
    );
    render(<RunLogs runId="run_1" summary={summaryFixture({ lifecycle: "COMPLETED", verdict: "PASSED" })} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Model calls (1)" }));
    expect(screen.getByRole("table")).toHaveTextContent("3,100");
    await userEvent.click(screen.getByRole("button", { name: "View prompt" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("You test websites.");
    expect(dialog).toHaveTextContent("What is on the page?");
    expect(dialog).toHaveTextContent('{"ok":true}');
  });

  it("shows prompt expired on 410", async () => {
    testMe.current = admin;
    api((url) =>
      url.endsWith("/exchange")
        ? json(410, { code: "EXCHANGE_EXPIRED", message: "Prompts and responses are kept 14 days" })
        : url.includes("/llm-calls")
          ? json(200, calls([call({ exchange: "available" })]))
          : json(200, page([])),
    );
    render(<RunLogs runId="run_1" summary={summaryFixture({ lifecycle: "COMPLETED", verdict: "PASSED" })} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Model calls (1)" }));
    await userEvent.click(screen.getByRole("button", { name: "View prompt" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Prompt expired (kept 14 days)");
  });
});

describe("RunLogsSection and RunLogsPage", () => {
  it("the run page shows a Logs section to administrators only", async () => {
    testMe.current = userFixture({ role: "member" });
    const { container, unmount } = render(<RunLogsSection runId="run_1" summary={summaryFixture({ lifecycle: "COMPLETED", verdict: "PASSED" })} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    testMe.current = admin;
    render(<RunLogsSection runId="run_1" summary={summaryFixture({ lifecycle: "COMPLETED", verdict: "PASSED" })} />);
    expect(await screen.findByRole("button", { name: "Logs" })).toBeInTheDocument();
  });

  it("the logs page is not found for a member and asks nothing", async () => {
    testMe.current = userFixture({ role: "member" });
    const fetch = api(() => json(200, page([])));
    render(<RunLogsPage runId="run_1" />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the logs page shows the view to an administrator", async () => {
    testMe.current = admin;
    api((url) =>
      url.includes("/llm-calls") ? json(200, calls([])) : url.includes("/logs") ? json(200, page([line()])) : json(200, summaryFixture({ lifecycle: "COMPLETED", verdict: "PASSED" })),
    );
    render(<RunLogsPage runId="run_1" />);
    expect(await screen.findByRole("list", { name: "Timeline" })).toHaveTextContent("step done");
  });
});
