import { render, screen, within } from "@testing-library/react";
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
  it("links Test runs, Suites, Usage and Settings in the main nav, in that order", () => {
    pathname = "/runs";
    render(<AppNav />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Test runs", "/runs"],
      ["Suites", "/suites"],
      ["Usage", "/usage"],
      ["Settings", "/settings"],
    ]);
  });

  it("offers New test in the sidebar and in the narrow-screen top bar", () => {
    pathname = "/runs";
    render(<AppNav />);
    const links = screen.getAllByRole("link", { name: "New test" });
    expect(links).toHaveLength(2);
    for (const a of links) expect(a).toHaveAttribute("href", "/runs/new");
  });

  it.each([
    ["/runs", ["Test runs"]],
    ["/runs/run_123", ["Test runs"]],
    ["/runs/new", ["New test"]],
    ["/settings", ["Settings", "AI models"]],
    ["/settings/credentials", ["Settings", "Credentials"]],
    ["/usage", ["Usage"]],
    ["/suites", ["Suites"]],
    ["/suites/ste_1", ["Suites"]],
    ["/suite-runs/srn_1", ["Suites"]],
    ["/somewhere-else", []],
  ])("on %s marks %j as the current page", (path, expected) => {
    pathname = path;
    expect(currentLinks()).toEqual(expected);
  });

  it("lists Settings' sections only while in Settings, and the admin ones only to administrators", async () => {
    pathname = "/settings";
    testMe.current = userFixture({ role: "member" });
    const { unmount } = render(<AppNav />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Credentials" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
    unmount();

    pathname = "/runs";
    render(<AppNav />);
    expect(screen.queryByRole("link", { name: "Credentials" })).not.toBeInTheDocument();
  });

  it("opens and closes the drawer from the top bar", async () => {
    pathname = "/runs";
    render(<AppNav />);
    const menu = screen.getByRole("button", { name: "Open menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("sidebar")).toHaveAttribute("data-open", "true");
    await userEvent.keyboard("{Escape}");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveFocus();
  });

  it("collapses the sidebar to a rail and remembers it", async () => {
    pathname = "/runs";
    render(<AppNav />);
    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(document.documentElement).toHaveAttribute("data-sidebar", "collapsed");
    expect(localStorage.getItem("sidebar")).toBe("collapsed");
    await userEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(document.documentElement).not.toHaveAttribute("data-sidebar");
  });

  it("opens the command palette with Ctrl-K", async () => {
    pathname = "/runs";
    render(<AppNav />);
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Search or jump to" })).toBeInTheDocument();
  });

  it("names the signed-in user, links their account and signs out", async () => {
    pathname = "/runs";
    testMe.current = userFixture({ name: "Ann", email: "ann@example.com" });
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const navigate = vi.fn();
    render(<AppNav navigate={navigate} />);
    expect(await screen.findByRole("link", { name: "Ann (your account)" })).toHaveAttribute("href", "/account");
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
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("renders nothing on the sign-in page", () => {
    pathname = "/login";
    const { container } = render(<AppNav />);
    expect(container).toBeEmptyDOMElement();
  });
});
