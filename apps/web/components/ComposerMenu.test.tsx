import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ComposerMenu, type MenuOption } from "./ComposerMenu";

const OPTIONS: MenuOption<string>[] = [
  { value: "", label: "Default", hint: "Claude Sonnet 5" },
  { value: "opus", label: "Claude Opus 5.5", group: "Anthropic" },
  { value: "gemini", label: "Gemini 3.8 Flash", group: "Google Gemini", disabled: true, hint: "Add a key in Settings" },
  { value: "flash", label: "DeepSeek Flash", group: "DeepSeek" },
];

function Harness({ onChange = () => {} }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <>
      <ComposerMenu
        id="llm-model"
        label="Model"
        icon="sparkle"
        value={value}
        display={OPTIONS.find((o) => o.value === value)!.label}
        options={OPTIONS}
        onChange={(v) => (setValue(v), onChange(v))}
      />
      <button type="button">elsewhere</button>
    </>
  );
}

const chip = () => screen.getByRole("button", { name: /^Model:/ });

describe("ComposerMenu", () => {
  it("is a button named by its label and value; it opens a listbox of options grouped as given", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(chip()).toHaveAccessibleName("Model: Default");
    expect(chip()).toHaveAttribute("aria-expanded", "false");
    await user.click(chip());
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("listbox", { name: "Model" });
    expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Anthropic", "Google Gemini", "DeepSeek"]);
    expect(within(list).getByRole("option", { name: "Default" })).toHaveAttribute("aria-selected", "true");
    expect(within(list).getByRole("option", { name: "Default" })).toHaveAccessibleDescription("Claude Sonnet 5");
    expect(within(list).getByRole("option", { name: "Gemini 3.8 Flash" })).toHaveAttribute("aria-disabled", "true");
  });

  it("a click on an option chooses it, closes the menu and returns focus to the chip; a disabled one does nothing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(chip());
    await user.click(screen.getByRole("option", { name: "Gemini 3.8 Flash" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Claude Opus 5.5" }));
    expect(onChange).toHaveBeenCalledWith("opus");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(chip()).toHaveAccessibleName("Model: Claude Opus 5.5");
    expect(chip()).toHaveFocus();
  });

  it("works from the keyboard: arrows skip disabled options, Enter chooses, Escape closes without choosing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    chip().focus();
    await user.keyboard("{ArrowDown}");
    const list = screen.getByRole("listbox");
    expect(list).toHaveFocus();
    const active = () => list.getAttribute("aria-activedescendant") && document.getElementById(list.getAttribute("aria-activedescendant")!);
    expect(active()).toHaveTextContent("Default"); // the selected option first
    await user.keyboard("{ArrowDown}{ArrowDown}"); // Opus, then past the disabled Gemini to Flash
    expect(active()).toHaveTextContent("DeepSeek Flash");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(chip()).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard("{End}{Enter}");
    expect(onChange).toHaveBeenCalledWith("flash");
  });

  it("closes on a click outside", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(chip());
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("can be disabled, and marked invalid with a description", () => {
    render(<ComposerMenu id="x" label="Reasoning" icon="gauge" value="" display="Default" options={OPTIONS} onChange={() => {}} disabled invalid describedBy="x-error" />);
    const button = screen.getByRole("button", { name: "Reasoning: Default" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-invalid", "true");
    expect(button).toHaveAttribute("aria-describedby", "x-error");
  });
});
