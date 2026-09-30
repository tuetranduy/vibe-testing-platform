import { describe, expect, it } from "vitest";
import { renderJunit, xmlText, type JunitChild } from "./junit";

const child = (patch: Partial<JunitChild> = {}): JunitChild => ({
  runId: "run_a",
  title: "Add to cart",
  lifecycle: "COMPLETED",
  durationMs: 1500,
  error: null,
  criteria: [
    { id: "AC-1", description: "Cart count is 1", critical: true, status: "PASS", expected: "1", actual: "1", reason: null },
    { id: "AC-2", description: "Total <shown>", critical: true, status: "FAIL", expected: "$999", actual: "$0", reason: null },
    { id: "AC-3", description: "Banner", critical: false, status: "INCONCLUSIVE", expected: "hidden", actual: null, reason: "RERUN_NOT_REACHED" },
  ],
  ...patch,
});

describe("renderJunit (V1.2 F5)", () => {
  it("one testsuite per test, one testcase per criterion, with totals", () => {
    const xml = renderJunit({ suiteName: "Smoke & co", suiteRunId: "srn_1", children: [child()] });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Smoke &amp; co" id="srn_1" tests="3" failures="1" errors="0" skipped="1" time="1.500">')).toBe(true);
    expect(xml).toContain('<testsuite name="Add to cart" tests="3" failures="1" errors="0" skipped="1" time="1.500" id="run_a">');
    expect(xml).toContain('<testcase classname="Smoke &amp; co.Add to cart" name="AC-1 Cart count is 1"/>');
    expect(xml).toContain('<failure message="Expected $999; got $0" type="AssertionFailed">Expected $999; got $0</failure>');
    expect(xml).toContain('name="AC-2 Total &lt;shown&gt;"');
    expect(xml).toMatch(/name="AC-3 Banner \(non-critical\)">\n\s+<skipped message="INCONCLUSIVE: [^"]+"\/>/);
  });

  it("a run without results is one errored or skipped testcase", () => {
    const xml = renderJunit({
      suiteName: "Smoke",
      suiteRunId: "srn_1",
      children: [
        child({ runId: "run_e", lifecycle: "ERRORED", criteria: [], error: { category: "BROWSER_PROVIDER", message: "Chromium crashed" } }),
        child({ runId: "run_c", lifecycle: "CANCELLED", criteria: [], durationMs: null }),
      ],
    });
    expect(xml).toContain('tests="2" failures="0" errors="1" skipped="1"');
    expect(xml).toContain('<error message="BROWSER_PROVIDER: Chromium crashed" type="BROWSER_PROVIDER"/>');
    expect(xml).toContain('<skipped message="The run ended CANCELLED without results"/>');
  });

  it("escapes markup and drops characters XML can't hold", () => {
    expect(xmlText(`a"b'c<d>&e\u0000\u0007f￾g`)).toBe("a&quot;b&apos;c&lt;d&gt;&amp;efg");
    expect(xmlText("emoji 🙂 and ü")).toBe("emoji 🙂 and ü");
  });
});
