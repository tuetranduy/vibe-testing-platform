import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLlmSettings } from "../lib/api";
import { json, llmSettingsFixture, requirementFixture, summaryFixture } from "../test/fixtures";
import { NewTestForm } from "./NewTestForm";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../lib/api", async (original) => ({ ...(await original<typeof import("../lib/api")>()), getLlmSettings: vi.fn() }));
beforeEach(() => { push.mockReset(); vi.mocked(getLlmSettings).mockResolvedValue(llmSettingsFixture()); });
const created = () => json(202, { runId: "run_new", lifecycle: "QUEUED", eventsUrl: "/events" });
function api(...answers: (Response | Error)[]) {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const answer = answers.shift() ?? created();
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const payload = (fetch: ReturnType<typeof api>, index = 0) => JSON.parse(String(fetch.mock.calls[index]?.[1]?.body));
async function fill() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/Which website/), "https://shop.example.com");
  await user.type(screen.getByLabelText("Test instructions"), "Search for a product and verify the results.");
  return user;
}
const create = () => screen.getByRole("button", { name: "Create test" });

describe("simple test setup", () => {
  it("shows two inputs and no environment, secret or data setup", async () => {
    const fetch = api();
    render(<NewTestForm />);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Secrets$|^Test data$|^Environment$|Saved credentials/)).not.toBeInTheDocument();
    expect(screen.getByText(/Run settings/).closest("details")).not.toHaveAttribute("open");
    await waitFor(() => expect(getLlmSettings).toHaveBeenCalled());
    expect(fetch).not.toHaveBeenCalled();
  });
  it("creates a test using the stricter internal action policy and no manual input fields", async () => {
    const fetch = api(); render(<NewTestForm />);
    const user = await fill(); await user.click(create());
    expect(payload(fetch)).toMatchObject({ targetUrl: "https://shop.example.com", requirement: "Search for a product and verify the results.", environment: "production", options: { allowDestructiveActions: false, maxRunSeconds: 300, maxExplorationSteps: 40 } });
    for (const field of ["testData", "secrets", "testDataSetId", "credentialProfileId"]) expect(payload(fetch)).not.toHaveProperty(field);
    expect(push).toHaveBeenCalledWith("/runs/run_new");
  });
  it("validates the URL and moves focus to the first error", async () => {
    const fetch = api(); render(<NewTestForm />);
    await userEvent.click(create());
    expect(screen.getByLabelText(/Which website/)).toHaveFocus();
    expect(screen.getByLabelText(/Which website/)).toHaveAttribute("aria-invalid", "true");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires instructions when describing a test", async () => {
    const fetch = api(); render(<NewTestForm />);
    await userEvent.type(screen.getByLabelText(/Which website/), "https://shop.example.com");
    await userEvent.click(create());
    expect(screen.getByLabelText("Test instructions")).toHaveAccessibleDescription(/at least 10 characters/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("explicitly explores with an empty requirement and preserves a draft when switching back", async () => {
    const fetch = api(); render(<NewTestForm />);
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Find test ideas" }));
    expect(screen.queryByLabelText("Test instructions")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Describe a test" }));
    expect(screen.getByLabelText("Test instructions")).toHaveValue("Search for a product and verify the results.");
    await user.click(screen.getByRole("button", { name: "Find test ideas" }));
    await user.click(screen.getByRole("button", { name: "Explore website" }));
    expect(payload(fetch).requirement).toBe("");
  });
  it("fills and focuses instructions from an example", async () => {
    api(); render(<NewTestForm />);
    await userEvent.click(screen.getByRole("button", { name: "Shopping cart" }));
    expect(screen.getByLabelText("Test instructions")).toHaveFocus();
    expect((screen.getByLabelText("Test instructions") as HTMLTextAreaElement).value).toContain("cart");
  });
  it("reuses the idempotency key after a lost response, and changes it after editing", async () => {
    const fetch = api(new Error("lost"), new Error("lost"), new Error("lost")); render(<NewTestForm />);
    const user = await fill();
    await user.click(create()); await screen.findByRole("alert");
    await user.click(create()); await screen.findByRole("alert");
    await user.type(screen.getByLabelText("Test instructions"), " Check the heading too.");
    await user.click(create());
    const keys = fetch.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)["idempotency-key"]);
    expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[1]);
  });
  it("opens settings with an invalid limit and blocks submission", async () => {
    const fetch = api(); render(<NewTestForm />);
    const user = await fill();
    fireEvent.change(screen.getByLabelText("Step limit"), { target: { value: "101" } });
    await user.click(create());
    expect(screen.getByText(/Run settings/).closest("details")).toHaveAttribute("open");
    expect(screen.getByLabelText("Step limit")).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("validates host confirmation when actions change site data", async () => {
    const fetch = api(); render(<NewTestForm />);
    const user = await fill();
    await user.click(screen.getByText(/Run settings/));
    await user.click(screen.getByLabelText("Allow actions that change or delete site data"));
    await user.click(create()); expect(fetch).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/Type shop.example.com to confirm/), "shop.example.com");
    await user.click(create());
    expect(payload(fetch).options).toMatchObject({ allowDestructiveActions: true, confirmProductionHost: "shop.example.com", rerunGeneratedTest: false });
  });
  it("lets the user override a model and resets thinking when the model changes", async () => {
    const fetch = api(); render(<NewTestForm />); const user = await fill();
    await waitFor(() => expect(screen.getByLabelText("AI model")).toBeEnabled());
    await user.click(screen.getByText(/Run settings/));
    await user.selectOptions(screen.getByLabelText("Thinking level"), "high");
    await user.selectOptions(screen.getByLabelText("AI model"), "claude-haiku-4-5");
    expect(screen.getByLabelText("Thinking level")).toHaveValue("");
    await user.click(create()); expect(payload(fetch).llm).toEqual({ model: "claude-haiku-4-5" });
  });
  it("shows target policy refusals on the website field", async () => {
    api(json(422, { code: "TARGET_NOT_ALLOWED", message: "Target blocked" })); render(<NewTestForm />);
    const user = await fill(); await user.click(create());
    expect(await screen.findByText("Target blocked")).toBeInTheDocument();
    expect(screen.getByLabelText(/Which website/)).toHaveFocus();
  });
  it("links unavailable model errors to settings", async () => {
    api(json(422, { code: "MODEL_NOT_AVAILABLE", message: "Choose an available model" })); render(<NewTestForm />);
    const user = await fill(); await user.click(create());
    expect(await screen.findByRole("link", { name: /Choose an available model in Settings/ })).toHaveAttribute("href", "/settings");
  });
  it("copies only the website and instructions from an older test", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/criteria") ? json(200, requirementFixture()) : json(200, summaryFixture()));
    vi.stubGlobal("fetch", fetch);
    render(<NewTestForm from="run_1" />);
    expect(await screen.findByText(/Website and instructions copied/)).toBeInTheDocument();
    expect(screen.getByLabelText("Test instructions")).toHaveValue(requirementFixture().originalText);
    expect(fetch.mock.calls).toHaveLength(2);
    expect(screen.queryByText(/Secrets|Test data/)).not.toBeInTheDocument();
  });
});
