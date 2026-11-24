import type { DiscoveryInput, DiscoveryResult } from "@platform/contracts";

export interface AutonomousDiscoveryPort {
  discover(input: DiscoveryInput, context: { signal: AbortSignal; onProgress?: (steps: number) => Promise<void> }): Promise<DiscoveryResult>;
}

/**
 * A discovery attempt that ended without a broker result. `busy`: the broker had no capacity (backpressure, not a
 * fault). `unavailable`: the transport failed or the broker is cooling down. `invalid_result`: the reply broke the
 * contract. Other errors are treated as `unavailable`.
 */
export type DiscoveryPortFailure = "busy" | "unavailable" | "invalid_result";

export class DiscoveryPortError extends Error {
  constructor(readonly failure: DiscoveryPortFailure, message: string) {
    super(message);
    this.name = "DiscoveryPortError";
  }
}
