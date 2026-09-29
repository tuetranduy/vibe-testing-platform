import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { testMe, userFixture } from "../test/me";
import { UserAdmin } from "./UserAdmin";

const admin = userFixture({ id: "usr_admin", name: "Ada", email: "ada@example.com", role: "admin" });
const member = userFixture({ id: "usr_m", name: "Mo", email: "mo@example.com", role: "member" });

function api(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("UserAdmin", () => {
  it("lists users and marks the signed-in one", async () => {
    testMe.current = admin;
    api({ "GET /api/v1/users": () => json(200, { items: [admin, member] }) });
    render(<UserAdmin />);
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Ada (you)");
    expect(rows[1]).toHaveTextContent("mo@example.com");
    expect(screen.getByRole("heading", { name: "People (2)" })).toBeInTheDocument();
  });

  it("changes a role and disables a user", async () => {
    const fetch = api({
      "GET /api/v1/users": () => json(200, { items: [admin, member] }),
      "PATCH /api/v1/users/usr_m": (init) => json(200, { ...member, ...JSON.parse(String(init!.body)) }),
    });
    render(<UserAdmin />);
    await userEvent.selectOptions(await screen.findByLabelText("Role of Mo"), "admin");
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/users/usr_m", expect.objectContaining({ method: "PATCH", body: '{"role":"admin"}' }));
    const row = screen.getByText("mo@example.com").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Disable" }));
    expect(fetch).toHaveBeenLastCalledWith("/api/v1/users/usr_m", expect.objectContaining({ body: '{"disabled":true}' }));
  });

  it("shows the API's refusal to demote the last admin", async () => {
    api({
      "GET /api/v1/users": () => json(200, { items: [admin] }),
      "PATCH /api/v1/users/usr_admin": () => json(409, { code: "LAST_ADMIN", message: "Keep at least one enabled administrator" }),
    });
    render(<UserAdmin />);
    await userEvent.selectOptions(await screen.findByLabelText("Role of Ada"), "member");
    expect(await screen.findByRole("alert")).toHaveTextContent("Keep at least one enabled administrator");
  });

  it("adds a person, checking the fields first", async () => {
    const fetch = api({
      "GET /api/v1/users": () => json(200, { items: [admin] }),
      "POST /api/v1/users": (init) => json(201, { ...member, id: "usr_new", ...JSON.parse(String(init!.body)), password: undefined }),
    });
    render(<UserAdmin />);
    await userEvent.click(await screen.findByRole("button", { name: "Add person" }));
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    await userEvent.type(screen.getByLabelText("Name"), "Nia");
    await userEvent.type(screen.getByLabelText("E-mail address"), "nia@example.com");
    await userEvent.type(screen.getByLabelText("First password"), "first password");
    await userEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/users",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Nia", email: "nia@example.com", password: "first password", role: "member" }),
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Nia can now sign in with nia@example.com");
    expect(screen.getByRole("heading", { name: "People (2)" })).toBeInTheDocument();
  });
});
