/** A stage clock can stop for a person without replacing its AbortSignal (2026-11-21). */
export class PausableTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = Date.now();
  constructor(private remaining: number, private readonly fire: () => void) {
    this.resume();
  }
  pause(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.started));
  }
  resume(): void {
    this.started = Date.now();
    this.timer = setTimeout(this.fire, Math.max(0, this.remaining));
    this.timer.unref();
  }
  dispose(): void {
    clearTimeout(this.timer);
  }
}
