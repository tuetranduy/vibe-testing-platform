import type { ApiTokenView } from "@platform/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { ApiTokens } from "./ApiTokens";

const token = (patch: Partial<ApiTokenView> = {}): ApiTokenView => ({
  id: "tok_1",
  name: "Deploy pipeline",
  prefix: "AbCdEfGh",
  scopes: ["suites:run", "results:read"],
  user: { id: "usr_1", name: "Ann" },
  expiresAt: "2099-01-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-09-30T10:00:00.000Z",
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

describe("ApiTokens (V1.2 F4)", () => {
  it("creates a token, shows it once, and revokes one", async () => {
    const secret = `tap_${"z".repeat(43)}`;
    const fetch = api({
      "GET /api/v1/api-tokens": () => json(200, { items: [token()] }),
      "POST /api/v1/api-tokens": (init) => json(201, { ...token({ id: "tok_2", ...JSON.parse(String(init!.body)), expiresAt: null }), token: secret }),
      "DELETE /api/v1/api-tokens/tok_1": () => json(200, token({ revokedAt: "2026-09-30T11:00:00.000Z" })),
    });
    const user = userEvent.setup();
    render(<ApiTokens />);
    const list = await screen.findByRole("list", { name: "Tokens" });
    expect(within(list).getByText("tap_AbCdEfGh…")).toBeInTheDocument();
    expect(within(list).getByText(/never used/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "Nightly");
    await user.click(screen.getByLabelText("Read results"));
    await user.selectOptions(screen.getByLabelText("Expires after"), "never");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/api-tokens",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Nightly", scopes: ["suites:run"], expiresInDays: null }) }),
    );
    expect(await screen.findByText(secret)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: "Revoke “Deploy pipeline”" }));
    expect(await within(list).findByText(/Revoked/)).toBeInTheDocument();
  });

  it("an administrator's view lists everyone's tokens without a create form", async () => {
    api({ "GET /api/v1/api-tokens?user=all": () => json(200, { items: [token(), token({ id: "tok_b", name: "Bob's", user: { id: "usr_b", name: "Bob" } })] }) });
    render(<ApiTokens all />);
    expect(await screen.findByRole("heading", { name: "Everyone's tokens" })).toBeInTheDocument();
    expect(screen.getByText(/· Bob/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create token" })).not.toBeInTheDocument();
  });

  it("asks for a name and a permission", async () => {
    const fetch = api({ "GET /api/v1/api-tokens": () => json(200, { items: [] }) });
    const user = userEvent.setup();
    render(<ApiTokens />);
    await user.click(await screen.findByRole("button", { name: "Create token" }));
    expect(screen.getByText(/Enter a name/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name"), "x");
    await user.click(screen.getByLabelText("Run suites"));
    await user.click(screen.getByLabelText("Read results"));
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(screen.getByText("Choose at least one permission.")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
