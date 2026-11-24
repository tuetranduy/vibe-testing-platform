import { CreateTestRunRequestSchema, destructiveActionsAllowed } from "@platform/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDiscoveryCapability, getLlmSettings } from "../lib/api";
import { json, llmSettingsFixture, requirementFixture, summaryFixture } from "../test/fixtures";
import { NewTestForm } from "./NewTestForm";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../lib/api", async (original) => ({ ...(await original<typeof import("../lib/api")>()), getLlmSettings: vi.fn(), getDiscoveryCapability: vi.fn() }));
beforeEach(() => {
  push.mockReset();
  vi.mocked(getLlmSettings).mockResolvedValue(llmSettingsFixture());
  vi.mocked(getDiscoveryCapability).mockResolvedValue({ fixtureUrl: null });
});
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
    expect(screen.getByRole("button", { name: /Run settings/ })).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(getLlmSettings).toHaveBeenCalled());
    expect(fetch).not.toHaveBeenCalled();
  });
  it("creates a test with destructive actions already authorized and no manual input fields", async () => {
    const fetch = api(); render(<NewTestForm />);
    const user = await fill(); await user.click(create());
    expect(payload(fetch)).toMatchObject({ targetUrl: "https://shop.example.com", requirement: "Search for a product and verify the results.", environment: "production", options: { allowDestructiveActions: true, confirmProductionHost: "shop.example.com", maxRunSeconds: 600, maxExplorationSteps: 40 } });
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
    expect(destructiveActionsAllowed(CreateTestRunRequestSchema.parse(payload(fetch)))).toBe(true);
  });
  it("offers Browser Use on any public HTTPS site without asking for proof of ownership", async () => {
    vi.mocked(getDiscoveryCapability).mockResolvedValue({ fixtureUrl: null, verifiedSites: true });
    const fetch = api();
    render(<NewTestForm />);
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Find test ideas" }));
    await user.click(await screen.findByRole("checkbox", { name: /Autonomous Discovery/ }));
    expect(screen.queryByText(/TXT record/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Explore website" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(payload(fetch)).toMatchObject({ targetUrl: "https://shop.example.com", environment: "production", requirement: "",
      options: { autonomousDiscovery: true, verifiedSiteDiscovery: true, allowDestructiveActions: false,
        autoConfirmCriteria: false, additionalAllowedHosts: [] } });
    expect(push).toHaveBeenCalledWith("/runs/run_new");
  });
  it("lets Browser Use interact with a live site by default where the deployment offers it", async () => {
    vi.mocked(getDiscoveryCapability).mockResolvedValue({ fixtureUrl: null, verifiedSites: true, liveInteraction: true });
    const fetch = api();
    render(<NewTestForm />);
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Find test ideas" }));
    await user.click(await screen.findByRole("checkbox", { name: /Autonomous Discovery/ }));
    const interact = screen.getByRole("checkbox", { name: "Interact with the live site" });
    expect(interact).toBeChecked();
    expect(screen.getByText(/can submit forms with test data/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Explore website" }));
    expect(payload(fetch)).toMatchObject({ options: { verifiedSiteDiscovery: true, discoveryLiveInteraction: true } });
    expect(CreateTestRunRequestSchema.safeParse(payload(fetch)).success).toBe(true);
  });
  it("uses snapshots when the reviewer turns live interaction off", async () => {
    vi.mocked(getDiscoveryCapability).mockResolvedValue({ fixtureUrl: null, verifiedSites: true, liveInteraction: true });
    const fetch = api();
    render(<NewTestForm />);
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Find test ideas" }));
    await user.click(await screen.findByRole("checkbox", { name: /Autonomous Discovery/ }));
    await user.click(screen.getByRole("checkbox", { name: "Interact with the live site" }));
    await user.click(screen.getByRole("button", { name: "Explore website" }));
    expect(payload(fetch).options).not.toHaveProperty("discoveryLiveInteraction");
  });
  it("does not offer Browser Use on a live site when the deployment has it off", async () => {
    vi.mocked(getDiscoveryCapability).mockResolvedValue({ fixtureUrl: null });
    api();
    render(<NewTestForm />);
    const user = await fill();
    await user.click(screen.getByRole("button", { name: "Find test ideas" }));
    await waitFor(() => expect(getDiscoveryCapability).toHaveBeenCalled());
    expect(screen.queryByRole("checkbox", { name: /Autonomous Discovery/ })).not.toBeInTheDocument();
  });
  it("opts an approved fixture into Browser Use with manual review and bounded discovery settings", async () => {
    const targetUrl = "http://127.0.0.1:4599/";
    vi.mocked(getDiscoveryCapability).mockResolvedValue({ fixtureUrl: targetUrl });
    const fetch = api();
    render(<NewTestForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Which website/), targetUrl);
    await user.click(screen.getByRole("button", { name: "Find test ideas" }));
    const toggle = await screen.findByRole("checkbox", { name: /Autonomous Discovery/ });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    fireEvent.change(screen.getByLabelText("Discovery time (seconds)"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("Browser Use agents"), { target: { value: "2" } });
    await user.click(screen.getByRole("button", { name: "Explore website" }));
    expect(payload(fetch)).toMatchObject({
      targetUrl, requirement: "", environment: "staging",
      options: { autonomousDiscovery: true, discoveryMaxSeconds: 60, discoveryMaxSteps: 20, discoveryAgents: 2, autoConfirmCriteria: false, allowDestructiveActions: false },
    });
  });
  it("opts written instructions into Browser Use route discovery with manual review (Phase B)", async () => {
    const targetUrl = "http://127.0.0.1:4599/";
    vi.mocked(getDiscoveryCapability).mockResolvedValue({ fixtureUrl: targetUrl });
    const fetch = api();
    render(<NewTestForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Which website/), targetUrl);
    await user.type(screen.getByLabelText("Test instructions"), "Add a product to the cart and check the total.");
    const toggle = await screen.findByRole("checkbox", { name: /Autonomous Discovery/ });
    expect(screen.getByText(/do not decide the result until you mark them critical/)).toBeInTheDocument();
    await user.click(toggle);
    await user.click(create());
    expect(payload(fetch)).toMatchObject({
      targetUrl, requirement: "Add a product to the cart and check the total.", environment: "staging",
      options: { autonomousDiscovery: true, autoConfirmCriteria: false, allowDestructiveActions: false },
    });
    expect(CreateTestRunRequestSchema.safeParse(payload(fetch)).success).toBe(true);
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
    expect(screen.getByRole("button", { name: /Run settings/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Step limit")).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("authorizes the current production host without permission or confirmation controls", async () => {
    const fetch = api(); render(<NewTestForm />);
    const user = await fill();
    await user.click(screen.getByText(/Run settings/));
    expect(screen.queryByLabelText("Allow actions that change or delete site data")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Type .* to confirm/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Which website/), { target: { value: "https://STORE.example.com:8443/cart" } });
    await user.click(create());
    const request = CreateTestRunRequestSchema.parse(payload(fetch));
    expect(request.options).toMatchObject({ allowDestructiveActions: true, confirmProductionHost: "store.example.com:8443", rerunGeneratedTest: true });
    expect(destructiveActionsAllowed(request)).toBe(true);
    expect(push).toHaveBeenCalledWith("/runs/run_new");
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
