import { Card } from "@/components/ui/card";
import { ADDED_BY_PLATFORM, assumptionsOf, type Assumption, type NormalizedRequirement } from "@platform/contracts";
import { useId } from "react";

const TAG: Record<Exclude<Assumption["kind"], "note">, string> = { added: ADDED_BY_PLATFORM, assumed: "Assumed" };

/** What the analysis added or assumed, as list items: shared by the report and the printable report. */
export function AssumptionItems({ requirement }: { requirement: NormalizedRequirement }) {
  return (
    <ul className="m-0 grid gap-[0.4rem] pl-[1.1rem] text-[0.9rem]">
      {assumptionsOf(requirement).map((a, i) => (
        <li key={`${a.kind}-${a.criterionId ?? i}-${i}`}>
          {a.kind !== "note" && (
            <span className="mr-2 inline-block text-xs font-semibold text-muted-foreground">
              {a.criterionId} · {TAG[a.kind]}
            </span>
          )}
          <span>{a.text}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The report's "Assumptions" section (2026-11-11, spec intent-understanding): the checks the platform added to a
 * short requirement and why, the vague wording it checked in a concrete way, and what it left out. Nothing when the
 * analysis added and assumed nothing. All of it is model text: rendered as text, never as markup.
 */
export function Assumptions({ requirement }: { requirement: NormalizedRequirement | null }) {
  const titleId = useId();
  if (!requirement || assumptionsOf(requirement).length === 0) return null;
  return (
    <Card as="section" className="grid gap-[0.6rem]" aria-labelledby={titleId}>
      <h2 id={titleId} className="panel-title">
        Assumptions
      </h2>
      <p className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">These checks or readings are the platform&apos;s, not your words. Remove or change them in the next test&apos;s review.</p>
      {requirement.intent && (
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="note-title">What was understood</span> <span>{requirement.intent.goal}</span>
        </p>
      )}
      <AssumptionItems requirement={requirement} />
    </Card>
  );
}
