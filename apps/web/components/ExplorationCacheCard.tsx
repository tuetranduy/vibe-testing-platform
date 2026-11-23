"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { clearExplorationCache, getExplorationCache, type ExplorationCacheStats } from "../lib/api";
import { isAdminUser, useMe } from "../lib/me";
import { Icon } from "./Icon";
import { formatWhen } from "./report-format";

/**
 * Settings → Exploration cache (V1.1 F8): element lookups verified on earlier runs, reused when they still
 * match the page. Administrators can clear it, e.g. after a site redesign.
 */
export function ExplorationCacheCard() {
  const [stats, setStats] = useState<ExplorationCacheStats | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const admin = isAdminUser(useMe());

  useEffect(() => {
    let live = true;
    getExplorationCache().then(
      (s) => live && setStats(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  async function clear() {
    setError(null);
    try {
      const { deleted } = await clearExplorationCache();
      setStats({ entries: 0, hits: 0, lastUsedAt: null });
      setNotice(deleted === 1 ? "1 entry deleted." : `${deleted} entries deleted.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The cache couldn't be cleared.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Card as="section" className="stack-tight flex min-w-0 flex-col gap-3" aria-labelledby="cache-title">
      <h2 id="cache-title" className="card-title mb-3.5 text-sm font-semibold text-muted-foreground">
        Exploration cache
      </h2>
      <p className="text-muted-foreground">
        Where a run found an element on a page, later runs reuse that lookup instead of asking the AI — after checking it still points at
        the same element. Page values are never cached. Entries unused for 30 days are removed.
      </p>
      {stats && (
        <p>
          {stats.entries === 1 ? "1 entry" : `${stats.entries} entries`}, reused {stats.hits === 1 ? "once" : `${stats.hits} times`}
          {stats.lastUsedAt ? ` · last used ${formatWhen(stats.lastUsedAt)}` : ""}
        </p>
      )}
      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px">
          <Icon name="error" /> {error}
        </p>
      )}
      {admin &&
        (confirming ? (
          <div role="group" aria-labelledby="cache-clear-title" className="note note-warning">
            <p id="cache-clear-title" className="note-title">
              Clear the exploration cache?
            </p>
            <p>The next runs look every element up again with the AI.</p>
            <div className="actions flex flex-wrap items-center gap-2">
              <Button variant="destructive" type="button" onClick={() => void clear()}>
                Yes, clear it
              </Button>
              <Button variant="outline" type="button" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <div className="actions flex flex-wrap items-center gap-2">
            <Button variant="outline" type="button" onClick={() => setConfirming(true)} disabled={stats?.entries === 0}>
              Clear cache
            </Button>
            {notice && (
              <p role="status" className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">
                {notice}
              </p>
            )}
          </div>
        ))}
    </Card>
  );
}
