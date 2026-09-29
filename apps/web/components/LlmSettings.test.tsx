import type { LlmSettingsView } from "@platform/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json, llmSettingsFixture } from "../test/fixtures";
import { LlmSettings } from "./LlmSettings";

const SETTINGS = "/api/v1/settings/llm";

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

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body));
const card = (name: string) => screen.getByRole("form", { name });
const options = (select: HTMLElement) => within(select).getAllByRole("option").map((o) => o.textContent);

/** Anthropic's key saved in Settings (Gemini: none), as the API reports it. */
const anthropicSaved = (): LlmSettingsView =>
  llmSettingsFixture({
    providers: [
      { provider: "anthropic", label: "Anthropic", key: { source: "settings", updatedAt: new Date().toISOString() } },
      { provider: "gemini", label: "Google Gemini", key: { source: null, updatedAt: null } },
    ],
  });

describe("LlmSettings: AI providers", () => {
  it("shows each provider's key status (the server's, or none) and a write-only password field", async () => {
    routeFetch({ [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()) });
    render(<LlmSettings />);
    expect(await screen.findByRole("form", { name: "Anthropic" })).toHaveTextContent("Using the server's key (ANTHROPIC_API_KEY)");
    expect(card("Google Gemini")).toHaveTextContent("No key");
    expect(within(card("Anthropic")).queryByRole("button", { name: /remove saved key/i })).not.toBeInTheDocument();
    const field = within(card("Google Gemini")).getByLabelText(/api key/i);
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
  });

  it("saves a key: the field is cleared as soon as the request is sent, and the status follows the answer", async () => {
    const user = userEvent.setup();
    let answer!: (r: Response) => void;
    const saved = llmSettingsFixture({
      providers: [
        { provider: "anthropic", label: "Anthropic", key: { source: "environment", updatedAt: null } },
        { provider: "gemini", label: "Google Gemini", key: { source: "settings", updatedAt: new Date().toISOString() } },
      ],
    });
    const fetch = routeFetch({
      [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()),
      [`PUT ${SETTINGS}/keys/gemini`]: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    render(<LlmSettings />);
    const field = within(await screen.findByRole("form", { name: "Google Gemini" })).getByLabelText(/api key/i);
    await user.type(field, "AIza-Typed-Key-123");
    await user.click(within(card("Google Gemini")).getByRole("button", { name: "Save key" }));

    expect(field).toHaveValue(""); // while the request is still pending
    answer(json(200, saved));
    await waitFor(() => expect(card("Google Gemini")).toHaveTextContent(/Key saved · updated Today/));
    expect(within(card("Google Gemini")).getByRole("status")).toHaveTextContent("Key saved.");
    const put = fetch.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(bodyOf(put[1])).toEqual({ apiKey: "AIza-Typed-Key-123" });
    expect(document.body.innerHTML).not.toContain("AIza-Typed-Key-123");
  });

  it("a rejected key shows the server's message on the field, which stays cleared", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()),
      [`PUT ${SETTINGS}/keys/anthropic`]: () =>
        json(400, {
          code: "VALIDATION_FAILED",
          message: "Request validation failed",
          issues: [{ path: ["apiKey"], message: "An API key is one line of printable ASCII characters without spaces" }],
        }),
    });
    render(<LlmSettings />);
    const field = within(await screen.findByRole("form", { name: "Anthropic" })).getByLabelText(/api key/i);
    await user.type(field, "sk ant spaced");
    await user.click(within(card("Anthropic")).getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(field).toHaveAccessibleDescription(/printable ASCII characters without spaces/);
    expect(field).toHaveValue("");
  });

  it("a request that never reaches the server still clears the field, and says so on it", async () => {
    const user = userEvent.setup();
    routeFetch({
      [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()),
      [`PUT ${SETTINGS}/keys/gemini`]: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    render(<LlmSettings />);
    const field = within(await screen.findByRole("form", { name: "Google Gemini" })).getByLabelText(/api key/i);
    await user.type(field, "AIza-Lost-Key");
    await user.click(within(card("Google Gemini")).getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(field).toHaveAccessibleDescription(/could not reach the server/i));
    expect(field).toHaveValue("");
  });

  it("an empty field is not sent", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({ [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()) });
    render(<LlmSettings />);
    await user.click(within(await screen.findByRole("form", { name: "Anthropic" })).getByRole("button", { name: "Save key" }));
    expect(within(card("Anthropic")).getByLabelText(/api key/i)).toHaveAccessibleDescription("Enter the API key.");
    expect(fetch).toHaveBeenCalledTimes(1); // the GET only
  });

  it("removes a saved key after an inline confirmation", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({
      [`GET ${SETTINGS}`]: () => json(200, anthropicSaved()),
      [`PUT ${SETTINGS}/keys/anthropic`]: () => json(200, llmSettingsFixture()),
    });
    render(<LlmSettings />);
    const anthropic = await screen.findByRole("form", { name: "Anthropic" });
    expect(anthropic).toHaveTextContent(/Key saved · updated/);

    await user.click(within(anthropic).getByRole("button", { name: "Remove saved key" }));
    await user.click(within(anthropic).getByRole("button", { name: "Keep key" }));
    expect(fetch).toHaveBeenCalledTimes(1);

    await user.click(within(anthropic).getByRole("button", { name: "Remove saved key" }));
    const confirm = within(anthropic).getByRole("group", { name: "Remove the saved Anthropic key?" });
    await user.click(within(confirm).getByRole("button", { name: "Yes, remove key" }));

    await waitFor(() => expect(card("Anthropic")).toHaveTextContent("Using the server's key (ANTHROPIC_API_KEY)"));
    expect(bodyOf(fetch.mock.calls[1]![1])).toEqual({ apiKey: null });
    expect(within(card("Anthropic")).getByRole("status")).toHaveTextContent("Saved key removed.");
  });
});

