import type { DiscoveryInput, DiscoveryResult } from "@platform/contracts";

export interface AutonomousDiscoveryPort {
  discover(input: DiscoveryInput, context: { signal: AbortSignal }): Promise<DiscoveryResult>;
}
