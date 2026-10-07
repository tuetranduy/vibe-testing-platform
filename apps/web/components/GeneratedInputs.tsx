import type { TestReport } from "@platform/contracts";

/**
 * The values nobody provided that the run generated from the page and filled (2026-10-07). Listed so a result that
 * depends on one (a login with an invented password fails) can be read for what it is.
 */
export function GeneratedInputs({ inputs }: { inputs: readonly TestReport["generatedInputs"][number][] }) {
  if (inputs.length === 0) return null;
  return (
    <section className="card" aria-labelledby="generated-inputs-title">
      <h2 id="generated-inputs-title" className="card-title">
        Generated inputs
      </h2>
      <p className="hint">Nobody provided these values, so the run made them up from the fields on the page and typed them.</p>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {inputs.map((g) => (
              <tr key={`${g.source}:${g.key}`}>
                <td>
                  <code>{g.key}</code>
                </td>
                <td>{g.source === "secret" ? "Secret" : "Test data"}</td>
                <td>
                  <code>{g.value}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
