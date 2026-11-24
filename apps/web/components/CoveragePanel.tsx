"use client";

import type { CoverageResponse } from "@platform/contracts";
import { useEffect, useState } from "react";
import { getCoverage } from "../lib/api";
import { Disclosure } from "./Disclosure";

/**
 * Phase C: what Browser Use has found on this site across your recent runs, against what verified tests reached.
 * Pages it found that no test has reached are listed first: candidates for the next test.
 */
export function CoveragePanel({ targetUrl }: { targetUrl: string }) {
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  useEffect(() => {
    let live = true;
    getCoverage(targetUrl).then((c) => live && setCoverage(c), () => {});
    return () => { live = false; };
  }, [targetUrl]);
  if (!coverage || coverage.pages.length === 0) return null;
  const gaps = new Set(coverage.gaps);
  const pages = [...coverage.pages].sort((a, b) => Number(gaps.has(b.path)) - Number(gaps.has(a.path)));
  return (
    <Disclosure
      title={`Coverage across runs (${coverage.pages.length} pages)`}
      hint={`${coverage.gaps.length} found by Browser Use but not reached by a verified test, across your last ${coverage.runs} runs on this site.`}
    >
      <table className="w-full text-sm" aria-label="Coverage across runs">
        <thead>
          <tr className="text-left text-muted-foreground"><th>Page</th><th>Found by Browser Use</th><th>Reached by a test</th><th>Findings</th></tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.path}>
              <td><code>{p.path}</code>{gaps.has(p.path) && <span className="ml-1.5 text-(--warning)">Not tested yet</span>}</td>
              <td>{p.discovered}</td>
              <td>{p.tested}</td>
              <td>{p.findings}{p.reproduced > 0 && ` (${p.reproduced} reproduced)`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Disclosure>
  );
}
