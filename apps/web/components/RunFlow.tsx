import { isTerminalLifecycle, type RunLifecycle } from "@platform/contracts";
import { cn } from "@/lib/utils";
import { Icon } from "./Icon";

const steps = ["Prepare", "Review checks", "Run test", "See results"];
const activeStages: RunLifecycle[] = ["PLANNING", "EXPLORING", "VERIFYING", "GENERATING_TEST", "RUNNING_PLAYWRIGHT", "GENERATING_REPORT"];

/** A stable four-step journey, independent of the engine's detailed stage names. */
export function RunFlow({ lifecycle }: { lifecycle: RunLifecycle }) {
  const terminal = isTerminalLifecycle(lifecycle);
  const current = terminal ? 3 : lifecycle === "AWAITING_CONFIRMATION" ? 1 : activeStages.includes(lifecycle) ? 2 : 0;

  return (
    <nav className="print:hidden" aria-label="Test workflow">
      <ol className="m-0 grid list-none grid-cols-4 gap-4 rounded-[12px] border border-border bg-card px-6 py-[18px] max-[720px]:gap-2 max-[720px]:px-2.5 max-[720px]:py-3.5">
        {steps.map((label, index) => {
          const active = index === current;
          const done = index < current && (!terminal || lifecycle === "COMPLETED");
          return (
            <li
              key={label}
              aria-current={active ? "step" : undefined}
              className="flex items-center gap-[9px] text-[0.8rem] text-(--text-subtle) aria-[current=step]:font-semibold aria-[current=step]:text-accent-foreground max-[720px]:flex-col max-[720px]:gap-1.5 max-[720px]:text-center max-[720px]:text-[0.65rem]"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "inline-flex size-[27px] shrink-0 items-center justify-center rounded-full border border-border text-[0.72rem] [&>.icon]:size-[13px]",
                  active && "border-primary bg-primary text-primary-foreground",
                  done && "border-transparent bg-(--success-bg) text-(--success)",
                )}
              >
                {done ? <Icon name="check" /> : index + 1}
              </span>
              <span>{label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
