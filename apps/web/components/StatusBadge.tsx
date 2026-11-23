import { Badge } from "@/components/ui/badge";
import type { CriterionStatus, RunVerdict } from "@platform/contracts";
import { Icon } from "./Icon";
import { CRITERION_STATUS_UI, VERDICT_UI, type StatusUi } from "./report-format";

/** A status shown as icon + label + color together (Ruling R51: never color alone). */
function StatusBadge({ ui, testId }: { ui: StatusUi; testId?: string }) {
  const tone = {
    pass: "bg-(--success-bg) text-(--success) border-(--success-border)",
    fail: "bg-(--danger-bg) text-(--danger) border-(--danger-border)",
    blocked: "bg-(--warning-bg) text-(--warning) border-(--warning-border)",
    inconclusive: "bg-(--neutral-bg) text-(--neutral) border-[color-mix(in_srgb,var(--neutral)_30%,transparent)]",
  }[ui.tone];
  return (
    <Badge variant="outline" className={`h-auto gap-1.5 px-2.5 py-1 font-semibold ${tone}`} data-testid={testId}>
      <Icon name={ui.icon} /> {ui.label}
    </Badge>
  );
}

export const CriterionStatusBadge = ({ status }: { status: CriterionStatus }) => (
  <StatusBadge ui={CRITERION_STATUS_UI[status]} testId="criterion-status" />
);

export const VerdictBadge = ({ verdict }: { verdict: RunVerdict }) => <StatusBadge ui={VERDICT_UI[verdict]} />;
