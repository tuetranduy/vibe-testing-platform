"use client";

import { Card } from "@/components/ui/card";
import type { SiteAnalysis } from "@platform/contracts";
import { Icon } from "./Icon";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Which pages of the live site the analysis read (V1.3), or why it read none. */
export function LiveSiteSummary({ analysis }: { analysis: SiteAnalysis }) {
  const read = analysis.pages.filter((p) => p.status === "READ");
  const notFound = analysis.checks.filter((c) => c.status === "NOT_FOUND").length;
  return (
    <Card as="section" className="site-analysis" aria-labelledby="site-analysis-title">
      <h3 id="site-analysis-title" className="site-analysis-title">
        <Icon name="globe" /> Checked against the live site
      </h3>
      {analysis.status === "READ" ? (
        <>
          <p className="text-muted-foreground">
            {plural(read.length, "page")} explored before the checks were written. Screenshots are kept with the run.
          </p>
          {notFound > 0 && (
            <p className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5 text-(--warning)">
              <Icon name="warning" /> {plural(notFound, "criterion", "criteria")} {notFound === 1 ? "checks" : "check"} something the pages read
              don&apos;t show. It may be on a page that wasn&apos;t read — or the requirement may need a second look.
            </p>
          )}
          <ul className="site-pages">
            {analysis.pages.map((p) => (
              <li key={p.url} className={p.status === "READ" ? undefined : "text-muted-foreground"}>
                <code>{new URL(p.url).pathname}</code>
                {p.title && <span> — {p.title}</span>}
                {p.status === "SKIPPED" && <span> (skipped)</span>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-muted-foreground">
          {analysis.status === "SKIPPED" ? "The live site was not read for this run" : "The live site could not be read"}
          {analysis.reason ? `: ${analysis.reason}.` : "."} The criteria come from the requirement alone.
        </p>
      )}
    </Card>
  );
}
