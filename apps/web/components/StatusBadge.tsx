import type { CriterionStatus, RunVerdict } from "@platform/contracts";
import { Icon } from "./Icon";
import { CRITERION_STATUS_UI, VERDICT_UI, type StatusUi } from "./report-format";

/** A status shown as icon + label + color together (Ruling R51: never color alone). */
function Badge({ ui, testId }: { ui: StatusUi; testId?: string }) {
  return (
    <span className={`sbadge sbadge-${ui.tone}`} data-testid={testId}>
      <Icon name={ui.icon} /> {ui.label}
    </span>
  );
}

export const CriterionStatusBadge = ({ status }: { status: CriterionStatus }) => (
  <Badge ui={CRITERION_STATUS_UI[status]} testId="criterion-status" />
);

export const VerdictBadge = ({ verdict }: { verdict: RunVerdict }) => <Badge ui={VERDICT_UI[verdict]} />;
