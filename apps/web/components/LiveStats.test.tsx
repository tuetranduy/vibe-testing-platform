import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialProgress, type ProgressState } from "../lib/progress-reducer";
import { LiveStats, formatElapsed } from "./LiveStats";

const progress = (patch: Partial<ProgressState> = {}): ProgressState => ({ ...initialProgress(), ...patch });
const stat = (name: RegExp) => screen.getByRole("group", { name });

afterEach(() => vi.useRealTimers());

describe("LiveStats", () => {
  it("counts recorded steps against the plan, and the screenshots taken", () => {
    render(
      <LiveStats
        progress={progress({
          stepsRecorded: 7,
          plannedSteps: 12,
          artifacts: [
            { artifactId: "a1", type: "SCREENSHOT", sensitivity: "STANDARD", message: "m", timestamp: "2026-09-26T10:00:00.000Z" },
            { artifactId: "a2", type: "TRACE", sensitivity: "STANDARD", message: "m", timestamp: "2026-09-26T10:00:00.000Z" },
            { artifactId: "a3", type: "SCREENSHOT", sensitivity: "SECRET_BEARING", message: "m", timestamp: "2026-09-26T10:00:00.000Z" },
          ],
        })}
      />,
    );
    expect(stat(/steps/i)).toHaveTextContent("7 / 12");
    expect(stat(/screenshots/i)).toHaveTextContent("2");
    expect(stat(/elapsed/i)).toHaveTextContent("—"); // execution hasn't started
  });

  it("shows the steps without a plan while there is none", () => {
    render(<LiveStats progress={progress({ stepsRecorded: 0 })} />);
    expect(within(stat(/steps/i)).queryByText(/\//)).not.toBeInTheDocument();
    expect(stat(/steps/i)).toHaveTextContent("0");
  });

  it("ticks the time since execution started", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T10:01:05.000Z"));
    render(<LiveStats progress={progress({ executionStartedAt: "2026-09-26T10:00:17.000Z" })} />);
    expect(stat(/elapsed/i)).toHaveTextContent("0:48");
    act(() => void vi.advanceTimersByTime(3000));
    expect(stat(/elapsed/i)).toHaveTextContent("0:51");
  });

  it("formats elapsed time as a clock", () => {
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(48_000)).toBe("0:48");
    expect(formatElapsed(12 * 60_000 + 5_000)).toBe("12:05");
    expect(formatElapsed(3_600_000 + 2 * 60_000 + 3_000)).toBe("1:02:03");
  });
});
