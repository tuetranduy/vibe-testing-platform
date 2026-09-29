import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json, suggestionsFixture, summaryFixture } from "../test/fixtures";
import { SuggestionReview } from "./SuggestionReview";

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

const SUGGESTIONS = "/api/v1/test-runs/run_1/suggestions";
const SELECT = "/api/v1/test-runs/run_1/suggestions/select";

function renderReview(routes: Record<string, Handler>) {
  const fetch = routeFetch(routes);
  const onSelected = vi.fn();
  const onCancel = vi.fn();
  render(<SuggestionReview runId="run_1" onSelected={onSelected} onCancel={onCancel} />);
  return { fetch, onSelected, onCancel };
}
const cardOf = async (title: string) => (await screen.findByRole("article", { name: title })) as HTMLElement;

describe("SuggestionReview", () => {
  it("shows one card per suggestion: title, the test, why, and a link to start it as a separate test", async () => {
    renderReview({ [`GET ${SUGGESTIONS}`]: () => json(200, suggestionsFixture()) });
    expect(await screen.findByRole("heading", { name: "Choose what to test" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(4);
    const card = await cardOf("Search for a product");
    expect(within(card).getByText(suggestionsFixture().suggestions[1]!.requirement)).toBeInTheDocument();
    expect(within(card).getByText("Why: Every page has a product search form.")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /start as a separate test/i })).toHaveAttribute("href", "/runs/new?from=run_1&suggestion=S-2");
  });

  it("marks a need the run lacks, and not one it has", async () => {
    renderReview({ [`GET ${SUGGESTIONS}`]: () => json(200, suggestionsFixture()) });
    const needs = within(await cardOf("Sign in to the account")).getByRole("list", { name: /needs/i });
    const [password, email] = within(needs).getAllByRole("listitem");
    expect(password).toHaveTextContent("password — not provided — start it as a separate test to add it");
    expect(email).toHaveTextContent("email");
    expect(email).not.toHaveTextContent(/not provided/);
    expect(within(await cardOf("Search for a product")).queryByRole("list", { name: /needs/i })).not.toBeInTheDocument();
  });

  it("badges a destructive suggestion, and says it will be blocked when the run doesn't allow destructive actions", async () => {
    renderReview({ [`GET ${SUGGESTIONS}`]: () => json(200, suggestionsFixture()) });
    const card = await cardOf("Empty the cart");
    expect(within(card).getByText("Changes data")).toBeInTheDocument();
    expect(within(card).getByText("Will be blocked: this run doesn't allow destructive actions")).toBeInTheDocument();
    expect(within(await cardOf("Search for a product")).queryByText("Changes data")).not.toBeInTheDocument();
  });

  it("no 'will be blocked' note when the run allows destructive actions", async () => {
    renderReview({
      [`GET ${SUGGESTIONS}`]: () => json(200, suggestionsFixture({ run: { secretNames: [], testDataKeys: [], destructiveActionsAllowed: true } })),
    });
    const card = await cardOf("Empty the cart");
    expect(within(card).getByText("Changes data")).toBeInTheDocument();
    expect(within(card).queryByText(/will be blocked/i)).not.toBeInTheDocument();
  });

  it("'Test this' opens the text for editing; 'Continue with this test' chooses it with the edit", async () => {
    const user = userEvent.setup();
    const { fetch, onSelected } = renderReview({
      [`GET ${SUGGESTIONS}`]: () => json(200, suggestionsFixture()),
      [`POST ${SELECT}`]: () => json(202, summaryFixture({ lifecycle: "ANALYZING_REQUIREMENT", requirementPreview: "Searching for Pixel lists Pixel 11 only." })),
    });
    const card = await cardOf("Search for a product");
    await user.click(within(card).getByRole("button", { name: /test this/i }));
    const text = within(card).getByRole("textbox", { name: /the test to run/i });
    expect(text).toHaveValue(suggestionsFixture().suggestions[1]!.requirement);
    await user.clear(text);
    await user.type(text, "Searching for Pixel lists Pixel 11 only.");
    await user.click(within(card).getByRole("button", { name: /continue with this test/i }));

    await waitFor(() => expect(onSelected).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ANALYZING_REQUIREMENT" })));
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ suggestionId: "S-2", requirement: "Searching for Pixel lists Pixel 11 only." });
  });

  it("an unchanged text is chosen without sending it (the choice is not an edit)", async () => {
    const user = userEvent.setup();
    const { fetch } = renderReview({
      [`GET ${SUGGESTIONS}`]: () => json(200, suggestionsFixture()),
      [`POST ${SELECT}`]: () => json(202, summaryFixture({ lifecycle: "ANALYZING_REQUIREMENT" })),
    });
    const card = await cardOf("Add a product to the cart");
    await user.click(within(card).getByRole("button", { name: /test this/i }));
    await user.click(within(card).getByRole("button", { name: /continue with this test/i }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ suggestionId: "S-1" });
  });

  it("refuses a text under 10 characters inline, without a request", async () => {
    const user = userEvent.setup();
    const { fetch } = renderReview({ [`GET ${SUGGESTIONS}`]: () => json(200, suggestionsFixture()) });
    const card = await cardOf("Search for a product");
    await user.click(within(card).getByRole("button", { name: /test this/i }));
    const text = within(card).getByRole("textbox", { name: /the test to run/i });
    await user.clear(text);
    await user.type(text, "too short");
    await user.click(within(card).getByRole("button", { name: /continue with this test/i }));
    expect(text).toHaveAttribute("aria-invalid", "true");
    expect(text).toHaveAccessibleDescription(/Describe the test in at least 10 characters\./);
    expect(fetch).toHaveBeenCalledTimes(1); // only the GET
  });

  it("shows the server's issue on the text, other errors as an alert, and lets the user try again", async () => {
    const user = userEvent.setup();
    const answers = [
      json(400, { code: "VALIDATION_FAILED", message: "Request validation failed", issues: [{ path: ["requirement"], message: "Keep the test under 20,000 characters" }] }),
      json(409, { code: "RUN_NOT_AWAITING_SELECTION", message: "Run is CANCELLED; a suggested test can only be chosen while the run awaits a choice" }),
    ];
    renderReview({ [`GET ${SUGGESTIONS}`]: () => json(200, suggestionsFixture()), [`POST ${SELECT}`]: () => answers.shift()! });
    const card = await cardOf("Search for a product");
    await user.click(within(card).getByRole("button", { name: /test this/i }));
    await user.click(within(card).getByRole("button", { name: /continue with this test/i }));
    expect(await within(card).findByText(/keep the test under 20,000 characters/i)).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: /continue with this test/i }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(/run is cancelled/i);
    expect(within(card).getByRole("button", { name: /continue with this test/i })).toBeEnabled();
  });

  it("'None of these — cancel run' hands over to the page's cancel confirmation", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderReview({ [`GET ${SUGGESTIONS}`]: () => json(200, suggestionsFixture()) });
    await user.click(await screen.findByRole("button", { name: "None of these — cancel run" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("lists the pages it explored under a disclosure", async () => {
    const user = userEvent.setup();
    renderReview({ [`GET ${SUGGESTIONS}`]: () => json(200, suggestionsFixture()) });
    await user.click(await screen.findByRole("button", { name: /pages explored/i }));
    expect(screen.getByText("shop.example.com/cart — Your cart · Demo Shop")).toBeInTheDocument();
    expect(screen.getByText("shop.example.com/account — Skipped")).toBeInTheDocument();
  });

  it("says when the suggestions couldn't be loaded", async () => {
    renderReview({ [`GET ${SUGGESTIONS}`]: () => json(404, { code: "NO_SUGGESTIONS", message: "This run has no suggested tests" }) });
    expect(await screen.findByRole("alert")).toHaveTextContent(/this run has no suggested tests/i);
  });
});
