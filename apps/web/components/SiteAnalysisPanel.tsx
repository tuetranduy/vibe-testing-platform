"use client";

import type { SiteAnalysis } from "@platform/contracts";
import { Icon } from "./Icon";

/** One suggested test data value as the user decides on it: taken or not, and its (possibly edited) text. */
export interface DataChoice {
  use: boolean;
  value: string;
}

/** Every suggestion taken, as suggested. */
export function initialChoices(analysis: SiteAnalysis): Record<string, DataChoice> {
  return Object.fromEntries(analysis.testData.map((t) => [t.key, { use: true, value: String(t.value) }]));
}

/**
 * The test data the confirmation sends: the taken suggestions with a non-blank value. An unedited value keeps
 * its type (a number stays a number); an edited one is sent as typed.
 */
export function chosenTestData(analysis: SiteAnalysis, choices: Record<string, DataChoice>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const t of analysis.testData) {
    const choice = choices[t.key];
    if (!choice?.use || choice.value.trim() === "") continue;
    out[t.key] = choice.value === String(t.value) ? t.value : choice.value.trim();
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Which pages of the live site the analysis read (V1.3), or why it read none. */
export function LiveSiteSummary({ analysis }: { analysis: SiteAnalysis }) {
  const read = analysis.pages.filter((p) => p.status === "READ");
  const notFound = analysis.checks.filter((c) => c.status === "NOT_FOUND").length;
  return (
    <section className="card site-analysis" aria-labelledby="site-analysis-title">
      <h3 id="site-analysis-title" className="site-analysis-title">
        <Icon name="globe" /> Checked against the live site
      </h3>
      {analysis.status === "READ" ? (
        <>
          <p className="muted">
            {plural(read.length, "page")} read before the criteria were written — nothing was clicked, typed or submitted. Full-page
            screenshots are kept with the run.
          </p>
          {notFound > 0 && (
            <p className="hint hint-warning">
              <Icon name="warning" /> {plural(notFound, "criterion", "criteria")} {notFound === 1 ? "checks" : "check"} something the pages read
              don&apos;t show. It may be on a page that wasn&apos;t read — or the requirement may need a second look.
            </p>
          )}
          <ul className="site-pages">
            {analysis.pages.map((p) => (
              <li key={p.url} className={p.status === "READ" ? undefined : "muted"}>
                <code>{new URL(p.url).pathname}</code>
                {p.title && <span> — {p.title}</span>}
                {p.status === "SKIPPED" && <span> (skipped)</span>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">
          {analysis.status === "SKIPPED" ? "The live site was not read for this run" : "The live site could not be read"}
          {analysis.reason ? `: ${analysis.reason}.` : "."} The criteria come from the requirement alone.
        </p>
      )}
    </section>
  );
}

interface SuggestedProps {
  analysis: SiteAnalysis;
  choices: Record<string, DataChoice>;
  onChange: (key: string, choice: DataChoice) => void;
  disabled?: boolean;
}

/** The test data the criteria need and the run lacks, suggested (V1.3): take, edit or leave each value. */
export function SuggestedTestData({ analysis, choices, onChange, disabled = false }: SuggestedProps) {
  if (analysis.testData.length === 0) return null;
  return (
    <section className="card suggested-data" aria-labelledby="suggested-data-title">
      <h3 id="suggested-data-title" className="site-analysis-title">
        <Icon name="data" /> Suggested test data
      </h3>
      <p className="muted">
        The criteria need {analysis.testData.length === 1 ? "a value" : "values"} you didn&apos;t provide. Take them as they are, edit them, or leave
        them out — a criterion without its value is reported as Blocked.
      </p>
      <ul className="suggested-list">
        {analysis.testData.map((t) => {
          const choice = choices[t.key] ?? { use: false, value: String(t.value) };
          const inputId = `suggested-${t.key}`;
          return (
            <li key={t.key} className="suggested-item">
              <label className="choice">
                <input type="checkbox" checked={choice.use} disabled={disabled} onChange={(e) => onChange(t.key, { ...choice, use: e.target.checked })} />
                <code>{t.key}</code>
                <span className={`badge ${t.source === "SITE" ? "badge-info" : "badge-neutral"}`}>{t.source === "SITE" ? "From the site" : "Generated"}</span>
              </label>
              <label className="visually-hidden" htmlFor={inputId}>
                Value for {t.key}
              </label>
              <input
                id={inputId}
                value={choice.value}
                disabled={disabled || !choice.use}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => onChange(t.key, { ...choice, value: e.target.value })}
              />
              {t.description && <p className="hint">{t.description}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
