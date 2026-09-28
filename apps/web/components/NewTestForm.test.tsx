import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { json, requirementFixture, summaryFixture } from "../test/fixtures";
import { NewTestForm } from "./NewTestForm";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));


function mockFetch(...responses: Response[]) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => responses.shift() ?? json(500, {}));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/website url/i), "https://shop.example.com");
  await user.type(screen.getByLabelText(/requirement/i), "A user can add a product to the cart.");
}

const bodyOf = (fetch: ReturnType<typeof mockFetch>, call = 0) => JSON.parse(String(fetch.mock.calls[call]![1]!.body));

beforeEach(() => push.mockReset());

describe("NewTestForm", () => {
  it("requires an http(s) URL", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch();
    render(<NewTestForm />);
    await user.type(screen.getByLabelText(/website url/i), "ftp://shop.example.com");
    await user.type(screen.getByLabelText(/requirement/i), "A user can add a product to the cart.");
    await user.click(screen.getByRole("button", { name: /start test/i }));
    const url = screen.getByLabelText(/website url/i);
    expect(url).toHaveAttribute("aria-invalid", "true");
    expect(url).toHaveAccessibleDescription(/http/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a requirement of at least 10 characters", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch();
    render(<NewTestForm />);
    await user.type(screen.getByLabelText(/website url/i), "https://shop.example.com");
    await user.type(screen.getByLabelText(/requirement/i), "too short");
    await user.click(screen.getByRole("button", { name: /start test/i }));
    expect(screen.getByLabelText(/requirement/i)).toHaveAccessibleDescription(/at least 10 characters/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("submits the request with an idempotency key and opens the run", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch(json(202, { runId: "run_42", lifecycle: "QUEUED", eventsUrl: "/v1/test-runs/run_42/events" }));
    render(<NewTestForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /add test data/i }));
    await user.type(screen.getByLabelText(/test data 1 key/i), "searchTerm");
    await user.type(screen.getByLabelText(/test data 1 value/i), "iPhone");
    await user.click(screen.getByRole("button", { name: /add test data/i })); // an empty row is omitted
    await user.click(screen.getByRole("button", { name: /start test/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/run_42"));
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/v1/test-runs");
    expect(init!.method).toBe("POST");
    expect(new Headers(init!.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodyOf(fetch)).toMatchObject({
      targetUrl: "https://shop.example.com",
      requirement: "A user can add a product to the cart.",
      environment: "staging",
      testData: { searchTerm: "iPhone" },
      secrets: {},
      options: { autoConfirmCriteria: false, allowDestructiveActions: false },
    });
  });

  it("validates test data keys with the contract's key rule", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch();
    render(<NewTestForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /add test data/i }));
    await user.type(screen.getByLabelText(/test data 1 key/i), "1 bad key");
    await user.type(screen.getByLabelText(/test data 1 value/i), "x");
    await user.click(screen.getByRole("button", { name: /start test/i }));
    expect(screen.getByLabelText(/test data 1 key/i)).toHaveAttribute("aria-invalid", "true");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders secret values as password inputs and clears them after submit", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch(json(503, { code: "QUEUE_UNAVAILABLE", message: "The run could not be queued; please retry" }));
    render(<NewTestForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /add secret/i }));
    const value = screen.getByLabelText(/secret 1 value/i);
    expect(value).toHaveAttribute("type", "password");
    expect(value).toHaveAttribute("autocomplete", "new-password"); // never offer or save a stored password
    await user.type(screen.getByLabelText(/secret 1 name/i), "password");
    await user.type(value, "hunter2!");
    await user.click(screen.getByRole("button", { name: /start test/i }));

    await screen.findByRole("alert");
    expect(bodyOf(fetch).secrets).toEqual({ password: "hunter2!" });
    expect(screen.getByLabelText(/secret 1 value/i)).toHaveValue("");
    expect(screen.getByLabelText(/secret 1 name/i)).toHaveValue("password"); // name kept so it can be re-entered
    expect(screen.getByText(/enter them again/i)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("hunter2!");
  });

  it("shows 422 TARGET_NOT_ALLOWED inline on the URL field", async () => {
    const user = userEvent.setup();
    mockFetch(
      json(422, {
        code: "TARGET_NOT_ALLOWED",
        message: "Target URL is not allowed: resolves to a private address",
        issues: [{ path: ["targetUrl"], message: "resolves to a private address" }],
      }),
    );
    render(<NewTestForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /start test/i }));

    const url = screen.getByLabelText(/website url/i);
    await waitFor(() => expect(url).toHaveAttribute("aria-invalid", "true"));
    expect(url).toHaveAccessibleDescription(/not allowed.*private address/i);
    expect(screen.queryByRole("alert", { name: /too many/i })).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows 429 TOO_MANY_ACTIVE_RUNS as a banner", async () => {
    const user = userEvent.setup();
    mockFetch(json(429, { code: "TOO_MANY_ACTIVE_RUNS", message: "Too many active runs; wait for one to finish" }));
    render(<NewTestForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /start test/i }));

    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText(/too many active runs/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/website url/i)).not.toHaveAttribute("aria-invalid", "true");
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps advanced options collapsed until opened", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch(json(202, { runId: "run_1", lifecycle: "QUEUED", eventsUrl: "/v1/test-runs/run_1/events" }));
    render(<NewTestForm />);
    expect(screen.getByLabelText(/confirm criteria automatically/i)).not.toBeVisible();
    await user.click(screen.getByText("Advanced options"));
    await user.click(screen.getByLabelText(/confirm criteria automatically/i));
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /start test/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(bodyOf(fetch).options.autoConfirmCriteria).toBe(true);
  });

  it("keeps test data and secrets collapsed, and says what is set in each", async () => {
    const user = userEvent.setup();
    render(<NewTestForm />);
    const dataSection = screen.getByText("Test data").closest("details")!;
    const secretSection = screen.getByText("Secrets").closest("details")!;
    expect(dataSection).not.toHaveAttribute("open");
    expect(secretSection).not.toHaveAttribute("open");
    expect(within(dataSection).getByRole("button", { name: /add test data/i })).not.toBeVisible();
    expect(within(dataSection.querySelector("summary")!).getByText("None")).toBeInTheDocument();

    await user.click(screen.getByText("Test data"));
    expect(dataSection).toHaveAttribute("open");
    await user.click(within(dataSection).getByRole("button", { name: /add test data/i }));
    await user.type(screen.getByLabelText(/test data 1 key/i), "searchTerm");
    expect(within(dataSection.querySelector("summary")!).getByText("1 value")).toBeInTheDocument();

    await user.click(screen.getByText("Secrets"));
    await user.click(within(secretSection).getByRole("button", { name: /add secret/i }));
    await user.type(screen.getByLabelText(/secret 1 name/i), "password");
    expect(within(secretSection.querySelector("summary")!).getByText("1 secret")).toBeInTheDocument();
  });

  it("summarizes the advanced options while they are collapsed", async () => {
    const user = userEvent.setup();
    render(<NewTestForm />);
    const summary = screen.getByText("Advanced options").closest("summary")!;
    expect(summary).toHaveTextContent("40 steps · 5 min · rerun on");
    await user.click(summary);
    await user.clear(screen.getByLabelText(/max run time/i));
    await user.type(screen.getByLabelText(/max run time/i), "90");
    await user.click(screen.getByLabelText(/rerun the generated test/i));
    expect(summary).toHaveTextContent("40 steps · 90s · no rerun");
  });

  it("opens a collapsed section to show an invalid field in it", async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<NewTestForm />);
    await fillValid(user);
    await user.click(screen.getByText("Test data"));
    await user.click(screen.getByRole("button", { name: /add test data/i }));
    await user.type(screen.getByLabelText(/test data 1 key/i), "1 bad key");
    await user.click(screen.getByText("Test data")); // collapse it again
    expect(screen.getByText("Test data").closest("details")).not.toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: /start test/i }));
    expect(screen.getByText("Test data").closest("details")).toHaveAttribute("open");
    expect(screen.getByLabelText(/test data 1 key/i)).toHaveFocus();
  });

  it("offers example requirements while the requirement is empty", async () => {
    const user = userEvent.setup();
    render(<NewTestForm />);
    const examples = screen.getByRole("group", { name: /examples/i });
    await user.click(within(examples).getByRole("button", { name: "Search lists matching products" }));
    const requirement = screen.getByLabelText(/requirement/i);
    expect(requirement).toHaveValue("Searching for a product name lists only products whose names contain it.");
    expect(requirement).toHaveFocus(); // the example buttons are gone, so focus moves on
    expect(screen.queryByRole("group", { name: /examples/i })).not.toBeInTheDocument();

    await user.clear(requirement);
    expect(screen.getByRole("group", { name: /examples/i })).toBeInTheDocument();
  });

  it("creates a run on an insecure origin, where crypto.randomUUID is unavailable", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    const user = userEvent.setup();
    const fetch = mockFetch(json(202, { runId: "run_7", lifecycle: "QUEUED", eventsUrl: "/v1/test-runs/run_7/events" }));
    render(<NewTestForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /start test/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/run_7"));
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs an unexpected client-side error and says it happened in the browser", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    push.mockImplementationOnce(() => {
      throw new Error("router exploded");
    });
    const user = userEvent.setup();
    mockFetch(json(202, { runId: "run_8", lifecycle: "QUEUED", eventsUrl: "/v1/test-runs/run_8/events" }));
    render(<NewTestForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /start test/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/in the browser/i);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/new test/i), expect.objectContaining({ message: "router exploded" }));
  });

  describe("Idempotency-Key across retries", () => {
    const keyOf = (fetch: ReturnType<typeof mockFetch>, call: number) => new Headers(fetch.mock.calls[call]![1]!.headers).get("idempotency-key");
    const created = () => json(202, { runId: "run_5", lifecycle: "QUEUED", eventsUrl: "/v1/test-runs/run_5/events" });

    it("reuses the key when the same request is retried after a lost response", async () => {
      const user = userEvent.setup();
      let calls = 0;
      const fetch = vi.fn(async () => {
        if (calls++ === 0) throw new TypeError("Failed to fetch"); // the run may have been created
        return created();
      });
      vi.stubGlobal("fetch", fetch);
      render(<NewTestForm />);
      await fillValid(user);
      await user.click(screen.getByRole("button", { name: /start test/i }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach the server/i);
      await user.click(screen.getByRole("button", { name: /start test/i }));
      await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/run_5"));
      expect(keyOf(fetch as never, 1)).toBe(keyOf(fetch as never, 0));
    });

    it("reuses the key when only the (re-entered) secret values are sent again", async () => {
      const user = userEvent.setup();
      const fetch = mockFetch(json(503, { code: "QUEUE_UNAVAILABLE", message: "The run could not be queued; please retry" }), created());
      render(<NewTestForm />);
      await fillValid(user);
      await user.click(screen.getByRole("button", { name: /add secret/i }));
      await user.type(screen.getByLabelText(/secret 1 name/i), "password");
      await user.type(screen.getByLabelText(/secret 1 value/i), "hunter2!");
      await user.click(screen.getByRole("button", { name: /start test/i }));
      await screen.findByRole("alert");
      await user.type(screen.getByLabelText(/secret 1 value/i), "hunter2!");
      await user.click(screen.getByRole("button", { name: /start test/i }));
      await waitFor(() => expect(push).toHaveBeenCalled());
      expect(keyOf(fetch, 1)).toBe(keyOf(fetch, 0));
    });

    it("uses a new key once the request changes", async () => {
      const user = userEvent.setup();
      const fetch = mockFetch(json(503, { code: "QUEUE_UNAVAILABLE", message: "The run could not be queued; please retry" }), created());
      render(<NewTestForm />);
      await fillValid(user);
      await user.click(screen.getByRole("button", { name: /start test/i }));
      await screen.findByRole("alert");
      await user.type(screen.getByLabelText(/requirement/i), " And see it listed.");
      await user.click(screen.getByRole("button", { name: /start test/i }));
      await waitFor(() => expect(push).toHaveBeenCalled());
      expect(keyOf(fetch, 1)).not.toBe(keyOf(fetch, 0));
    });

    it("on IDEMPOTENCY_CONFLICT says a run may already exist, and the next attempt uses a new key", async () => {
      const user = userEvent.setup();
      const fetch = mockFetch(
        json(503, { code: "QUEUE_UNAVAILABLE", message: "The run could not be queued; please retry" }),
        json(409, { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency-Key was already used with a different request body" }),
        created(),
      );
      render(<NewTestForm />);
      await fillValid(user);
      await user.click(screen.getByRole("button", { name: /start test/i }));
      await screen.findByRole("alert");
      await user.click(screen.getByRole("button", { name: /start test/i }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/may already have started/i);
      await user.click(screen.getByRole("button", { name: /start test/i }));
      await waitFor(() => expect(push).toHaveBeenCalled());
      expect(keyOf(fetch, 1)).toBe(keyOf(fetch, 0));
      expect(keyOf(fetch, 2)).not.toBe(keyOf(fetch, 1));
    });
  });

  it("disables the submit button while the request is pending", async () => {
    const user = userEvent.setup();
    let resolve!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (resolve = r))));
    render(<NewTestForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /start test/i }));
    expect(screen.getByRole("button", { name: /starting/i })).toBeDisabled();
    resolve(json(202, { runId: "run_9", lifecycle: "QUEUED", eventsUrl: "/v1/test-runs/run_9/events" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/run_9"));
  });
});

