import type { SessionInfo } from "@platform/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { AccountSessions, describeAgent } from "./AccountSessions";

const MAC_FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const WINDOWS_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0";

const session = (patch: Partial<SessionInfo>): SessionInfo => ({
  id: "ses_1",
  createdAt: "2026-09-30T08:00:00.000Z",
  lastSeenAt: "2026-09-30T09:00:00.000Z",
  expiresAt: "2026-10-07T08:00:00.000Z",
  userAgent: MAC_FIREFOX,
  current: false,
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

describe("describeAgent", () => {
  it.each([
    [MAC_FIREFOX, "Firefox on macOS"],
    [IPHONE_SAFARI, "Safari on iOS"],
    [WINDOWS_EDGE, "Edge on Windows"],
    ["curl/8.7.1", "curl/8.7.1"],
    [null, "Unknown browser"],
  ])("%s → %s", (ua, label) => expect(describeAgent(ua)).toBe(label));
});

describe("AccountSessions (KI-034)", () => {
  it("lists the sessions, signs out one, then every other", async () => {
    const fetch = api({
      "GET /api/v1/auth/sessions": () =>
        json(200, {
          items: [
            session({ id: "ses_here", current: true }),
            session({ id: "ses_phone", userAgent: IPHONE_SAFARI }),
            session({ id: "ses_pc", userAgent: WINDOWS_EDGE }),
          ],
        }),
      "DELETE /api/v1/auth/sessions/ses_phone": () => new Response(null, { status: 204 }),
      "POST /api/v1/auth/sessions/revoke-others": () => json(200, { revoked: 1 }),
    });
    render(<AccountSessions />);
    expect(await screen.findByText("Safari on iOS")).toBeInTheDocument();
    expect(screen.getByText("· this session")).toBeInTheDocument();
    // The current session has no sign-out button of its own.
    expect(screen.getAllByRole("button", { name: /^Sign out .*signed in/ })).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: /^Sign out Safari on iOS/ }));
    expect(fetch).toHaveBeenCalledWith("/api/v1/auth/sessions/ses_phone", expect.objectContaining({ method: "DELETE" }));
    expect(screen.queryByText("Safari on iOS")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sign out other sessions" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Signed out 1 other session.");
    expect(screen.queryByText("Edge on Windows")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out other sessions" })).toBeDisabled();
  });

  it("says when the sessions can't be loaded", async () => {
    api({ "GET /api/v1/auth/sessions": () => json(500, { code: "INTERNAL", message: "boom" }) });
    render(<AccountSessions />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
