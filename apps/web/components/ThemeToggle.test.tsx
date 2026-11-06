import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme } from "../lib/theme";
import { ThemeToggle } from "./ThemeToggle";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-pref");
  localStorage.clear();
});

describe("ThemeToggle", () => {
  it("shows light as the default and switches to dark, remembering the choice", async () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
  });

  it("follows a theme chosen elsewhere (the command palette)", () => {
    render(<ThemeToggle />);
    act(() => applyTheme("system"));
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement).toHaveAttribute("data-theme-pref", "system");
  });
});

