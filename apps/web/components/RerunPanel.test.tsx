import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { RerunPanel } from "./RerunPanel";

const RERUN = "/api/v1/test-runs/run_1/rerun";
const PROFILES = "/api/v1/credential-profiles";

function api(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    if (!routes[key]) throw new Error(`unexpected ${key}`);
    return routes[key]!(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("RerunPanel", () => {
  it("without secrets: one click starts the rerun and opens the new run", async () => {
    const fetch = api({
      [`POST ${RERUN}`]: () => json(202, { runId: "run_2", lifecycle: "QUEUED", eventsUrl: "/v1/test-runs/run_2/events" }),
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<RerunPanel runId="run_1" secretNames={[]} compiledCount={2} navigate={navigate} />);
    expect(screen.getByText(/It checks 2 criteria/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rerun test" }));
    await user.click(screen.getByRole("button", { name: "Start rerun" }));
    expect(fetch).toHaveBeenCalledWith(RERUN, expect.objectContaining({ method: "POST", body: JSON.stringify({ secrets: {} }) }));
    const headers = fetch.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toMatch(/.+/);
    expect(navigate).toHaveBeenCalledWith("/runs/run_2");
  });

  it("asks for each secret again, and saved credentials can provide them", async () => {
    const fetch = api({
      [`GET ${PROFILES}`]: () =>
        json(200, {
          items: [
            {
              id: "cp_1",
              name: "QA",
              description: "",
              secretNames: ["password"],
              createdBy: null,
              createdAt: "2026-09-29T10:00:00.000Z",
              updatedAt: "2026-09-29T10:00:00.000Z",
            },
          ],
        }),
      [`POST ${RERUN}`]: () => json(202, { runId: "run_3", lifecycle: "QUEUED", eventsUrl: "/v1/test-runs/run_3/events" }),
    });
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<RerunPanel runId="run_1" secretNames={["password"]} compiledCount={1} navigate={navigate} />);
    await user.click(screen.getByRole("button", { name: "Rerun test" }));
    await user.click(screen.getByRole("button", { name: "Start rerun" }));
    expect(screen.getByText("Enter password, or choose saved credentials that have it.")).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

    await user.selectOptions(await screen.findByLabelText("Saved credentials"), "cp_1");
    await user.click(screen.getByRole("button", { name: "Start rerun" }));
    expect(fetch).toHaveBeenLastCalledWith(
      RERUN,
      expect.objectContaining({ body: JSON.stringify({ secrets: {}, credentialProfileId: "cp_1" }) }),
    );
    expect(navigate).toHaveBeenCalledWith("/runs/run_3");
  });

  it("shows the API's per-secret refusal on the field and clears typed values", async () => {
    api({
      [`GET ${PROFILES}`]: () => json(200, { items: [] }),
      [`POST ${RERUN}`]: () =>
        json(422, {
          code: "SECRETS_REQUIRED",
          message: "x",
          issues: [{ path: ["secrets", "pin"], message: "Enter pin again: secret values are deleted when a run ends" }],
        }),
    });
    const user = userEvent.setup();
    render(<RerunPanel runId="run_1" secretNames={["pin"]} compiledCount={1} navigate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Rerun test" }));
    await user.type(screen.getByLabelText("pin"), "1234");
    await user.click(screen.getByRole("button", { name: "Start rerun" }));
    expect(await screen.findByText("Enter pin again: secret values are deleted when a run ends")).toBeInTheDocument();
    expect(screen.getByLabelText("pin")).toHaveValue("");
  });
});
