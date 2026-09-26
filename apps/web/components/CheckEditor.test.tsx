import type { ExpectedOutcome, FactRequest } from "@platform/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CheckEditor, type EditableOutcome } from "./CheckEditor";

const facts: FactRequest[] = [
  { key: "cartCount", checkpoint: "before_add", description: "Cart badge count", valueType: "number" },
  { key: "cartCount", checkpoint: "after_add", description: "Cart badge count", valueType: "number" },
  { key: "message", checkpoint: "after_add", description: "Confirmation text", valueType: "string" },
  { key: "items", checkpoint: "cart_page", description: "Items in the cart", valueType: "string_list" },
  { key: "banner", checkpoint: "home", description: "Cookie banner", valueType: "boolean" },
];
const ref = (key: string, checkpoint: string) => ({ key, checkpoint });

function setup(outcome: EditableOutcome) {
  const onSave = vi.fn<(o: ExpectedOutcome) => void>();
  const user = userEvent.setup();
  render(<CheckEditor criterionId="AC-1" outcome={outcome} facts={facts} busy={false} serverError={null} onSave={onSave} onDiscard={() => {}} />);
  return { onSave, user };
}

describe("CheckEditor", () => {
  it("numeric compare against a literal: operator and number, with a live preview", async () => {
    const { onSave, user } = setup({ kind: "numeric_compare", left: ref("cartCount", "after_add"), operator: "eq", right: 1 });
    const value = screen.getByLabelText(/compared with/i);
    await user.clear(value);
    await user.type(value, "2");
    await user.selectOptions(screen.getByLabelText(/comparison/i), "gte");
    expect(screen.getByText("Cart badge count (at “after add”) is at least 2.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(onSave).toHaveBeenCalledWith({ kind: "numeric_compare", left: ref("cartCount", "after_add"), operator: "gte", right: 2 });
  });

  it("numeric compare against another fact: only the operator is editable", () => {
    setup({ kind: "numeric_compare", left: ref("cartCount", "after_add"), operator: "gt", right: ref("cartCount", "before_add") });
    expect(screen.getByLabelText(/comparison/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/compared with/i)).not.toBeInTheDocument();
  });

  it.each(["", "abc", "1e400"])("refuses to save a number field of %j", async (typed) => {
    const { onSave, user } = setup({ kind: "numeric_delta", before: ref("cartCount", "before_add"), after: ref("cartCount", "after_add"), delta: 1 });
    const field = screen.getByLabelText(/difference/i);
    await user.clear(field);
    if (typed) await user.type(field, typed);
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/enter a number/i);
  });

  it("text check: mode, value and case", async () => {
    const { onSave, user } = setup({ kind: "text_matches", fact: ref("message", "after_add"), match: { mode: "contains", value: "added", caseSensitive: false } });
    await user.selectOptions(screen.getByLabelText(/how it matches/i), "equals");
    const value = screen.getByLabelText(/^text$/i);
    await user.clear(value);
    await user.type(value, "Added to cart");
    await user.click(screen.getByLabelText(/match case/i));
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(onSave).toHaveBeenCalledWith({
      kind: "text_matches",
      fact: ref("message", "after_add"),
      match: { mode: "equals", value: "Added to cart", caseSensitive: true },
    });
  });

  it("refuses a regex that does not compile, and empty text", async () => {
    const { onSave, user } = setup({ kind: "text_matches", fact: ref("message", "after_add"), match: { mode: "regex", value: "^added", caseSensitive: false } });
    const value = screen.getByLabelText(/^pattern$/i);
    await user.clear(value);
    await user.type(value, "(");
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(value).toHaveAccessibleDescription(/not a valid pattern/i);
    await user.clear(value);
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(value).toHaveAccessibleDescription(/enter 1 to 500 characters/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("visibility: shown or not shown", async () => {
    const { onSave, user } = setup({ kind: "visible", fact: ref("banner", "home"), expected: false });
    await user.click(screen.getByLabelText(/^shown$/i));
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(onSave).toHaveBeenCalledWith({ kind: "visible", fact: ref("banner", "home"), expected: true });
  });

  it("list check: item text and match", async () => {
    const { onSave, user } = setup({ kind: "collection_contains", collection: ref("items", "cart_page"), item: "iPhone", match: "contains" });
    const item = screen.getByLabelText(/^item$/i);
    await user.clear(item);
    await user.type(item, "iPhone 17 Pro");
    await user.selectOptions(screen.getByLabelText(/how it matches/i), "equals");
    await user.click(screen.getByRole("button", { name: /save check/i }));
    expect(onSave).toHaveBeenCalledWith({ kind: "collection_contains", collection: ref("items", "cart_page"), item: "iPhone 17 Pro", match: "equals" });
  });

  it("shows a server error inline", () => {
    render(
      <CheckEditor
        criterionId="AC-1"
        outcome={{ kind: "visible", fact: ref("banner", "home"), expected: true }}
        facts={facts}
        busy={false}
        serverError="Only a criterion's check values can change during review"
        onSave={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Only a criterion's check values can change during review");
  });
});