describe("NewTestForm starting over from a run", () => {
  it("pre-fills the URL and the full requirement, and asks for test data and secrets again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).endsWith("/criteria") ? json(200, requirementFixture()) : json(200, summaryFixture({ lifecycle: "CANCELLED" })),
      ),
    );
    render(<NewTestForm from="run_1" />);
    expect(await screen.findByDisplayValue("https://shop.example.com/")).toBeInTheDocument();
    expect(screen.getByLabelText(/requirement/i)).toHaveValue(requirementFixture().originalText);
    expect(screen.getByText(/test data and secrets must be entered again/i)).toBeInTheDocument();
  });

  it("stays empty with a notice when the earlier run can't be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { code: "NOT_FOUND", message: "Not found" })));
    render(<NewTestForm from="run_missing" />);
    expect(await screen.findByText(/couldn't load the earlier run/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/website url/i)).toHaveValue("");
  });

  it("without `from` it loads nothing", () => {
    const fetch = mockFetch();
    render(<NewTestForm />);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("NewTestForm — destructive actions", () => {
  const openAdvanced = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByText("Advanced options"));
  const destructive = () => screen.getByLabelText(/allow destructive actions/i);
  const rerun = () => screen.getByLabelText(/rerun the generated test/i);
  const created = () => json(202, { runId: "run_9", lifecycle: "QUEUED", eventsUrl: "/v1/test-runs/run_9/events" });
  const fill = async (user: ReturnType<typeof userEvent.setup>, url: string) => {
    await user.type(screen.getByLabelText(/website url/i), url);
    await user.type(screen.getByLabelText(/requirement/i), "A user can delete a saved address.");
  };

  it("can be allowed in staging and in production, and the summary says so", async () => {
    const user = userEvent.setup();
    render(<NewTestForm />);
    expect(screen.getByText("Destructive actions are blocked unless you allow them under Advanced options.")).toBeInTheDocument();
    await openAdvanced(user);
    expect(destructive()).toBeEnabled();
    await user.click(screen.getByLabelText("Production"));
    expect(destructive()).toBeEnabled();
    await user.click(destructive());
    expect(screen.getByText("Advanced options").closest("summary")).toHaveTextContent("destructive allowed");
  });

  it("turns the rerun off when ticked, says why, warns when it is turned back on, and restores it when unticked", async () => {
    const user = userEvent.setup();
    render(<NewTestForm />);
    await openAdvanced(user);
    expect(rerun()).toBeChecked();
    await user.click(destructive());
    expect(rerun()).not.toBeChecked();
    expect(
      screen.getByText("Rerun is off: it repeats the whole test, so destructive actions would run a second time. You can turn it back on."),
    ).toBeInTheDocument();
    await user.click(rerun());
    expect(screen.getByText("Destructive actions will run twice: once while exploring and again in the rerun.")).toBeInTheDocument();
    await user.click(rerun());
    await user.click(destructive());
    expect(rerun()).toBeChecked(); // what it was before destructive actions were allowed
  });

  it("keeps the rerun off after unticking when it was off before", async () => {
    const user = userEvent.setup();
    render(<NewTestForm />);
    await openAdvanced(user);
    await user.click(rerun());
    await user.click(destructive());
    await user.click(destructive());
    expect(rerun()).not.toBeChecked();
  });

  it("in production asks for the website's host (lowercase, with its port) and sends it", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch(created());
    render(<NewTestForm />);
    await fill(user, "https://Shop.Example.com:8443/");
    await user.click(screen.getByLabelText("Production"));
    await openAdvanced(user);
    await user.click(destructive());
    expect(screen.getByText(/this run can create, change or delete real data/i)).toHaveTextContent(
      "This run can create, change or delete real data and place real orders or payments on shop.example.com:8443.",
    );
    await user.type(screen.getByLabelText("Type shop.example.com:8443 to confirm"), "SHOP.example.com:8443");
    await user.click(screen.getByRole("button", { name: /start test/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/run_9"));
    expect(bodyOf(fetch)).toMatchObject({
      environment: "production",
      options: { allowDestructiveActions: true, rerunGeneratedTest: false, confirmProductionHost: "SHOP.example.com:8443" },
    });
  });

  it.each([
    ["", "left empty"],
    ["shop.example.com", "without the port"],
  ])("in production refuses to start with the confirmation %j (%s), on the field, opening Advanced options", async (typed) => {
    const user = userEvent.setup();
    const fetch = mockFetch();
    render(<NewTestForm />);
    await fill(user, "https://shop.example.com:8443");
    await user.click(screen.getByLabelText("Production"));
    await openAdvanced(user);
    await user.click(destructive());
    if (typed) await user.type(screen.getByLabelText(/to confirm$/i), typed);
    await openAdvanced(user); // collapse it: the submit must open it again
    await user.click(screen.getByRole("button", { name: /start test/i }));
    const field = screen.getByLabelText(/to confirm$/i);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/Type shop\.example\.com:8443 exactly to confirm\./);
    expect(field).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses when the URL changed after the host was typed", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch();
    render(<NewTestForm />);
    await fill(user, "https://shop.example.com");
    await user.click(screen.getByLabelText("Production"));
    await openAdvanced(user);
    await user.click(destructive());
    await user.type(screen.getByLabelText(/to confirm$/i), "shop.example.com");
    await user.clear(screen.getByLabelText(/website url/i));
    await user.type(screen.getByLabelText(/website url/i), "https://other.example.com");
    await user.click(screen.getByRole("button", { name: /start test/i }));
    expect(screen.getByLabelText("Type other.example.com to confirm")).toHaveAccessibleDescription(/Type other\.example\.com exactly to confirm\./);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks for the URL first while it isn't valid", async () => {
    const user = userEvent.setup();
    render(<NewTestForm />);
    await user.click(screen.getByLabelText("Production"));
    await openAdvanced(user);
    await user.click(destructive());
    expect(screen.getByText("Enter the website URL first.")).toBeInTheDocument();
    expect(screen.queryByLabelText(/to confirm$/i)).not.toBeInTheDocument();
  });

  it("never sends the confirmation outside production (typed, then switched back to Staging)", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch(created());
    render(<NewTestForm />);
    await fill(user, "https://shop.example.com");
    await user.click(screen.getByLabelText("Production"));
    await openAdvanced(user);
    await user.click(destructive());
    await user.type(screen.getByLabelText(/to confirm$/i), "shop.example.com");
    await user.click(screen.getByLabelText("Staging"));
    await user.click(screen.getByRole("button", { name: /start test/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/run_9"));
    expect(bodyOf(fetch)).toMatchObject({ environment: "staging", options: { allowDestructiveActions: true } });
    expect(bodyOf(fetch).options).not.toHaveProperty("confirmProductionHost");
  });
});
