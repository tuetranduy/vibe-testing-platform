import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { testMe, userFixture } from "../test/me";
import { DiscoveryRolloutCard } from "./DiscoveryRolloutCard";

it("lets an enrolled tenant administrator disable discovery in one action", async () => {
  testMe.current = userFixture({ role: "admin" });
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    json(200, { available: true, enabled: init?.method !== "PUT" }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<DiscoveryRolloutCard />);
  await userEvent.click(await screen.findByRole("button", { name: "Disable Browser Use" }));
  expect(fetch).toHaveBeenLastCalledWith("/api/v1/settings/discovery", expect.objectContaining({
    method: "PUT", body: JSON.stringify({ enabled: false }),
  }));
  expect(await screen.findByRole("button", { name: "Enable Browser Use" })).toBeInTheDocument();
});
