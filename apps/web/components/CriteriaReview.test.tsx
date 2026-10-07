import type { NormalizedRequirement } from "@platform/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { json, requirementFixture, summaryFixture } from "../test/fixtures";
import { CriteriaReview } from "./CriteriaReview";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
beforeEach(() => push.mockReset());

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/** Routes `METHOD path` to a handler; records every call. */
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

const CRITERIA = "/api/v1/test-runs/run_1/criteria";
const CONFIRM = "/api/v1/test-runs/run_1/criteria/confirm";

describe("CriteriaReview", () => {
  it("renders every criterion", async () => {
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(3);
    expect(within(cards[0]!).getByText("The cart count increases after adding a product")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("AC-1")).toBeInTheDocument();
    expect(within(cards[2]!).getByText("The page feels fast")).toBeInTheDocument();
  });

  it("highlights ambiguous criteria with the reason and suggestions, and AI-judged ones", async () => {
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    const ambiguous = cards[1]!;
    expect(within(ambiguous).getByText(/needs clarification/i)).toBeInTheDocument();
    expect(within(ambiguous).getByText("Amount not specified")).toBeInTheDocument();
    expect(within(ambiguous).getByText("Increase by exactly 1")).toBeInTheDocument();
    expect(within(ambiguous).getByText("Increase by the quantity chosen")).toBeInTheDocument();
    expect(within(cards[2]!).getByText(/ai-judged/i)).toBeInTheDocument();
    expect(within(cards[0]!).queryByText(/needs clarification|ai-judged/i)).not.toBeInTheDocument();
  });

  it("shows what each criterion actually checks, in plain language", async () => {
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    const check = (card: HTMLElement) => within(card).getByRole("group", { name: /what will be checked/i });
    expect(check(cards[0]!)).toHaveTextContent("Cart badge count (at “after add”) is greater than Cart badge count (at “before add”).");
    expect(check(cards[1]!)).toHaveTextContent("Cart badge count (at “after add”) is exactly 1 more than Cart badge count (at “before add”).");
    expect(check(cards[2]!)).toHaveTextContent("Judged by AI from what the page shows: “The page responds quickly”.");
    expect(screen.queryByText(/rewording changes the description only/i)).not.toBeInTheDocument();
  });

  it("won't confirm while a check editor is open, and says which one", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" }));

    const confirm = screen.getByRole("button", { name: /confirm and start/i });
    expect(confirm).toBeDisabled();
    expect(screen.getByText("Save or discard your edit to AC-2 first.")).toBeInTheDocument();
    expect(confirm).toHaveAccessibleDescription(/save or discard your edit to AC-2 first/i);

    await user.click(within(cards[0]!).getByRole("button", { name: "Edit check AC-1" }));
    expect(screen.getByText("Save or discard your edits to AC-1 and AC-2 first.")).toBeInTheDocument();

    await user.click(within(cards[0]!).getByRole("button", { name: /discard/i }));
    await user.click(within(cards[1]!).getByRole("button", { name: /discard/i }));
    expect(confirm).toBeEnabled();
    expect(screen.queryByText(/save or discard/i)).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2); // nothing was sent (the criteria and the site analysis, V1.3)
  });

  it("keeps another card's open check draft when a different criterion is saved", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`PUT ${CRITERIA}`]: (init) => json(200, { ...JSON.parse(String(init!.body)), revision: 2 }),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    // An unsaved draft on AC-2 …
    await user.click(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" }));
    const delta = within(cards[1]!).getByLabelText(/difference/i);
    await user.clear(delta);
    await user.type(delta, "3");
    // … while AC-1's comparison is changed and saved.
    await user.click(within(cards[0]!).getByRole("button", { name: "Edit check AC-1" }));
    await user.selectOptions(within(cards[0]!).getByLabelText(/comparison/i), "gte");
    await user.click(within(cards[0]!).getByRole("button", { name: /save check/i }));
    await screen.findByText(/revision 2/i);

    const after = screen.getAllByRole("article");
    expect(within(after[0]!).getByRole("group", { name: /what will be checked/i })).toHaveTextContent("is at least");
    expect(within(after[1]!).getByLabelText(/difference/i)).toHaveValue("3");
    expect(screen.getByRole("button", { name: /confirm and start/i })).toBeDisabled();
    expect(screen.getByText("Save or discard your edit to AC-2 first.")).toBeInTheDocument();
  });

  it("confirm is available again once the open check edit is saved", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`PUT ${CRITERIA}`]: (init) => json(200, { ...JSON.parse(String(init!.body)), revision: 2 }),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" }));
    const delta = within(cards[1]!).getByLabelText(/difference/i);
    await user.clear(delta);
    await user.type(delta, "2");
    expect(screen.getByRole("button", { name: /confirm and start/i })).toBeDisabled();
    await user.click(within(cards[1]!).getByRole("button", { name: /save check/i }));
    await screen.findByText(/revision 2/i);
    expect(screen.getByRole("button", { name: /confirm and start/i })).toBeEnabled();
  });

  it("editing a check sends PUT with the edited check and its generated wording, and shows the saved revision", async () => {
    const user = userEvent.setup();
    let sent: NormalizedRequirement | null = null;
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`PUT ${CRITERIA}`]: (init) => {
        sent = JSON.parse(String(init!.body));
        return json(200, { ...sent!, revision: 2 });
      },
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" }));
    const delta = within(cards[1]!).getByLabelText(/difference/i);
    await user.clear(delta);
    await user.type(delta, "2");
    const wording = "Cart badge count (at “after add”) is exactly 2 more than Cart badge count (at “before add”).";
    expect(within(cards[1]!).getByText(wording)).toBeInTheDocument(); // live preview
    await user.click(within(cards[1]!).getByRole("button", { name: /save check/i }));

    await waitFor(() => expect(sent).not.toBeNull());
    const expected = requirementFixture();
    const ac2 = expected.criteria[1]!;
    if (ac2.expectedOutcome.kind !== "numeric_delta") throw new Error("fixture changed: AC-2 should be a numeric_delta check");
    expected.criteria[1] = { ...ac2, expectedOutcome: { ...ac2.expectedOutcome, delta: 2 }, statement: wording, ambiguity: null };
    expect(sent).toEqual(expected);
    expect(await screen.findByText(/revision 2/i)).toBeInTheDocument();
  });

  it("saving a check that wasn't changed sends nothing and just closes the editor", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" }));
    const delta = within(cards[1]!).getByLabelText(/difference/i);
    await user.clear(delta);
    await user.type(delta, "1.0"); // the same value, typed differently
    await user.click(within(cards[1]!).getByRole("button", { name: /save check/i }));
    expect(within(cards[1]!).queryByRole("button", { name: /save check/i })).not.toBeInTheDocument();
    expect(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2); // only the initial GET (the criteria and the site analysis, V1.3)
    expect(screen.getByRole("button", { name: /confirm and start/i })).toBeEnabled();
  });

  it("moves focus into the editor when it opens, and back to Edit check when it closes", async () => {
    const user = userEvent.setup();
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" }));
    expect(within(cards[1]!).getByLabelText(/difference/i)).toHaveFocus();
    await user.click(within(cards[1]!).getByRole("button", { name: /discard/i }));
    expect(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" })).toHaveFocus();
  });

  it("an AI-judged criterion has no check editor, only Remove", async () => {
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    expect(within(cards[2]!).queryByRole("button", { name: /edit check/i })).not.toBeInTheDocument();
    expect(within(cards[2]!).getByText(/judged by ai only — it can only be removed/i)).toBeInTheDocument();
    expect(within(cards[2]!).getByRole("button", { name: "Remove AC-3" })).toBeInTheDocument();
  });

  it("shows the API's 400 inline in the editor and keeps it open", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`PUT ${CRITERIA}`]: () =>
        json(400, {
          code: "VALIDATION_FAILED",
          message: "Only a criterion's check values can change during review",
          issues: [{ path: ["criteria", 1, "expectedOutcome"], message: "Only the check's values can change, not what it reads" }],
        }),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[1]!).getByRole("button", { name: "Edit check AC-2" }));
    const delta = within(cards[1]!).getByLabelText(/difference/i);
    await user.clear(delta);
    await user.type(delta, "2");
    await user.click(within(cards[1]!).getByRole("button", { name: /save check/i }));
    expect(await within(cards[1]!).findByRole("alert")).toHaveTextContent("Only the check's values can change, not what it reads");
    expect(within(cards[1]!).getByRole("button", { name: /save check/i })).toBeInTheDocument();
  });

  it("no longer offers free-text rewording", async () => {
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    await screen.findAllByRole("article");
    expect(screen.queryByRole("button", { name: /^edit AC-/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/rewording changes the description only/i)).not.toBeInTheDocument();
  });

  it("removing a criterion sends PUT without it", async () => {
    const user = userEvent.setup();
    let sent: NormalizedRequirement | null = null;
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`PUT ${CRITERIA}`]: (init) => {
        sent = JSON.parse(String(init!.body));
        return json(200, { ...sent!, revision: 2 });
      },
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[2]!).getByRole("button", { name: /remove/i }));
    const ask = within(cards[2]!).getByRole("group", { name: /remove AC-3\?/i });
    await user.click(within(ask).getByRole("button", { name: /yes, remove/i }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent!.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
  });

  it("marks a criterion non-critical with PUT, and keeps the last critical one on (V1.1)", async () => {
    const user = userEvent.setup();
    let sent: NormalizedRequirement | null = null;
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`PUT ${CRITERIA}`]: (init) => {
        sent = JSON.parse(String(init!.body));
        return json(200, { ...sent!, revision: 2 });
      },
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    const box = within(cards[1]!).getByRole("checkbox", { name: "Critical" });
    expect(box).toBeChecked();
    await user.click(box);
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent!.criteria.map((c) => c.critical)).toEqual([true, false, true]);
    expect(sent!.criteria[1]!.statement).toBe(requirementFixture().criteria[1]!.statement);
    await waitFor(() => expect(within(cards[1]!).getByRole("checkbox", { name: "Critical" })).not.toBeChecked());
    expect(within(screen.getByRole("complementary")).getByText("Non-critical")).toBeInTheDocument();
  });

  it("disables the switch on the only critical criterion", async () => {
    const r = requirementFixture();
    r.criteria = r.criteria.map((c, i) => ({ ...c, critical: i === 0 }));
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, r) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    expect(within(cards[0]!).getByRole("checkbox", { name: "Critical" })).toBeDisabled();
    expect(within(cards[0]!).getByText("Decides the verdict. At least one criterion must stay critical.")).toBeInTheDocument();
    expect(within(cards[1]!).getByRole("checkbox", { name: "Critical" })).toBeEnabled();
  });

  it("renders repeated suggestions without duplicate React keys", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = requirementFixture();
    r.criteria[1]!.ambiguity = { reason: "Amount not specified", suggestions: ["Increase by 1", "Increase by 1"] };
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, r) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    expect(within(cards[1]!).getAllByText("Increase by 1")).toHaveLength(2);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/same key/i);
  });

  it("asks before removing a criterion, and keeps it when the user backs out", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[2]!).getByRole("button", { name: /remove AC-3/i }));
    const ask = within(cards[2]!).getByRole("group", { name: /remove AC-3\?/i });
    expect(within(ask).getByRole("button", { name: /keep it/i })).toHaveFocus();
    await user.click(within(ask).getByRole("button", { name: /keep it/i }));
    expect(within(cards[2]!).queryByRole("group", { name: /remove AC-3\?/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(2); // only the initial GET (the criteria and the site analysis, V1.3)
  });

  it("confirm shows the server warnings and hands them on; the button is disabled while pending", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`POST ${CONFIRM}`]: async () => {
        await gate;
        return json(202, { revision: 1, warnings: ["Criterion AC-2 will be reported as Inconclusive"] });
      },
    });
    const onConfirmed = vi.fn();
    render(<CriteriaReview runId="run_1" onConfirmed={onConfirmed} />);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: /confirm and start/i }));
    expect(screen.getByRole("button", { name: /starting/i })).toBeDisabled();
    release();
    await waitFor(() =>
      expect(onConfirmed).toHaveBeenCalledWith({ revision: 1, warnings: ["Criterion AC-2 will be reported as Inconclusive"] }),
    );
  });

  it("shows a server error from confirm and re-enables the button", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`POST ${CONFIRM}`]: () => json(409, { code: "CONFLICT", message: "Run is CANCELLED; criteria cannot be confirmed" }),
    });
    const onConfirmed = vi.fn();
    render(<CriteriaReview runId="run_1" onConfirmed={onConfirmed} />);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: /confirm and start/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be confirmed/i);
    expect(screen.getByRole("button", { name: /confirm and start/i })).toBeEnabled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  const CANCEL = "/api/v1/test-runs/run_1/cancel";

  it("start over: asks first, cancels the run, then opens the pre-filled new-test form", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`POST ${CANCEL}`]: () => json(200, summaryFixture({ lifecycle: "CANCELLED", cancelReason: "USER_REQUESTED" })),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: /start over with a revised requirement/i }));
    expect(screen.getByText(/test data and secrets must be entered again/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2); // nothing cancelled yet (the criteria and the site analysis, V1.3)
    await user.click(screen.getByRole("button", { name: /yes, start over/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/new?from=run_1"));
    expect(fetch.mock.calls.map(([u, i]) => `${i?.method ?? "GET"} ${String(u)}`)).toContain(`POST ${CANCEL}`);
  });

  it("start over still opens the form when the run can no longer be cancelled (409)", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`POST ${CANCEL}`]: () => json(409, { code: "CONFLICT", message: "Run is CANCELLED" }),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: /start over with a revised requirement/i }));
    await user.click(screen.getByRole("button", { name: /yes, start over/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/new?from=run_1"));
  });

  it("start over shows an error and stays when cancelling fails otherwise", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`POST ${CANCEL}`]: () => json(503, { code: "UNAVAILABLE", message: "Try again" }),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: /start over with a revised requirement/i }));
    await user.click(screen.getByRole("button", { name: /yes, start over/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("CriteriaReview: the live-site analysis and suggested test data (V1.3)", () => {
  const SITE = "/api/v1/test-runs/run_1/site-analysis";
  const analysis = {
    status: "READ",
    reason: null,
    pages: [
      { url: "https://shop.example.com/", title: "Home", status: "READ" },
      { url: "https://shop.example.com/cart", title: "", status: "SKIPPED" },
    ],
    checks: [
      { criterionId: "AC-1", status: "FOUND", note: "The header shows a cart count badge" },
      { criterionId: "AC-2", status: "NOT_FOUND", note: "No quantity selector on the pages read" },
    ],
    testData: [
      { key: "email", value: "qa.abc123@example.com", description: "Email to register with", source: "GENERATED" },
      { key: "productName", value: "iPhone 17 Pro", description: "A listed product", source: "SITE" },
      { key: "quantity", value: 2, description: "How many to add", source: "GENERATED" },
    ],
    appliedKeys: [],
  };

  it("shows the pages read and what each criterion's check found on them", async () => {
    routeFetch({ [`GET ${CRITERIA}`]: () => json(200, requirementFixture()), [`GET ${SITE}`]: () => json(200, analysis) });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    expect(await screen.findByText("Checked against the live site")).toBeInTheDocument();
    expect(screen.getByText(/1 page read before the criteria were written/)).toBeInTheDocument();
    expect(screen.getByText(/1 criterion checks something the pages read don/)).toBeInTheDocument();
    const cards = screen.getAllByRole("article");
    expect(within(cards[0]!).getByText(/seen on the site/i)).toBeInTheDocument();
    expect(within(cards[0]!).getByText(/the header shows a cart count badge/i)).toBeInTheDocument();
    expect(within(cards[1]!).getByText(/not found on the pages read/i)).toBeInTheDocument();
    expect(within(cards[2]!).queryByText(/on the site|pages read/i)).not.toBeInTheDocument();
  });

  it("confirm sends the suggested test data that was kept, as edited", async () => {
    const user = userEvent.setup();
    const onConfirmed = vi.fn();
    const fetch = routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`GET ${SITE}`]: () => json(200, analysis),
      [`POST ${CONFIRM}`]: () => json(202, { revision: 1, warnings: [] }),
    });
    render(<CriteriaReview runId="run_1" onConfirmed={onConfirmed} />);
    const email = await screen.findByLabelText("Value for email");
    expect(email).toHaveValue("qa.abc123@example.com");
    expect(screen.getByText("From the site")).toBeInTheDocument();
    await user.clear(email);
    await user.type(email, "me@example.com");
    await user.click(screen.getByRole("checkbox", { name: /productName/ }));
    expect(screen.getByLabelText("Value for productName")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /confirm and start/i }));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    const [, init] = fetch.mock.calls.find(([url, i]) => String(url) === CONFIRM && i?.method === "POST")!;
    expect(JSON.parse(String(init!.body))).toEqual({ testData: { email: "me@example.com", quantity: 2 } });
  });

  it("a run without an analysis confirms as before, with no body", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`GET ${SITE}`]: () => json(404, { code: "NO_SITE_ANALYSIS", message: "none" }),
      [`POST ${CONFIRM}`]: () => json(202, { revision: 1, warnings: [] }),
    });
    const onConfirmed = vi.fn();
    render(<CriteriaReview runId="run_1" onConfirmed={onConfirmed} />);
    await screen.findAllByRole("article");
    expect(screen.queryByText("Checked against the live site")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /confirm and start/i }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalled());
    const [, init] = fetch.mock.calls.find(([url]) => String(url) === CONFIRM)!;
    expect(init!.body).toBeUndefined();
  });
});
