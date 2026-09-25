import type { EventDraft } from "@platform/testing-engine";
import type { EgressBlockEvent } from "./egress-proxy";

/**
 * Turns egress-proxy blocks into `egress.blocked` run events without letting a page flood the
 * timeline or the database: one event per host:port + reason, at most `maxEvents` per run, then a
 * single summary event and silence. Memory is bounded by `maxEvents`.
 */

export const DEFAULT_MAX_EGRESS_EVENTS = 20;
export const SUPPRESSED_MESSAGE = "Further blocked network requests were not reported";

export interface EgressEventReporterOptions {
  publish(event: EventDraft): Promise<void>;
  logger: { warn(obj: object, msg?: string): void };
  maxEvents?: number;
}

function hostPort(e: EgressBlockEvent): string {
  return e.host.includes(":") ? `[${e.host}]:${e.port}` : `${e.host}:${e.port}`;
}

export function createEgressEventReporter(opts: EgressEventReporterOptions): (e: EgressBlockEvent) => void {
  const max = opts.maxEvents ?? DEFAULT_MAX_EGRESS_EVENTS;
  const reported = new Set<string>();
  let suppressed = false;

  const publish = (event: EventDraft, context: { host: string; reason: string }) => {
    void opts.publish(event).catch((err: unknown) => {
      opts.logger.warn({ err, ...context }, "failed to publish egress.blocked event");
    });
  };

  return (e) => {
    // Chromium's own background services: the site under test didn't cause them.
    if (e.reason === "BACKGROUND_SERVICE_DENIED") return;
    const key = `${hostPort(e)}|${e.reason}`;
    if (reported.has(key) || suppressed) return;
    if (reported.size >= max) {
      suppressed = true;
      publish(
        { type: "egress.blocked", message: SUPPRESSED_MESSAGE, payload: { host: "*", reason: "SUPPRESSED" } },
        { host: "*", reason: "SUPPRESSED" },
      );
      return;
    }
    reported.add(key);
    publish(
      {
        type: "egress.blocked",
        message: `Blocked network access to ${hostPort(e)} (${e.reason})`,
        payload: { host: e.host, reason: e.reason },
      },
      { host: e.host, reason: e.reason },
    );
  };
}
