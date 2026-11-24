import type { Env } from "./env";

/** Non-secret: which tenants may opt a run into discovery, and on which disposable fixture. */
export interface DiscoveryAdmission {
  fixtureUrl: string;
  tenantIds: readonly string[];
}

export type DiscoveryAdmissionEnv = Pick<Env, "BROWSER_USE_DISCOVERY_FIXTURE_URL" | "BROWSER_USE_DISCOVERY_TENANTS" | "DEFAULT_TENANT_ID">;

/** The worker's transport to the trusted broker. The service token never needs to reach the API. */
export type DiscoveryTransportEnv = Pick<Env,
  "BROWSER_USE_DISCOVERY_LAUNCHER" | "BROWSER_USE_DISCOVERY_SERVICE_URL" | "BROWSER_USE_DISCOVERY_SERVICE_TOKEN" |
  "BROWSER_USE_DISCOVERY_TENANT_HOURLY_LIMIT" | "BROWSER_USE_DISCOVERY_CAPACITY"
>;

export type DiscoveryEnv = DiscoveryAdmissionEnv & DiscoveryTransportEnv;

/** API and worker: admission from the fixture URL and tenant allowlist alone (no transport or credential). */
export function discoveryAdmission(env: Partial<DiscoveryAdmissionEnv>): DiscoveryAdmission | undefined {
  if (!env.BROWSER_USE_DISCOVERY_FIXTURE_URL || !env.DEFAULT_TENANT_ID) return;
  return {
    fixtureUrl: env.BROWSER_USE_DISCOVERY_FIXTURE_URL,
    tenantIds: env.BROWSER_USE_DISCOVERY_TENANTS ?? [env.DEFAULT_TENANT_ID],
  };
}
