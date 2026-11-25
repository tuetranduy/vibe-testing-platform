import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistancePanel } from "./AssistancePanel";
import { json } from "../test/fixtures";
const request = { requestId: "req1", scenarioId: "SC-1", stepId: "PS-2", question: "PS-2 Checkout failed: missing control. What next?", url: "https://shop.test/cart", screenshotArtifactId: "art1", expiresAt: new Date(Date.now() + 600000).toISOString() };
describe("AssistancePanel (2026-11-21)", () => {
  it("shows the current screenshot and failure, then submits the instruction", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/url") ? json(200, { url: "https://s3.test/stuck.png", expiresAt: request.expiresAt }) : json(202, { accepted: true }));
    vi.stubGlobal("fetch", fetch);
    render(<AssistancePanel runId="run1" request={request} />);
    expect(await screen.findByRole("img")).toHaveAttribute("src", "https://s3.test/stuck.png");
    expect(screen.getByText(request.question)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with this instruction" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Accept the terms" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue with this instruction" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(String(fetch.mock.calls[1]![0])).toBe("/api/v1/test-runs/run1/assistance/req1");
    expect(await screen.findByText(/Answer received/)).toBeInTheDocument();
  });
  it("can stop without entering an instruction", async () => {
    const fetch = vi.fn(async () => json(202, { accepted: true }));
    vi.stubGlobal("fetch", fetch);
    render(<AssistancePanel runId="run1" request={request} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop here" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop here" })).toBeDisabled());
  });
});
