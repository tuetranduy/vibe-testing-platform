import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { testMe, userFixture } from "../test/me";
import { AppNav } from "./AppNav";

let pathname = "/runs";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

function currentLinks() {
  render(<AppNav />);
  return screen
    .getAllByRole("link")
    .filter((a) => a.getAttribute("aria-current") === "page")
    .map((a) => a.textContent);
}

describe("AppNav", () => {
  it("links Test runs, Suites, Usage, Settings and New test, in that order", () => {
    pathname = "/runs";
    render(<AppNav />);
    expect(screen.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Test runs", "/runs"],
      ["Suites", "/suites"],
      ["Usage", "/usage"],
      ["Settings", "/settings"],
      ["New test", "/runs/new"],
    ]);
  });

  it.each([
    ["/runs", ["Test runs"]],
    ["/runs/run_123", ["Test runs"]],
    ["/runs/new", ["New test"]],
    ["/settings", ["Settings"]],
    ["/settings/users", ["Settings"]],
    ["/usage", ["Usage"]],
    ["/suites", ["Suites"]],
    ["/suites/ste_1", ["Suites"]],
    ["/suite-runs/srn_1", ["Suites"]],
    ["/somewhere-else", []],
  ])("on %s marks %j as the current page", (path, expected) => {
    pathname = path;
    expect(currentLinks()).toEqual(expected);
  });

  it("names the signed-in user, links their account and signs out", async () => {
    pathname = "/runs";
    testMe.current = userFixture({ name: "Ann", email: "ann@example.com" });
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const navigate = vi.fn();
    render(<AppNav navigate={navigate} />);
    expect(screen.getByRole("link", { name: "Ann (your account)" })).toHaveAttribute("href", "/account");
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(fetch).toHaveBeenCalledWith("/api/v1/auth/logout", expect.objectContaining({ method: "POST" }));
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("signs out even when the API cannot be reached", async () => {
    testMe.current = userFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    const navigate = vi.fn();
    render(<AppNav navigate={navigate} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("renders nothing on the sign-in page", () => {
    pathname = "/login";
    const { container } = render(<AppNav />);
    expect(container).toBeEmptyDOMElement();
  });
});
