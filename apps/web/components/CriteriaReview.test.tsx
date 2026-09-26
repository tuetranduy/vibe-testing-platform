import type { NormalizedRequirement } from "@platform/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json, requirementFixture } from "../test/fixtures";
import { CriteriaReview } from "./CriteriaReview";

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

  it("editing a criterion sends PUT with the full requirement", async () => {
    const user = userEvent.setup();
    let sent: NormalizedRequirement | null = null;
    const fetch = routeFetch({
      [`GET ${CRITERIA}`]: () => json(200, requirementFixture()),
      [`PUT ${CRITERIA}`]: (init) => {
        sent = JSON.parse(String(init!.body));
        return json(200, { ...sent!, revision: 2 });
      },
    });
    render(<CriteriaReview runId="run_1" onConfirmed={() => {}} />);
    const cards = await screen.findAllByRole("article");
    await user.click(within(cards[1]!).getByRole("button", { name: /edit/i }));
    const box = within(cards[1]!).getByLabelText(/criterion AC-2/i);
    await user.clear(box);
    await user.type(box, "The cart count increases by exactly 1");
    await user.click(within(cards[1]!).getByRole("button", { name: /save/i }));

    await waitFor(() => expect(sent).not.toBeNull());
    const expected = requirementFixture();
    expected.criteria[1]!.statement = "The cart count increases by exactly 1";
    expect(sent).toEqual(expected);
    expect(new Headers(fetch.mock.calls[1]![1]!.headers).get("content-type")).toBe("application/json");
    expect(await screen.findByText("The cart count increases by exactly 1")).toBeInTheDocument();
    expect(screen.getByText(/revision 2/i)).toBeInTheDocument();
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
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent!.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
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
});
