import type { CredentialProfile } from "@platform/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { testMe, userFixture } from "../test/me";
import { CredentialProfiles } from "./CredentialProfiles";

const profile = (patch: Partial<CredentialProfile> = {}): CredentialProfile => ({
  id: "cp_1",
  name: "Staging admin",
  description: "QA admin",
  secretNames: ["password", "username"],
  createdBy: { id: "usr_1", name: "Ada" },
  createdAt: "2026-09-29T10:00:00.000Z",
  updatedAt: "2026-09-29T10:00:00.000Z",
  ...patch,
});

function api(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    if (!routes[key]) throw new Error(`unexpected ${key}`);
    return routes[key]!(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("CredentialProfiles", () => {
  it("shows members the names a profile provides, never a value, and no way to change it", async () => {
    testMe.current = userFixture({ role: "member" });
    api({ "GET /api/v1/credential-profiles": () => json(200, { items: [profile()] }) });
    render(<CredentialProfiles />);
    const card = await screen.findByRole("article", { name: "Staging admin" });
    expect(
      within(within(card).getByRole("list", { name: "Secrets it provides" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent?.trim()),
    ).toEqual(["password", "username"]);
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New saved credentials" })).not.toBeInTheDocument();
    expect(screen.getByText(/Only administrators can add or change saved credentials/)).toBeInTheDocument();
  });

  it("lets an admin create a profile, clearing the values from the page once sent", async () => {
    testMe.current = userFixture({ role: "admin" });
    const fetch = api({
      "GET /api/v1/credential-profiles": () => json(200, { items: [] }),
      "POST /api/v1/credential-profiles": () => json(201, profile({ id: "cp_new", name: "Buyer", description: "" })),
    });
    const user = userEvent.setup();
    render(<CredentialProfiles />);
    await user.click(await screen.findByRole("button", { name: "New saved credentials" }));
    await user.type(screen.getByLabelText("Name"), "Buyer");
    await user.type(screen.getByLabelText("Secret 1 value"), "buyer-user");
    await user.type(screen.getByLabelText("Secret 2 value"), "abc");
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    expect(screen.getByText("Enter at least 4 characters.")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText("Secret 2 value"), "defg");
    await user.click(screen.getByRole("button", { name: "Save credentials" }));
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/credential-profiles",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Buyer", description: "", secrets: { username: "buyer-user", password: "abcdefg" } }),
      }),
    );
    expect(await screen.findByRole("article", { name: "Buyer" })).toBeInTheDocument();
  });

  it("edits: an empty value keeps the saved one, a typed value replaces it, Remove deletes it", async () => {
    testMe.current = userFixture({ role: "admin" });
    const fetch = api({
      "GET /api/v1/credential-profiles": () => json(200, { items: [profile()] }),
      "PUT /api/v1/credential-profiles/cp_1": () => json(200, profile({ secretNames: ["password"] })),
    });
    const user = userEvent.setup();
    render(<CredentialProfiles />);
    await user.click(await screen.findByRole("button", { name: "Edit Staging admin" }));
    expect(screen.getByLabelText("Secret 1 name")).toHaveValue("password");
    expect(screen.getByLabelText("Secret 1 value")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Remove secret 2" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/credential-profiles/cp_1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ name: "Staging admin", description: "QA admin", secrets: { username: null } }),
      }),
    );
  });

  it("asks before an admin deletes a profile", async () => {
    testMe.current = userFixture({ role: "admin" });
    const fetch = api({
      "GET /api/v1/credential-profiles": () => json(200, { items: [profile()] }),
      "DELETE /api/v1/credential-profiles/cp_1": () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    render(<CredentialProfiles />);
    await user.click(await screen.findByRole("button", { name: "Delete Staging admin" }));
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/credential-profiles/cp_1", expect.objectContaining({ method: "DELETE" }));
    expect(await screen.findByText("No saved credentials yet")).toBeInTheDocument();
  });
});
