import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GeneratedInputs } from "./GeneratedInputs";

describe("GeneratedInputs", () => {
  it("lists each generated value with its key and kind, and says why", () => {
    render(
      <GeneratedInputs
        inputs={[
          { source: "testData", key: "email", value: "alex.tester@example.com", stepId: "st_1" },
          { source: "secret", key: "password", value: "Gen-Pass-1!aB", stepId: "st_2" },
        ]}
      />,
    );
    const section = screen.getByRole("region", { name: /generated inputs/i });
    const rows = within(section).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").map((c) => c.textContent))).toEqual([
      ["email", "Test data", "alex.tester@example.com"],
      ["password", "Secret", "Gen-Pass-1!aB"],
    ]);
    expect(within(section).getByText(/nobody provided/i)).toBeInTheDocument();
  });

  it("renders nothing when every value was provided", () => {
    const { container } = render(<GeneratedInputs inputs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
