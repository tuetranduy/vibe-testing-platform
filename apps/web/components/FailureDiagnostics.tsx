import type { TestReport } from "@platform/contracts";

type Finding = TestReport["diagnostics"][number];

/**
 * Diagnostic findings: the report stage's model-written explanations of results that did not pass.
 * They are guidance only — written after every status was decided, they never change one (D3).
 */
export function FailureDiagnostics({ findings, emptyText = "No diagnostics." }: { findings: readonly Finding[]; emptyText?: string }) {
  if (findings.length === 0) return <p className="text-muted-foreground">{emptyText}</p>;
  return (
    <div className="diagnostics">
      <ul>
        {findings.map((f, i) => (
          <li key={i}>{f.summary}</li>
        ))}
      </ul>
      <p className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">Written by the AI model to help explain the result. Diagnostics never change a status.</p>
    </div>
  );
}
