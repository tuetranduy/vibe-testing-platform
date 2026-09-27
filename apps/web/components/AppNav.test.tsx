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
  it.each([
    ["/runs", ["Test runs"]],
    ["/runs/run_123", ["Test runs"]],
    ["/runs/new", ["New test"]],
    ["/somewhere-else", []],
  ])("on %s marks %j as the current page", (path, expected) => {
    pathname = path;
    expect(currentLinks()).toEqual(expected);
  });
});
