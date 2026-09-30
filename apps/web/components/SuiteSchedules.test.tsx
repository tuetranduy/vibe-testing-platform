import type { ScheduleView } from "@platform/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json, suiteFixture } from "../test/fixtures";
import { SuiteSchedules, describeCron, presetCron } from "./SuiteSchedules";

const schedule = (patch: Partial<ScheduleView> = {}): ScheduleView => ({
  id: "sch_1",
  suiteId: "ste_1",
  cron: "0 9 * * 1-5",
  timezone: "Europe/Zurich",
  enabled: true,
  nextRunAt: "2026-10-01T07:00:00.000Z",
  lastFiredAt: "2026-09-30T07:00:00.000Z",
  lastOutcome: "started",
  lastError: null,
  lastSuiteRunId: "srn_1",
  createdBy: { id: "usr_1", name: "Ann" },
  createdAt: "2026-09-29T10:00:00.000Z",
  updatedAt: "2026-09-29T10:00:00.000Z",
  ...patch,
});

function api(routes: Record<string, (init?: RequestInit) => Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    if (!routes[key]) throw new Error(`unexpected ${key}`);
    return routes[key]!(init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("cron helpers", () => {
  it("builds and describes the presets' expressions", () => {
    expect(presetCron("weekdays", "07:30")).toBe("30 7 * * 1-5");
    expect(presetCron("daily", "18:05")).toBe("5 18 * * *");
    expect(presetCron("hourly", "10:15")).toBe("15 * * * *");
    expect(describeCron("30 7 * * 1-5")).toBe("Monday to Friday at 07:30");
    expect(describeCron("5 18 * * *")).toBe("Every day at 18:05");
    expect(describeCron("15 * * * *")).toBe("Every hour at :15");
    expect(describeCron("0 3 1 * *")).toBe("0 3 1 * *");
  });
});

describe("SuiteSchedules (V1.2 F3)", () => {
  it("lists schedules with their next and last run, pauses one and adds another from a preset", async () => {
    const fetch = api({
      "GET /api/v1/suites/ste_1/schedules": () => json(200, { items: [schedule()] }),
      "PUT /api/v1/suite-schedules/sch_1": (init) => json(200, schedule({ ...JSON.parse(String(init!.body)), nextRunAt: null })),
      "POST /api/v1/suites/ste_1/schedules": (init) => json(201, schedule({ id: "sch_2", ...JSON.parse(String(init!.body)) })),
    });
    const user = userEvent.setup();
    render(<SuiteSchedules suite={suiteFixture()} />);
    const list = await screen.findByRole("list", { name: "Schedules" });
    expect(within(list).getByText("Monday to Friday at 09:00")).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "started a run" })).toHaveAttribute("href", "/suite-runs/srn_1");

    await user.click(within(list).getByRole("button", { name: "Pause" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/suite-schedules/sch_1",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ cron: "0 9 * * 1-5", timezone: "Europe/Zurich", enabled: false }) }),
    );
    expect(await within(list).findByText(/Paused/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add a schedule" }));
    await user.selectOptions(screen.getByLabelText("When"), "daily");
    await user.clear(screen.getByLabelText("Time"));
    await user.type(screen.getByLabelText("Time"), "18:30");
    await user.clear(screen.getByLabelText("Time zone"));
    await user.type(screen.getByLabelText("Time zone"), "UTC");
    await user.click(screen.getByRole("button", { name: "Add schedule" }));
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/suites/ste_1/schedules",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ cron: "30 18 * * *", timezone: "UTC" }) }),
    );
    expect(await screen.findByText("Every day at 18:30")).toBeInTheDocument();
  });

  it("can't add a schedule while the suite's saved credentials miss a secret", async () => {
    api({ "GET /api/v1/suites/ste_1/schedules": () => json(200, { items: [] }) });
    render(<SuiteSchedules suite={suiteFixture({ secretNames: ["password"], missingSecretNames: ["password"] })} />);
    expect(await screen.findByText("No schedules.")).toBeInTheDocument();
    expect(screen.getByText(/don't provide password/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a schedule" })).toBeDisabled();
  });
});
