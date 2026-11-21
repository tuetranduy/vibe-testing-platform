import { afterEach, describe, expect, it, vi } from "vitest";
import { PausableTimer } from "./pausable-timer";
afterEach(() => vi.useRealTimers());
describe("assistance clock pause (2026-11-21)", () => {
  it("keeps the exact remaining budget across a long user wait", () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const timer = new PausableTimer(1000, fire);
    vi.advanceTimersByTime(400);
    timer.pause();
    vi.advanceTimersByTime(600000);
    expect(fire).not.toHaveBeenCalled();
    timer.resume();
    vi.advanceTimersByTime(599);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledOnce();
    timer.dispose();
  });
});
