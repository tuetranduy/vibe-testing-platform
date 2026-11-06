import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { RerunPanel } from "./RerunPanel";
const response = () => json(202, { runId: "run_2", lifecycle: "QUEUED", eventsUrl: "/events" });
describe("simple reruns", () => {
  it("replays a saved test without collecting data", async () => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal("fetch", fetch);
    const navigate = vi.fn(); render(<RerunPanel runId="run_1" secretNames={[]} compiledCount={2} navigate={navigate} />);
    await userEvent.click(screen.getByRole("button", { name: "Rerun saved test" }));
    expect(fetch).toHaveBeenCalledWith("/api/v1/test-runs/run_1/rerun", expect.objectContaining({ body: "{}", method: "POST" }));
    expect(navigate).toHaveBeenCalledWith("/runs/run_2");
  });
  it("directs an old test to fresh setup without exposing credential controls", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<RerunPanel runId="run_1" secretNames={["password"]} compiledCount={2} />);
    expect(screen.getByRole("link", { name: "Create a fresh test" })).toHaveAttribute("href", "/runs/new?from=run_1");
    expect(screen.queryByLabelText("password")).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
  });
  it("requires confirmation for actions that change site data", async () => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal("fetch", fetch);
    render(<RerunPanel runId="run_1" secretNames={[]} compiledCount={2} destructive navigate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Rerun saved test" }));
    await userEvent.click(screen.getByRole("button", { name: "Start rerun" })); expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Start rerun" }));
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: '{"confirmDestructiveActions":true}' }));
  });
});
