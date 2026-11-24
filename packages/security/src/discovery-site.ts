import { createHmac } from "node:crypto";
import { promises as dns } from "node:dns";

/** A DNS challenge is bound to a tenant and exact hostname, without sending a credential to the site. */
export function discoverySiteChallenge(key: Buffer, tenantId: string, hostname: string) {
  const digest = createHmac("sha256", key).update(JSON.stringify(["discovery-site/v1", tenantId, hostname])).digest("base64url");
  return { name: `_vibe-testing.${hostname}`, value: `vibe-testing=${digest}` };
}

export async function discoverySiteVerified(
  challenge: ReturnType<typeof discoverySiteChallenge>,
  resolveTxt: (name: string) => Promise<string[][]> = (name) => new dns.Resolver({ timeout: 2000, tries: 1 }).resolveTxt(name),
): Promise<boolean> {
  try {
    return (await resolveTxt(challenge.name)).some((record) => record.join("") === challenge.value);
  } catch {
    return false;
  }
}
