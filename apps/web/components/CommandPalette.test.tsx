import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

function setup(admin = false) {
  const navigate = vi.fn();
  const onClose = vi.fn();
  render(<CommandPalette open onClose={onClose} admin={admin} navigate={navigate} />);
  return { navigate, onClose };
}

describe("CommandPalette", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<CommandPalette open={false} onClose={() => {}} admin={false} navigate={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("filters as you type and opens the match with Enter", async () => {
    const { navigate, onClose } = setup();
    const input = screen.getByRole("combobox", { name: "Search pages and actions" });
    expect(input).toHaveFocus();
    await userEvent.type(input, "suit");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Suites/suites"]);
    await userEvent.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/suites");
  });

  it("moves through the options with the arrow keys", async () => {
    const { navigate } = setup();
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(navigate).toHaveBeenCalledWith("/runs");
  });

  it("offers the administrators' settings only to administrators", async () => {
    setup(false);
    await userEvent.type(screen.getByRole("combobox"), "users");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const { onClose } = setup();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
