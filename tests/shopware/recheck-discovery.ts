/** Re-plan/explore/compile/replay the original confirmed criteria. No test code or verdict is copied.
 * pnpm exec tsx tests/shopware/recheck-discovery.ts
 * SHOPWARE_RUN_SET=discovery-confirmed-v2 node tests/shopware/platform.mjs status|progress
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDb, EventRepository, newId, RequirementRepository, RunRepository, SiteAnalysisRepository } from '@platform/db';
import { createRunQueue } from '@platform/event-bus';

process.loadEnvFile('.env');
const output = new URL('../../.artifacts/shopware/discovery-confirmed-v2/', import.meta.url);
await fs.mkdir(output, { recursive: true });
const originals = JSON.parse(await fs.readFile(new URL('../../.artifacts/shopware/platform.json', import.meta.url), 'utf8'));
const handle = createDb(process.env.DATABASE_URL!);
const redis = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const queue = createRunQueue({ host: redis.hostname, port: Number(redis.port || 6379), db: Number(redis.pathname.slice(1) || 0),
  ...(redis.password ? { password: decodeURIComponent(redis.password) } : {}) });
let state: any;
try { state = JSON.parse(await fs.readFile(new URL('platform.json', output), 'utf8')); }
catch (error: any) { if (error.code !== 'ENOENT') throw error; state = { runs: [] }; }
const save = () => fs.writeFile(new URL('platform.json', output), JSON.stringify(state, null, 2) + '\n');
try {
  for (const original of originals.runs) {
    if (process.env.SHOPWARE_CASE_ID && process.env.SHOPWARE_CASE_ID !== original.id) continue;
    const old = state.runs.find((r: any) => r.id === original.id);
    if (old && !process.argv.includes('--retry')) {
      const run = await new RunRepository(handle.db).getById(old.runId);
      if (run.lifecycle === 'PLANNING') await queue.enqueueExecute(run.id);
      continue;
    }
    const parent = await new RunRepository(handle.db).getById(original.runId);
    assert(parent.lifecycle === 'COMPLETED' && !parent.request.rerunOf && parent.request.secretNames.length === 0);
    const requirement = await new RequirementRepository(handle.db).getLatest(parent.id);
    const analysis = await new SiteAnalysisRepository(handle.db).get(parent.id);
    assert(requirement.confirmedAt);
    const key = `shopware-discovery-confirmed-v${process.env.SHOPWARE_RECHECK_REVISION || '2'}-${original.id}`;
    let run = await new RunRepository(handle.db).findByIdempotencyKey(parent.tenantId, key);
    if (!run) {
      run = await handle.db.transaction(async tx => {
        const runs = new RunRepository(tx);
        await runs.lockTenant(parent.tenantId);
        if (await runs.countActive(parent.tenantId) >= Number(process.env.MAX_ACTIVE_RUNS_PER_TENANT || 3)) return null;
        const created = await runs.create({ tenantId: parent.tenantId, targetUrl: parent.targetUrl,
          request: parent.request, ownerUserId: parent.ownerUserId, comparisonKey: parent.comparisonKey, idempotencyKey: key, requestHash: key });
        await new EventRepository(tx).append({ runId: created.id, type: 'run.created', stage: 'QUEUED',
          message: `Discovery regression using the original confirmed criteria from ${parent.id}`, payload: { targetHost: new URL(parent.targetUrl).host } });
        await runs.transition(created.id, 'QUEUED', 'ANALYZING_REQUIREMENT');
        await new RequirementRepository(tx).copyConfirmed(created.id, requirement);
        if (analysis) await new SiteAnalysisRepository(tx).save(created.id, analysis);
        await new EventRepository(tx).append({ runId: created.id, type: 'criteria.confirmed', stage: 'ANALYZING_REQUIREMENT',
          message: 'Original confirmed criteria reused unchanged for discovery regression', payload: { revision: 1 } });
        return runs.transition(created.id, 'ANALYZING_REQUIREMENT', 'PLANNING', { heartbeatAt: new Date() });
      });
    }
    if (!run) { console.log(`${original.id}: waiting for platform capacity`); break; }
    if (old && old.runId !== run.id) {
      state.attempts = [...(state.attempts || []), old];
      state.runs = state.runs.filter((r: any) => r.id !== original.id);
    }
    if (!state.runs.some((r: any) => r.runId === run.id)) state.runs.push({ id: original.id, runId: run.id, originalRunId: parent.id, expectedVerdict: original.expectedVerdict });
    await save();
    await queue.enqueueExecute(run.id);
    console.log(`${original.id}: ${run.id} (${requirement.criteria.length} original criteria)`);
  }
} finally { await queue.close(); await handle.close(); }
