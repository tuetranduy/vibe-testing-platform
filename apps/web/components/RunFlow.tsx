import { isTerminalLifecycle, type RunLifecycle } from "@platform/contracts";
import { Icon } from "./Icon";

/** A stable four-step journey, independent of the engine's detailed stage names. */
export function RunFlow({ lifecycle }: { lifecycle: RunLifecycle }) {
  const current = isTerminalLifecycle(lifecycle) ? 3 : lifecycle === "AWAITING_CONFIRMATION" ? 1
    : ["PLANNING", "EXPLORING", "VERIFYING", "GENERATING_TEST", "RUNNING_PLAYWRIGHT", "GENERATING_REPORT"].includes(lifecycle) ? 2 : 0;
  return <nav className="run-flow" aria-label="Test workflow"><ol>
    {["Prepare", "Review checks", "Run test", "See results"].map((label, i) => <li key={label} aria-current={i === current ? "step" : undefined} className={i < current && (!isTerminalLifecycle(lifecycle) || lifecycle === "COMPLETED") ? "flow-done" : undefined}>
      <span className="flow-marker" aria-hidden="true">{i < current && (!isTerminalLifecycle(lifecycle) || lifecycle === "COMPLETED") ? <Icon name="check" /> : i + 1}</span><span>{label}</span>
    </li>)}
  </ol></nav>;
}
