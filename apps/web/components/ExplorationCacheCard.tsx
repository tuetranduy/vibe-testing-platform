"use client";

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
    <section className="card stack-tight" aria-labelledby="cache-title">
      <h2 id="cache-title" className="card-title">
        Exploration cache
      </h2>
      <p className="muted">
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
        <p role="alert" className="field-error">
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
            <div className="actions">
              <button type="button" className="button button-danger" onClick={() => void clear()}>
                Yes, clear it
              </button>
              <button type="button" className="button button-secondary" onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button type="button" className="button button-secondary" onClick={() => setConfirming(true)} disabled={stats?.entries === 0}>
              Clear cache
            </button>
            {notice && (
              <p role="status" className="hint">
                {notice}
              </p>
            )}
          </div>
        ))}
    </section>
  );
}
