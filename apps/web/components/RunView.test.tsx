import type { TestEvent, TestRunSummary } from "@platform/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ev } from "../test/events";
import { json, reportFixture, requirementFixture, suggestionsFixture, summaryFixture } from "../test/fixtures";
import type { RunEventsOptions } from "../lib/run-events";
import { RunView } from "./RunView";

// The criteria review can navigate (start over), so it needs the App Router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

/** Fake event stream: the test pushes events into whatever RunView subscribed with. */
const streams: { opts: RunEventsOptions; closed: boolean }[] = [];
vi.mock("../lib/run-events", () => ({
  connectRunEvents: (opts: RunEventsOptions) => {
    const s = { opts, closed: false };
    streams.push(s);
    return { close: () => void (s.closed = true), latestSequence: 0, done: new Promise(() => {}) };
  },
}));

/** The stream is opened by a passive effect, which can run just after the awaited UI appears. */
const subscribed = () => waitFor(() => expect(streams.length).toBeGreaterThan(0));

const emit = async (...events: TestEvent[]) => {
  await subscribed();
  await act(() => {
    for (const e of events) streams.at(-1)!.opts.onEvent(e);
  });
};

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;
function routeFetch(routes: Record<string, Handler>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const RUN = "/api/v1/test-runs/run_1";
const summaries = (...list: TestRunSummary[]) => () => json(200, list.length > 1 ? list.shift()! : list[0]!);

beforeEach(() => void (streams.length = 0));

const partialReport = (lifecycle: "ERRORED" | "CANCELLED") =>
  reportFixture({
    lifecycle,
    verdict: null,
    partial: true,
    error: null,
    summary: { totalCriteria: 0, passed: 0, failed: 0, blocked: 0, inconclusive: 0, confirmedByRerun: 0 },
    criteria: [],
    generatedTest: null,
    playwright: null,
    diagnostics: [],
  });

const toExploring = [
  ev(1, "run.created", { targetHost: "shop.example.com" }, { stage: "QUEUED", message: "Test run created for shop.example.com" }),
  ev(2, "stage.started", { stage: "ANALYZING_REQUIREMENT" }, { message: "Analyzing requirement started" }),
  ev(3, "stage.completed", { stage: "ANALYZING_REQUIREMENT" }, { message: "Analyzing requirement completed" }),
  ev(4, "criteria.confirmed", { revision: 1 }, { stage: "AWAITING_CONFIRMATION", message: "Criteria revision 1 confirmed" }),
  ev(5, "stage.started", { stage: "PLANNING" }, { message: "Planning test started" }),
  ev(6, "stage.completed", { stage: "PLANNING" }, { message: "Planning test completed" }),
  ev(7, "stage.started", { stage: "EXPLORING" }, { message: "Exploring website started" }),
];

describe("RunView", () => {
  const surveyRun = (lifecycle: "QUEUED" | "SURVEYING" | "AWAITING_SELECTION" = "SURVEYING") => summaryFixture({ lifecycle, requirementPreview: "" });

  it("a blank-requirement run exploring the website: its title, the survey stage first, pages in the timeline, the screenshot live", async () => {
    routeFetch({
      [`GET ${RUN}`]: summaries(surveyRun()),
      [`GET ${RUN}/artifacts/art_s1/url`]: () => json(200, { url: "https://s3.test/home.png", expiresAt: "2026-09-28T10:05:00.000Z" }),
    });
    render(<RunView runId="run_1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Exploring shop.example.com for test ideas" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /exploring the website for test ideas/i })).toBeInTheDocument();
    await emit(
      ev(1, "run.created", { targetHost: "shop.example.com" }, { stage: "QUEUED", message: "Test run created for shop.example.com" }),
      ev(2, "stage.started", { stage: "SURVEYING" }, { message: "Exploring for test ideas started" }),
      ev(3, "artifact.created", { artifactId: "art_s1", type: "SCREENSHOT", sensitivity: "STANDARD" }, { stage: "SURVEYING", message: "Screenshot saved for /" }),
      ev(4, "page.surveyed", { path: "/", title: "Home · Demo Shop", status: "READ" }, { stage: "SURVEYING", message: "Loaded / — Home · Demo Shop" }),
      ev(5, "page.surveyed", { path: "/account", title: "", status: "SKIPPED" }, { stage: "SURVEYING", message: "Skipped /account — blocked by policy" }),
    );

    const stages = within(screen.getByRole("list", { name: /stages/i })).getAllByRole("listitem");
    expect(stages[0]).toHaveTextContent(/exploring for test ideas/i);
    expect(stages[0]).toHaveTextContent(/in progress/i);
    const timeline = screen.getByRole("list", { name: /timeline/i });
    expect(within(timeline).getByText("Loaded / — Home · Demo Shop")).toBeInTheDocument();
    expect(within(timeline).getByText("Skipped /account — blocked by policy")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /screenshot saved for \//i })).toHaveAttribute("src", "https://s3.test/home.png");
  });

  it("moves from exploring to 'Choose what to test' only once the run awaits a choice — never asking for suggestions before", async () => {
    const fetch = routeFetch({
      [`GET ${RUN}`]: summaries(surveyRun(), surveyRun(), surveyRun("AWAITING_SELECTION")),
      [`GET ${RUN}/suggestions`]: () => json(200, suggestionsFixture()),
    });
    render(<RunView runId="run_1" />);
    await screen.findByRole("heading", { name: /exploring the website for test ideas/i });
    await emit(
      ev(1, "stage.started", { stage: "SURVEYING" }),
      ev(2, "suggestions.proposed", { count: 4, suggestions: [{ id: "S-1", title: "Add a product to the cart" }] }, { stage: "SURVEYING" }),
      ev(3, "stage.completed", { stage: "SURVEYING" }),
    );
    expect(await screen.findByRole("heading", { name: "Choose what to test" }, { timeout: 5_000 })).toBeInTheDocument();
    const urls = fetch.mock.calls.map(([u]) => String(u));
    const firstSuggestions = urls.indexOf(`${RUN}/suggestions`);
    // Loaded, then polled while still SURVEYING, then AWAITING_SELECTION — and only then the suggestions.
    expect(urls.slice(0, firstSuggestions).filter((u) => u === RUN)).toHaveLength(3);
    expect(screen.getAllByRole("article")).toHaveLength(4);
  });

  it("choosing a test moves the page on to analysing it", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${RUN}`]: summaries(surveyRun("AWAITING_SELECTION")),
      [`GET ${RUN}/suggestions`]: () => json(200, suggestionsFixture()),
      [`POST ${RUN}/suggestions/select`]: () =>
        json(202, summaryFixture({ lifecycle: "ANALYZING_REQUIREMENT", requirementPreview: suggestionsFixture().suggestions[0]!.requirement })),
    });
    render(<RunView runId="run_1" />);
    const card = await screen.findByRole("article", { name: "Add a product to the cart" });
    await user.click(within(card).getByRole("button", { name: /test this/i }));
    await user.click(within(card).getByRole("button", { name: /continue with this test/i }));
    expect(await screen.findByRole("heading", { name: /analyzing your requirement/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(suggestionsFixture().suggestions[0]!.requirement);
  });

  it("'None of these — cancel run' uses the run's cancel confirmation", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({
      [`GET ${RUN}`]: summaries(surveyRun("AWAITING_SELECTION")),
      [`GET ${RUN}/suggestions`]: () => json(200, suggestionsFixture()),
      [`POST ${RUN}/cancel`]: () => json(202, summaryFixture({ lifecycle: "CANCELLED", cancelReason: "USER_REQUESTED", requirementPreview: "" })),
      [`GET ${RUN}/report`]: () => json(200, partialReport("CANCELLED")),
    });
    render(<RunView runId="run_1" />);
    await user.click(await screen.findByRole("button", { name: "None of these — cancel run" }));
    const dialog = screen.getByRole("group", { name: /cancel this run/i });
    await user.click(within(dialog).getByRole("button", { name: /yes, cancel/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${RUN}/cancel`, expect.objectContaining({ method: "POST" })));
    expect(await screen.findByRole("heading", { name: /run cancelled/i })).toBeInTheDocument();
  });

  it("a QUEUED blank-requirement run already lists the survey stage", async () => {
    routeFetch({ [`GET ${RUN}`]: summaries(surveyRun("QUEUED")) });
    render(<RunView runId="run_1" />);
    const stages = await screen.findByRole("list", { name: /stages/i });
    expect(within(stages).getAllByRole("listitem")[0]).toHaveTextContent(/exploring for test ideas/i);
    expect(screen.queryByRole("heading", { name: /analyzing your requirement/i })).not.toBeInTheDocument();
  });

  it("a run created with a requirement shows no survey stage", async () => {
    routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "PLANNING" })) });
    render(<RunView runId="run_1" />);
    const stages = await screen.findByRole("list", { name: /stages/i });
    expect(within(stages).queryByText(/exploring for test ideas/i)).not.toBeInTheDocument();
  });

  it("shows a run cancelled because no suggested test was chosen in time", async () => {
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "CANCELLED", cancelReason: "SELECTION_EXPIRED", requirementPreview: "" })),
      [`GET ${RUN}/report`]: () => json(200, partialReport("CANCELLED")),
    });
    render(<RunView runId="run_1" />);
    expect(await screen.findByRole("heading", { name: /run cancelled/i })).toBeInTheDocument();
    expect(screen.getByText(/no suggested test was chosen in time/i)).toBeInTheDocument();
  });

  it("shows the analyzing state while the requirement is analyzed", async () => {
    routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "ANALYZING_REQUIREMENT" })) });
    render(<RunView runId="run_1" />);
    expect(await screen.findByRole("heading", { name: /analyzing your requirement/i })).toBeInTheDocument();
    await subscribed();
    expect(streams).toHaveLength(1);
    expect(streams[0]!.opts.runId).toBe("run_1");
  });

  it("moves from analyzing to criteria review once the run awaits confirmation", async () => {
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "ANALYZING_REQUIREMENT" }), summaryFixture({ lifecycle: "AWAITING_CONFIRMATION" })),
      [`GET ${RUN}/criteria`]: () => json(200, requirementFixture()),
    });
    render(<RunView runId="run_1" />);
    await screen.findByRole("heading", { name: /analyzing your requirement/i });
    await emit(ev(1, "stage.completed", { stage: "ANALYZING_REQUIREMENT" }));
    expect(await screen.findByRole("heading", { name: /review the acceptance criteria/i })).toBeInTheDocument();
    expect(await screen.findAllByRole("article")).toHaveLength(3);
  });

  it("after confirming, shows the server warnings and switches to the progress view", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "AWAITING_CONFIRMATION" })),
      [`GET ${RUN}/criteria`]: () => json(200, requirementFixture()),
      [`POST ${RUN}/criteria/confirm`]: () =>
        json(202, { revision: 1, warnings: ["Criterion AC-2 will be reported as Inconclusive", "Criterion AC-3 will be reported as Inconclusive"] }),
    });
    render(<RunView runId="run_1" />);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: /confirm and start/i }));

    const notice = await screen.findByRole("status", { name: /criteria confirmed/i });
    expect(within(notice).getByText("Criterion AC-2 will be reported as Inconclusive")).toBeInTheDocument();
    expect(within(notice).getByText("Criterion AC-3 will be reported as Inconclusive")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: /stages/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm and start/i })).not.toBeInTheDocument();
  });

  it("renders repeated confirmation warnings without duplicate React keys", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const warning = "Criterion AC-2 will be reported as Inconclusive";
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "AWAITING_CONFIRMATION" })),
      [`GET ${RUN}/criteria`]: () => json(200, requirementFixture()),
      [`POST ${RUN}/criteria/confirm`]: () => json(202, { revision: 1, warnings: [warning, warning] }),
    });
    render(<RunView runId="run_1" />);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: /confirm and start/i }));
    const notice = await screen.findByRole("status", { name: /criteria confirmed/i });
    expect(within(notice).getAllByText(warning)).toHaveLength(2);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/same key/i);
  });

  it("shows live progress: stage list, timeline and latest screenshot", async () => {
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "PLANNING" })),
      [`GET ${RUN}/artifacts/art_1/url`]: () => json(200, { url: "https://s3.test/a.png", expiresAt: "2026-09-26T10:05:00.000Z" }),
    });
    render(<RunView runId="run_1" />);
    await screen.findByRole("list", { name: /stages/i });
    await emit(
      ...toExploring,
      ev(8, "step.recorded", { stepId: "st_1", index: 0, kind: "navigate", outcome: "SUCCESS", blockReason: null }, { stage: "EXPLORING", message: "Step 1: navigate succeeded" }),
      ev(9, "artifact.created", { artifactId: "art_1", type: "SCREENSHOT", sensitivity: "STANDARD" }, { stage: "EXPLORING", message: "Screenshot saved at checkpoint before_add" }),
    );

    const stages = screen.getByRole("list", { name: /stages/i });
    expect(within(stages).getByText(/exploring website/i).closest("li")).toHaveTextContent(/in progress/i);
    expect(within(stages).getByText(/planning test/i).closest("li")).toHaveTextContent(/done/i);
    expect(within(stages).getByText(/verifying criteria/i).closest("li")).toHaveTextContent(/pending/i);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow");

    const timeline = screen.getByRole("list", { name: /timeline/i });
    expect(within(timeline).getByText("Step 1: navigate succeeded")).toBeInTheDocument();
    expect(within(timeline).getByText("Step 1")).toBeInTheDocument(); // step reference
    expect(await screen.findByRole("img", { name: /before_add/ })).toHaveAttribute("src", "https://s3.test/a.png");
  });

  it("cancels a running run after confirmation", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING" })),
      [`POST ${RUN}/cancel`]: () => json(202, summaryFixture({ lifecycle: "EXPLORING" })),
      [`GET ${RUN}/report`]: () => json(200, partialReport("CANCELLED")),
    });
    render(<RunView runId="run_1" />);
    await user.click(await screen.findByRole("button", { name: /^cancel run$/i }));
    expect(fetch).not.toHaveBeenCalledWith(`${RUN}/cancel`, expect.anything()); // asks first
    const dialog = screen.getByRole("group", { name: /cancel this run/i });
    await user.click(within(dialog).getByRole("button", { name: /yes, cancel/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${RUN}/cancel`, expect.objectContaining({ method: "POST" })));
    expect(await screen.findByRole("button", { name: /cancelling/i })).toBeDisabled();

    await emit(ev(10, "run.cancelled", { reason: "USER_REQUESTED" }, { stage: "CANCELLED", message: "Run cancelled by user" }));
    expect(await screen.findByRole("heading", { name: /run cancelled/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("keeps the run going when the user backs out of cancelling", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING" })) });
    render(<RunView runId="run_1" />);
    await user.click(await screen.findByRole("button", { name: /^cancel run$/i }));
    await user.click(screen.getByRole("button", { name: /keep running/i }));
    expect(screen.getByRole("button", { name: /^cancel run$/i })).toBeEnabled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shows a cancelled run with its reason", async () => {
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "CANCELLED", cancelReason: "CONFIRMATION_EXPIRED" })),
      [`GET ${RUN}/report`]: () => json(200, partialReport("CANCELLED")),
    });
    render(<RunView runId="run_1" />);
    expect(await screen.findByRole("heading", { name: /run cancelled/i })).toBeInTheDocument();
    expect(screen.getByText(/partial report/i)).toBeInTheDocument();
    expect(screen.getByText(/weren.t confirmed in time/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel run/i })).not.toBeInTheDocument();
  });

  it("shows an errored run as a partial report: category first, the raw error only as collapsed technical details", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING" }), summaryFixture({ lifecycle: "ERRORED", errorCategory: "BROWSER_PROVIDER" })),
      [`GET ${RUN}/report`]: () =>
        json(200, { ...partialReport("ERRORED"), error: { category: "BROWSER_PROVIDER", message: "chromium: No usable sandbox! at /tmp/x" } }),
    });
    render(<RunView runId="run_1" />);
    await screen.findByRole("list", { name: /stages/i });
    await emit(
      ...toExploring,
      ev(8, "run.errored", { category: "BROWSER_PROVIDER", message: "chromium: No usable sandbox! at /tmp/x" }, { stage: "ERRORED", message: "Run stopped: browser failed" }),
    );
    expect(await screen.findByRole("heading", { name: /run errored/i })).toBeInTheDocument();
    const headline = screen.getByRole("region", { name: /run errored/i });
    expect(within(headline).getByText("Browser error")).toBeInTheDocument();
    const details = within(headline).getByText(/technical details/i).closest("details")!;
    expect(details).not.toHaveAttribute("open");
    // The raw error text is nowhere but in that collapsed disclosure.
    const outside = headline.cloneNode(true) as HTMLElement;
    outside.querySelector("details")!.remove();
    expect(outside.textContent).not.toContain("No usable sandbox");

    // The run's activity (stages + template-only timeline) stays available.
    await user.click(screen.getByRole("button", { name: /run activity/i }));
    expect(screen.getAllByText("Run stopped: browser failed").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("list", { name: /stages/i })).getByText(/exploring website/i).closest("li")).toHaveTextContent(/stopped/i);
  });

  it("heads the page with the requirement, the target and a way back to the history", async () => {
    routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING", targetUrl: "https://shop.example.com/cart?bug=empty_cart" })) });
    render(<RunView runId="run_1" />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(summaryFixture().requirementPreview);
    const trail = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(trail).getByRole("link", { name: "Test runs" })).toHaveAttribute("href", "/runs");
    expect(within(trail).getByText("run_1")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("shop.example.com/cart?bug=empty_cart")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /run again/i })).not.toBeInTheDocument();
  });

  it("shows the run's model and reasoning as a meta chip, and repeats it on the report's cost card; nothing for runs without a recorded choice", async () => {
    const llm = { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", reasoning: "medium" } as const;
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "COMPLETED", verdict: "FAILED", llm })),
      [`GET ${RUN}/report`]: () => json(200, reportFixture()),
    });
    const { unmount } = render(<RunView runId="run_1" />);
    await screen.findByRole("heading", { name: /verdict: failed/i });
    expect(screen.getByText("Claude Sonnet 5 · medium reasoning", { selector: ".run-meta .meta-chip" })).toHaveTextContent(/Model:/);
    expect(screen.getByRole("group", { name: /estimated model cost/i })).toHaveTextContent("Claude Sonnet 5 · medium reasoning");
    unmount();

    routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING", llm: { ...llm, reasoning: "default" } })) });
    const second = render(<RunView runId="run_1" />);
    expect(await screen.findByText("Claude Sonnet 5 · model default")).toBeInTheDocument();
    second.unmount();

    routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING", llm: null })) });
    render(<RunView runId="run_1" />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/model default|reasoning/)).not.toBeInTheDocument();
  });

  it.each([
    [{ environment: "production", allowDestructiveActions: true }, "Production · destructive actions allowed"],
    [{ environment: "staging", allowDestructiveActions: true }, "Destructive actions allowed"],
  ] as const)("marks a run that allows destructive actions (%j)", async (patch, text) => {
    routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING", ...patch })) });
    render(<RunView runId="run_1" />);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("shows no destructive marker when the run doesn't allow destructive actions", async () => {
    routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING", environment: "production" })) });
    render(<RunView runId="run_1" />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/destructive actions allowed/i)).not.toBeInTheDocument();
  });

  it("shows the stages while the criteria await confirmation, with confirming as the current one", async () => {
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "AWAITING_CONFIRMATION" })),
      [`GET ${RUN}/criteria`]: () => json(200, requirementFixture()),
    });
    render(<RunView runId="run_1" />);
    await screen.findAllByRole("article");
    const stages = screen.getByRole("list", { name: /stages/i });
    expect(within(stages).getByText(/confirming criteria/i).closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(stages).getByText(/analyzing requirement/i).closest("li")).toHaveTextContent(/done/i);
  });

  it("shows the report of a completed run", async () => {
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "COMPLETED", verdict: "FAILED" })),
      [`GET ${RUN}/report`]: () => json(200, reportFixture()),
    });
    render(<RunView runId="run_1" />);
    expect(await screen.findByRole("heading", { name: /verdict: failed/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /run again/i })).toHaveAttribute("href", "/runs/new?from=run_1");
    expect(screen.getByRole("button", { name: /^AC-1\b/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run activity/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: /stages/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel run/i })).not.toBeInTheDocument();
  });

  it("hands the report the run's artifacts and steps from the event stream", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "COMPLETED", verdict: "FAILED" })),
      [`GET ${RUN}/report`]: () => json(200, reportFixture()),
      [`GET ${RUN}/artifacts/art_1/url`]: () => json(200, { url: "https://s3.test/after_add.png", expiresAt: "2099-01-01T00:00:00.000Z" }),
    });
    render(<RunView runId="run_1" />);
    await screen.findByRole("heading", { name: /verdict: failed/i });
    await emit(
      ev(1, "step.recorded", { stepId: "st_1", index: 0, kind: "navigate", outcome: "SUCCESS", blockReason: null }, { stage: "EXPLORING", message: "Step 1: navigate succeeded" }),
      ev(2, "artifact.created", { artifactId: "art_1", type: "SCREENSHOT", sensitivity: "STANDARD" }, { stage: "EXPLORING", message: "Screenshot saved at checkpoint after_add" }),
      ev(3, "run.completed", { verdict: "FAILED" }, { stage: "COMPLETED", message: "Run completed: FAILED" }),
    );
    await user.click(screen.getByRole("button", { name: /^AC-1\b/ }));
    const detail = screen.getByRole("region", { name: /AC-1/ });
    expect(within(detail).getByText("Step 1: navigate succeeded")).toBeInTheDocument();
    expect(await within(detail).findByRole("img", { name: /after_add/ })).toHaveAttribute("src", "https://s3.test/after_add.png");
  });

  describe("announces the end of a run it was watching", () => {
    const liveRegion = () => document.querySelector<HTMLElement>('[role="status"][aria-live="polite"][data-announcer]');

    it.each([
      ["completed", ev(8, "run.completed", { verdict: "FAILED" }, { stage: "COMPLETED", message: "Run completed: FAILED" }), "Run completed: Failed", reportFixture()],
      ["cancelled", ev(8, "run.cancelled", { reason: "USER_REQUESTED" }, { stage: "CANCELLED", message: "Run cancelled by user" }), "Run cancelled", partialReport("CANCELLED")],
      [
        "errored",
        ev(8, "run.errored", { category: "BROWSER_PROVIDER", message: "boom" }, { stage: "ERRORED", message: "Run stopped: browser failed" }),
        "Run stopped because of an error",
        partialReport("ERRORED"),
      ],
    ] as const)("%s", async (_label, terminalEvent, text, report) => {
      routeFetch({
        [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING" })),
        [`GET ${RUN}/report`]: () => json(200, report),
      });
      render(<RunView runId="run_1" />);
      await screen.findByRole("list", { name: /stages/i });
      // The live region is there (and empty) before anything is announced, so the change is heard.
      expect(liveRegion()).toBeInTheDocument();
      expect(liveRegion()).toHaveTextContent(/^$/);
      await emit(...toExploring, terminalEvent);
      await waitFor(() => expect(liveRegion()).toHaveTextContent(text));
      expect(liveRegion()).toHaveAttribute("aria-atomic", "true");
    });

    it("stays quiet for a run that had already ended when the page opened", async () => {
      routeFetch({
        [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "COMPLETED", verdict: "FAILED" })),
        [`GET ${RUN}/report`]: () => json(200, reportFixture()),
      });
      render(<RunView runId="run_1" />);
      await screen.findByRole("heading", { name: /verdict: failed/i });
      await emit(ev(3, "run.completed", { verdict: "FAILED" }, { stage: "COMPLETED", message: "Run completed: FAILED" }));
      expect(liveRegion()).toHaveTextContent(/^$/);
    });
  });

  it("reports a missing run", async () => {
    routeFetch({ [`GET ${RUN}`]: () => json(404, { code: "NOT_FOUND", message: "Not found" }) });
    render(<RunView runId="run_1" />);
    expect(await screen.findByRole("heading", { name: /run not found/i })).toBeInTheDocument();
    expect(streams).toHaveLength(0);
  });

  it("closes the event stream when unmounted", async () => {
    routeFetch({ [`GET ${RUN}`]: summaries(summaryFixture({ lifecycle: "EXPLORING" })) });
    const { unmount } = render(<RunView runId="run_1" />);
    await screen.findByRole("list", { name: /stages/i });
    await subscribed();
    unmount();
    expect(streams.every((s) => s.closed)).toBe(true);
  });
});
