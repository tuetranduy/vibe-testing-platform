/** Local administrator import of reviewed test code, never of verdicts or evidence.
 * pnpm exec tsx tests/shopware/import-native.ts import|status|suite|suite-status
 * Uses the platform repositories and its normal saved-test queue/runner. Original runs stay intact.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  createDb, EventRepository, GeneratedTestRepository, newId,
  RequirementRepository, RunRepository, SuiteRepository,
} from '@platform/db';
import { createRunQueue } from '@platform/event-bus';
import { GeneratedTestSchema, isTerminalLifecycle } from '@platform/contracts';
import { buildNative } from './build-native';

process.loadEnvFile('.env');
const output = new URL('../../.artifacts/shopware/', import.meta.url);
const cases = JSON.parse(await fs.readFile(new URL('./cases.json', import.meta.url), 'utf8'));
const discovery = JSON.parse(await fs.readFile(new URL('platform.json', output), 'utf8'));
const baseline = JSON.parse(await fs.readFile(new URL('baseline.json', output), 'utf8'));
const criterionSnapshot = JSON.parse(await fs.readFile(new URL('./native-criteria.json', import.meta.url), 'utf8'));
const handle = createDb(process.env.DATABASE_URL!);
const redis = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const queue = createRunQueue({ host: redis.hostname, port: Number(redis.port || 6379),
  db: Number(redis.pathname.slice(1) || 0), ...(redis.password ? { password: decodeURIComponent(redis.password) } : {}) });
let state: any;
try { state = JSON.parse(await fs.readFile(new URL('native.json', output), 'utf8')); }
catch (error: any) { if (error.code !== 'ENOENT') throw error; state = { runs: [] }; }
const save = () => fs.writeFile(new URL('native.json', output), JSON.stringify(state, null, 2) + '\n');
async function api(path: string, method = 'GET', body?: unknown, key?: string) {
  const response = await fetch((process.env.API_URL || 'http://localhost:3001') + path, {
    method, headers: { authorization: `Bearer ${process.env.API_TOKEN || 'dev-api-token-change-me-please'}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
try {
  const mode = process.argv[2] || 'status';
  if (mode === 'import') {
    for (const testCase of cases) {
      const verified = baseline.find((r: any) => r.id === testCase.id);
      assert(verified?.matchesBaseline && verified.checkpoints.length > 0 && ['PASSED', 'FAILED'].includes(verified.verdict), 'A directly verified baseline is required');
      const original = discovery.runs.find((r: any) => r.id === testCase.id);
      assert(original, 'Create the discovery run first');
      const runs = new RunRepository(handle.db);
      const parent = await runs.getById(original.runId);
      if (!isTerminalLifecycle(parent.lifecycle)) { console.log(`${testCase.id}: discovery still running`); continue; }
      assert(parent.targetUrl === testCase.targetUrl && parent.request.secretNames.length === 0);
      assert(parent.request.llm?.provider !== 'fake', 'Explicit source must use the real saved-test runner');
      const requirement = await new RequirementRepository(handle.db).getLatest(parent.id);
      assert(requirement.confirmedAt);
      assert.deepEqual(requirement.criteria.map(c => ({ id: c.id, statement: c.statement, expectedOutcome: c.expectedOutcome })),
        criterionSnapshot[testCase.id], 'The reviewed criterion mapping changed; review the recipe before importing');
      const built = buildNative(testCase.id, requirement, testCase.targetUrl);
      const { source } = built;
      const sha256 = createHash('sha256').update(JSON.stringify(built)).digest('hex');
      const previous = state.runs.find((r: any) => r.id === testCase.id && r.sha256 === sha256);
      if (previous) {
        const prior = await runs.getById(previous.runId);
        if (prior.lifecycle === 'QUEUED') await queue.enqueueRerun(previous.runId);
        continue;
      }
      await fs.writeFile(new URL(`${testCase.id}.safe-test.json`, output), JSON.stringify(built, null, 2) + '\n');
      const ids = [...source.matchAll(/test\.step\(['"]\[(AC-\d+)\]/g)].map(m => m[1]!);
      assert.deepEqual([...ids].sort(), requirement.criteria.map(c => c.id).sort(), 'Every confirmed criterion must have exactly one explicit assertion step');
      const key = `shopware-native-${testCase.id}-${sha256.slice(0, 16)}`;
      let run = await runs.findByIdempotencyKey(parent.tenantId, key);
      if (!run) {
        run = await handle.db.transaction(async tx => {
          const repo = new RunRepository(tx);
          await repo.lockTenant(parent.tenantId);
          if (await repo.countActive(parent.tenantId) >= Number(process.env.MAX_ACTIVE_RUNS_PER_TENANT || 3)) return null;
          const created = await repo.create({
            id: newId('run'), tenantId: parent.tenantId, targetUrl: parent.targetUrl,
            ownerUserId: parent.ownerUserId, comparisonKey: parent.comparisonKey,
            idempotencyKey: key, requestHash: sha256,
            request: { ...parent.request, rerunOf: parent.id, options: { ...parent.request.options, maxRunSeconds: 300 } },
          });
          await new RequirementRepository(tx).copyConfirmed(created.id, requirement);
          await new GeneratedTestRepository(tx).save(created.id, GeneratedTestSchema.parse({
            id: newId('gt'), ...built,
            compiledCriteria: ids, notCompiled: [],
            notes: [
              'Explicit Playwright test imported by the local administrator workflow; this code was not generated by the discovery model.',
              `Source: tests/shopware/build-native.ts recipe ${testCase.id}; SHA-256 ${sha256}`,
              `Direct baseline: ${verified.verdict} at ${verified.finishedAt}. Discovery source: ${parent.id}.`,
              'Every criterion is checked by its own test.step and the normal sandboxed Playwright runner. No verdict or evidence was imported.',
            ],
          }));
          await new EventRepository(tx).append({ runId: created.id, type: 'run.created', stage: 'QUEUED',
            message: 'Reviewed explicit Playwright test imported for execution', payload: { targetHost: new URL(parent.targetUrl).host } });
          return created;
        });
      }
      if (!run) { console.log(`${testCase.id}: platform capacity reached`); break; }
      const superseded = state.runs.filter((r: any) => r.id === testCase.id);
      state.attempts = [...(state.attempts || []), ...superseded];
      state.runs = state.runs.filter((r: any) => r.id !== testCase.id);
      state.runs.push({ id: testCase.id, runId: run.id, discoveryRunId: parent.id, sha256, expectedVerdict: testCase.expectedVerdict });
      await save();
      await queue.enqueueRerun(run.id);
      console.log(`${testCase.id}: imported ${run.id}`);
    }
  }
  for (const entry of state.runs) {
    const run = await new RunRepository(handle.db).getById(entry.runId);
    Object.assign(entry, { lifecycle: run.lifecycle, verdict: run.verdict });
    if (isTerminalLifecycle(run.lifecycle)) {
      const report = await api(`/v1/test-runs/${run.id}/report`);
      await fs.writeFile(new URL(`${entry.id}.native-report.json`, output), JSON.stringify(report, null, 2) + '\n');
      entry.summary = report.summary;
      entry.matchesBaseline = report.verdict === entry.expectedVerdict && report.summary.inconclusive === 0 && report.summary.blocked === 0;
    }
    console.log(JSON.stringify(entry));
  }
  await save();
  if (mode === 'suite') {
    assert(state.runs.length === cases.length && state.runs.every((r: any) => r.lifecycle === 'COMPLETED' && r.matchesBaseline), 'All explicit tests must finish and match before creating the verified suite');
    const first = await new RunRepository(handle.db).getById(state.runs[0].runId);
    const suites = new SuiteRepository(handle.db);
    const name = 'Shopware verified complex flows — 2026-11-09';
    const suite = await suites.findByName({ tenantId: first.tenantId }, name) || await suites.create({
      tenantId: first.tenantId, name, ownerUserId: first.ownerUserId, credentialProfileId: null,
      description: 'Four directly verified explicit Playwright tests. Cart, guest wishlist and registration pass; nonexistent search fails on four unrelated products. All checks executed in the platform runner. Original discovery reports preserved.',
    });
    state.suiteId = suite.id;
    // Pin these exact imported snapshots. The public Add to suite path canonicalizes ordinary
    // reruns back to their discovery root, whose generated assertions omitted some checks.
    const existing = await suites.entries(suite.id);
    for (const entry of state.runs) {
      if (!existing.some(e => e.sourceRunId === entry.runId)) {
        await suites.addEntry(suite.id, { sourceRunId: entry.runId, confirmDestructive: true, addedBy: null });
      }
    }
    await save();
    if (!state.suiteRunId) {
      const started = await api(`/v1/suites/${suite.id}/runs`, 'POST', {}, `shopware-native-suite-${suite.id}`);
      state.suiteRunId = started.suiteRunId;
      await save();
    }
    console.log(`Suite: http://localhost:3000/suites/${suite.id}`);
  }
  if (mode === 'suite-status' && state.suiteRunId) {
    const result = await api(`/v1/suite-runs/${state.suiteRunId}`);
    await fs.writeFile(new URL('native-suite-run.json', output), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ suiteRunId: result.id, status: result.status, verdict: result.verdict, counts: result.counts }));
    if (result.status === 'COMPLETED') {
      const verification = [];
      for (const child of result.children) {
        const entry = state.runs.find((r: any) => r.runId === child.sourceRunId);
        assert(entry, 'Unexpected suite source');
        const report = await api(`/v1/test-runs/${child.runId}/report`);
        const original = JSON.parse(await fs.readFile(new URL(`${entry.id}.native-report.json`, output), 'utf8'));
        const outcomes = (r: any) => r.criteria.map((c: any) => ({ id: c.criterionId, status: c.status })).sort((a: any, b: any) => a.id.localeCompare(b.id));
        assert.deepEqual(outcomes(report), outcomes(original), `${entry.id}: suite criterion outcomes diverged`);
        assert.equal(report.generatedTest.source, original.generatedTest.source, `${entry.id}: suite did not use the pinned source`);
        assert.equal(report.verdict, entry.expectedVerdict);
        assert.equal(report.summary.inconclusive, 0);
        assert.equal(report.summary.blocked, 0);
        assert.equal(report.summary.confirmedByRerun, report.summary.totalCriteria);
        await fs.writeFile(new URL(`${entry.id}.suite-report.json`, output), JSON.stringify(report, null, 2) + '\n');
        verification.push({ id: entry.id, runId: child.runId, verdict: report.verdict, ...report.summary });
      }
      assert.equal(verification.length, cases.length);
      state.suiteVerified = true;
      state.verification = verification;
      await save();
      await fs.writeFile(new URL('verification.json', output), JSON.stringify({ suiteId: state.suiteId, suiteRunId: state.suiteRunId, verifiedAt: new Date().toISOString(), cases: verification }, null, 2) + '\n');
      console.log('Verified: all suite sources and all criterion outcomes match the explicit baselines.');
    }
  }
} finally {
  await queue.close();
  await handle.close();
}
