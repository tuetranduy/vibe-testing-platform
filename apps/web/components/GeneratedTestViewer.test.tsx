import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { reportFixture } from "../test/fixtures";
import { GeneratedTestViewer } from "./GeneratedTestViewer";

const report = reportFixture();
const test = report.generatedTest!;

describe("GeneratedTestViewer", () => {
  it("shows the source read-only and syntax-highlighted, line by line", () => {
    render(<GeneratedTestViewer test={test} playwright={report.playwright} requirement={report.requirement} />);
    const code = screen.getByRole("region", { name: /generated test source/i });
    expect(code.querySelector("textarea, input, [contenteditable]")).toBeNull();
    expect(code.querySelector("code")!.textContent).toBe(test.source);
    expect(code.querySelectorAll(".code-line")).toHaveLength(test.source.split("\n").length);
    expect(code.querySelector(".tok-keyword")).toHaveTextContent("import");
    expect(code.querySelector(".tok-string")).not.toBeNull();
    expect(code).toHaveAttribute("tabindex", "0"); // scrollable with the keyboard
  });

  it("renders HTML in the source as text, never as markup", () => {
    const source = 'test("x", async () => {\n  // </code><script>window.pwned = 1</script>\n  const s = "<img src=x onerror=alert(1)>";\n});';
    const { container } = render(<GeneratedTestViewer test={{ ...test, source }} playwright={null} requirement={null} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("code")!.textContent).toBe(source);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("lists the compiled criteria, the criteria it could not compile with reasons, and the notes", () => {
    render(<GeneratedTestViewer test={test} playwright={report.playwright} requirement={report.requirement} />);
    const notCompiled = screen.getByRole("list", { name: /not in the test/i });
    expect(within(notCompiled).getByText("AC-3")).toBeInTheDocument();
    expect(within(notCompiled).getByText("Blocked before exploration")).toBeInTheDocument();
    expect(within(notCompiled).getByText("Semantic criteria cannot be asserted")).toBeInTheDocument();
    expect(screen.getByText(/uses a CSS locator/)).toBeInTheDocument();
    expect(screen.getByText(/AC-1, AC-2, AC-5/)).toBeInTheDocument();
    expect(screen.getByText(/rerun failed/i)).toBeInTheDocument();
  });

  it("handles a test with nothing left out and no notes", () => {
    render(<GeneratedTestViewer test={{ ...test, notCompiled: [], notes: [] }} playwright={null} requirement={null} />);
    expect(screen.queryByRole("list", { name: /not in the test/i })).not.toBeInTheDocument();
    expect(screen.getByText(/was not rerun/i)).toBeInTheDocument();
  });
});