describe("LlmSettings: defaults for new tests", () => {
  it("groups the models by provider; a provider without a key disables its models, labelled 'add a key'", async () => {
    routeFetch({ [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()) });
    render(<LlmSettings />);
    const model = await screen.findByLabelText("Model");
    expect(model).toHaveValue("claude-sonnet-5");
    expect(within(model).getAllByRole("group").map((g) => g.getAttribute("label"))).toEqual(["Anthropic", "Google Gemini", "Development"]);
    expect(within(model).getByRole("option", { name: "Gemini 3.8 Flash — add a key" })).toBeDisabled();
    expect(within(model).getByRole("option", { name: "Claude Opus 5.5" })).toBeEnabled();
  });

  it("the reasoning options follow the model, the first reading 'Model default (<level>)'; a level the new model lacks falls back to it", async () => {
    const user = userEvent.setup();
    routeFetch({ [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()) });
    render(<LlmSettings />);
    const reasoning = await screen.findByLabelText("Reasoning");
    expect(options(reasoning)).toEqual(["Model default (high)", "Low", "Medium", "High"]);
    await user.selectOptions(reasoning, "high");
    await user.selectOptions(screen.getByLabelText("Model"), "claude-haiku-4-5");
    expect(options(reasoning)).toEqual(["Model default (no reasoning)"]);
    expect(reasoning).toHaveValue("default");
  });

  it("shows the selected model's price per million tokens", async () => {
    const user = userEvent.setup();
    routeFetch({ [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()) });
    render(<LlmSettings />);
    const model = await screen.findByLabelText("Model");
    expect(model).toHaveAccessibleDescription("$2.00 input · $10.00 output per million tokens");
    await user.selectOptions(model, "claude-opus-5-5");
    expect(model).toHaveAccessibleDescription("$4.00 input · $20.00 output per million tokens");
  });

  it("saves the defaults; a 422 lands on the field it names", async () => {
    const user = userEvent.setup();
    let puts = 0;
    const saved = llmSettingsFixture({
      defaults: { provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5", reasoning: "medium", source: "settings", available: true },
    });
    const fetch = routeFetch({
      [`GET ${SETTINGS}`]: () => json(200, llmSettingsFixture()),
      [`PUT ${SETTINGS}`]: () =>
        puts++ === 0
          ? json(422, {
              code: "MODEL_NOT_AVAILABLE",
              message: "Claude Opus 5.5 takes the reasoning levels default, low, medium, high, not medium",
              issues: [{ path: ["defaults", "reasoning"], message: "Claude Opus 5.5 takes the reasoning levels default, low, medium, high, not medium" }],
            })
          : json(200, saved),
    });
    render(<LlmSettings />);
    expect(await screen.findByText(/come from the server's environment/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Model"), "claude-opus-5-5");
    await user.selectOptions(screen.getByLabelText("Reasoning"), "medium");
    await user.click(screen.getByRole("button", { name: "Save defaults" }));

    await waitFor(() => expect(screen.getByLabelText("Reasoning")).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByLabelText("Reasoning")).toHaveAccessibleDescription(/not medium/);
    expect(bodyOf(fetch.mock.calls[1]![1])).toEqual({ defaults: { model: "claude-opus-5-5", reasoning: "medium" } });

    await user.click(screen.getByRole("button", { name: "Save defaults" }));
    expect(await screen.findByText(/Defaults saved/)).toBeInTheDocument();
    expect(screen.queryByText(/come from the server's environment/)).not.toBeInTheDocument();
  });

  it("warns that new tests will be refused when the defaults are unavailable (their key was removed)", async () => {
    routeFetch({
      [`GET ${SETTINGS}`]: () =>
        json(
          200,
          llmSettingsFixture({
            defaults: { provider: "gemini", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoning: "low", source: "settings", available: false },
          }),
        ),
    });
    render(<LlmSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/New tests will be refused.*Gemini 3\.8 Flash/);
    expect(screen.queryByText(/come from the server's environment/)).not.toBeInTheDocument();
  });

  it("an environment model outside the catalog is not preselected: the user chooses one before saving", async () => {
    const user = userEvent.setup();
    const fetch = routeFetch({
      [`GET ${SETTINGS}`]: () =>
        json(
          200,
          llmSettingsFixture({
            defaults: { provider: "anthropic", model: "claude-opus-5", label: "claude-opus-5", reasoning: "default", source: "environment", available: true },
          }),
        ),
    });
    render(<LlmSettings />);
    const model = await screen.findByLabelText("Model");
    expect(model).toHaveValue("");
    expect(model).toHaveAccessibleDescription(/claude-opus-5\) is not offered here/);
    expect(screen.getByLabelText("Reasoning")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save defaults" }));
    expect(model).toHaveAccessibleDescription(/Choose a model\./);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a failed load says so, and Try again loads it", async () => {
    const user = userEvent.setup();
    let gets = 0;
    routeFetch({ [`GET ${SETTINGS}`]: () => (gets++ === 0 ? json(500, { code: "INTERNAL", message: "Internal server error" }) : json(200, llmSettingsFixture())) });
    render(<LlmSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Settings couldn't be loaded");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Model")).toBeInTheDocument();
  });
});
