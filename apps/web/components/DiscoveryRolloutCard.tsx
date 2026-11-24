"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useEffect, useState } from "react";
import { getDiscoveryRollout, updateDiscoveryRollout } from "../lib/api";
import { isAdminUser, useMe } from "../lib/me";

export function DiscoveryRolloutCard() {
  const admin = isAdminUser(useMe());
  const [rollout, setRollout] = useState<Awaited<ReturnType<typeof getDiscoveryRollout>> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!admin) return;
    let active = true;
    getDiscoveryRollout().then((value) => { if (active) setRollout(value); }, () => {});
    return () => { active = false; };
  }, [admin]);

  if (!admin || !rollout?.available) return null;

  async function update(enabled: boolean) {
    setPending(true);
    setError(null);
    try {
      setRollout(await updateDiscoveryRollout(enabled));
    } catch {
      setError("Couldn’t save the Browser Use setting.");
    } finally {
      setPending(false);
    }
  }

  return <Card as="section" aria-labelledby="discovery-rollout-title">
    <h2 id="discovery-rollout-title" className="text-sm font-semibold">Browser Use fixture pilot</h2>
    <p role="status" className="text-sm text-muted-foreground">
      {rollout.enabled ? "Enabled for this tenant’s staging fixture." : "Disabled for this tenant."}
    </p>
    <div><Button variant="outline" type="button" disabled={pending} onClick={() => void update(!rollout.enabled)}>
      {rollout.enabled ? "Disable Browser Use" : "Enable Browser Use"}
    </Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </Card>;
}
