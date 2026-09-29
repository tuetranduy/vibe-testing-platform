import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  it("links Test runs, Settings and New test, in that order", () => {
    pathname = "/runs";
    render(<AppNav />);
    expect(screen.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Test runs", "/runs"],
      ["Settings", "/settings"],
      ["New test", "/runs/new"],
    ]);
  });

  it.each([
    ["/runs", ["Test runs"]],
    ["/runs/run_123", ["Test runs"]],
    ["/runs/new", ["New test"]],
    ["/settings", ["Settings"]],
    ["/somewhere-else", []],
  ])("on %s marks %j as the current page", (path, expected) => {
    pathname = path;
    expect(currentLinks()).toEqual(expected);
  });
});
