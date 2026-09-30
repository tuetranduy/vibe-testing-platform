import { STATUS_REASON_TEXT, type CriterionStatus, type ErrorCategory, type RunLifecycle, type StatusReason } from "@platform/contracts";

/** One run of a suite run, as its JUnit test suite needs it (V1.2 F5). */
export interface JunitChild {
  runId: string;
  title: string;
  lifecycle: RunLifecycle;
  durationMs: number | null;
  error: { category: ErrorCategory; message: string | null } | null;
  criteria: {
    id: string;
    description: string;
    critical: boolean;
    status: CriterionStatus;
    expected: string;
    actual: string | null;
    reason: StatusReason | null;
  }[];
}

export interface JunitInput {
  suiteName: string;
  suiteRunId: string;
  children: JunitChild[];
}

// XML 1.0 allows tab, LF, CR and U+0020 upwards (minus lone surrogates and U+FFFE/U+FFFF): drop the rest.
const INVALID_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;

/** Text safe inside an XML attribute or element. */
export function xmlText(text: string): string {
  return text
    .replace(INVALID_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const seconds = (ms: number | null) => ((ms ?? 0) / 1000).toFixed(3);

/**
 * A settled suite run as a JUnit XML report (`GET /v1/suite-runs/:id/junit.xml`), for CI systems. Pure. One
 * `<testsuite>` per test of the suite, one `<testcase>` per criterion: FAIL is a `<failure>`, BLOCKED and
 * INCONCLUSIVE are `<skipped>` with their reason; a run that ended without results is one `<testcase>` with an
 * `<error>` (errored) or `<skipped>` (cancelled).
 */
export function renderJunit(input: JunitInput): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  let totalMs = 0;
  const suites: string[] = [];

  for (const child of input.children) {
    const cases: string[] = [];
    let f = 0;
    let e = 0;
    let s = 0;
    const classname = xmlText(`${input.suiteName}.${child.title}`);
    for (const c of child.criteria) {
      const name = xmlText(`${c.id} ${c.description}${c.critical ? "" : " (non-critical)"}`);
      const open = `    <testcase classname="${classname}" name="${name}">`;
      if (c.status === "FAIL") {
        f += 1;
        const message = xmlText(`Expected ${c.expected}; got ${c.actual ?? "nothing"}`);
        cases.push(`${open}\n      <failure message="${message}" type="AssertionFailed">${message}</failure>\n    </testcase>`);
      } else if (c.status === "BLOCKED" || c.status === "INCONCLUSIVE") {
        s += 1;
        const why = xmlText(`${c.status}: ${c.reason ? STATUS_REASON_TEXT[c.reason] : "no reason recorded"}`);
        cases.push(`${open}\n      <skipped message="${why}"/>\n    </testcase>`);
      } else {
        cases.push(`    <testcase classname="${classname}" name="${name}"/>`);
      }
    }
    if (child.criteria.length === 0) {
      const open = `    <testcase classname="${classname}" name="run ${xmlText(child.runId)}">`;
      if (child.lifecycle === "ERRORED") {
        e += 1;
        const message = xmlText(`${child.error?.category ?? "ERRORED"}${child.error?.message ? `: ${child.error.message}` : ""}`);
        cases.push(`${open}\n      <error message="${message}" type="${xmlText(child.error?.category ?? "ERRORED")}"/>\n    </testcase>`);
      } else {
        s += 1;
        cases.push(`${open}\n      <skipped message="${xmlText(`The run ended ${child.lifecycle} without results`)}"/>\n    </testcase>`);
      }
    }
    const n = Math.max(child.criteria.length, 1);
    tests += n;
    failures += f;
    errors += e;
    skipped += s;
    totalMs += child.durationMs ?? 0;
    suites.push(
      `  <testsuite name="${xmlText(child.title)}" tests="${n}" failures="${f}" errors="${e}" skipped="${s}" time="${seconds(child.durationMs)}" id="${xmlText(child.runId)}">\n${cases.join("\n")}\n  </testsuite>`,
    );
  }
  out.push(
    `<testsuites name="${xmlText(input.suiteName)}" id="${xmlText(input.suiteRunId)}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${seconds(totalMs)}">`,
    ...suites,
    "</testsuites>",
  );
  return `${out.join("\n")}\n`;
}
