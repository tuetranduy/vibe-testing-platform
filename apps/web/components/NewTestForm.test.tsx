import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
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
    expect(value).toHaveAttribute("autocomplete", "off");
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
    await user.click(screen.getByText(/advanced options/i));
    await user.click(screen.getByLabelText(/confirm criteria automatically/i));
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /start test/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(bodyOf(fetch).options.autoConfirmCriteria).toBe(true);
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
