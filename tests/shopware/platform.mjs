// Register verified live cases through the same public API used by the platform.
// node tests/shopware/platform.mjs submit|status|progress
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url);
const runSet = process.env.SHOPWARE_RUN_SET || '';
if (runSet && !/^[a-z0-9-]+$/.test(runSet)) throw new Error('Invalid run set');
const output = new URL(`.artifacts/shopware/${runSet ? runSet + '/' : ''}`, root);
await fs.mkdir(output, { recursive: true });
const env = await fs.readFile(new URL('.env', root), 'utf8');
const token = process.env.API_TOKEN || env.match(/^API_TOKEN=(.*)$/m)?.[1]?.replace(/^['"]|['"]$/g, '') || 'dev-api-token-change-me-please';
const api = process.env.API_URL || 'http://localhost:3001';
async function request(path, method = 'GET', body, key) {
  const response = await fetch(api + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${path}: ${response.status} ${text}`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}
const cases = JSON.parse(await fs.readFile(new URL('tests/shopware/cases.json', root), 'utf8'));
let state;
try { state = JSON.parse(await fs.readFile(new URL('platform.json', output), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { runs: [] }; }
async function save() { await fs.writeFile(new URL('platform.json', output), JSON.stringify(state, null, 2) + '\n'); }
const mode = process.argv[2] || 'status';
if (mode === 'progress') {
  await Promise.all(state.runs.map(async entry => {
    const response = await fetch(`${api}/v1/test-runs/${entry.runId}/events`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000),
    });
    let buffer = '';
    try { for await (const chunk of response.body) buffer += new TextDecoder().decode(chunk); }
    catch (error) { if (error.name !== 'TimeoutError' && error.name !== 'AbortError') throw error; }
    const events = buffer.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
    await fs.writeFile(new URL(`${entry.id}.events.json`, output), JSON.stringify(events, null, 2) + '\n');
    console.log(entry.id, JSON.stringify(events.slice(-4).map(e => ({ type: e.type, stage: e.stage, message: e.message }))));
  }));
  process.exit(0);
}
if (mode === 'submit') {
  const baseline = JSON.parse(await fs.readFile(new URL('.artifacts/shopware/baseline.json', root), 'utf8'));
  for (const testCase of cases) {
    if (state.runs.some(r => r.id === testCase.id)) continue;
    const verified = baseline.find(r => r.id === testCase.id && r.matchesBaseline);
    if (!verified) { console.log(`${testCase.id}: awaiting direct verification`); continue; }
    let created;
    try { created = await request('/v1/test-runs', 'POST', {
      targetUrl: testCase.targetUrl, requirement: testCase.requirement,
      environment: 'production',
      options: { autoConfirmCriteria: true, maxExplorationSteps: 100, maxRunSeconds: 1200,
        ...(process.env.SHOPWARE_SKIP_SURVEY === '1' ? { analyzeLiveSite: false } : {}),
        allowDestructiveActions: true, confirmProductionHost: 'frontends-demo.vercel.app',
        generatePlaywright: true, rerunGeneratedTest: true, recordTrace: true, recordVideo: true },
    }, `shopware-verified-20261109-${runSet ? runSet + '-' : ''}${testCase.id}`); }
    catch (error) {
      if (error.status !== 429) throw error;
      console.log(`${testCase.id}: platform capacity reached; submit again when a slot opens`);
      break;
    }
    state.runs.push({ id: testCase.id, runId: created.runId, expectedVerdict: testCase.expectedVerdict });
    await save();
    console.log(`${testCase.id}: created ${created.runId}`);
  }
}
for (const entry of state.runs) {
  const run = await request(`/v1/test-runs/${entry.runId}`);
  Object.assign(entry, { lifecycle: run.lifecycle, verdict: run.verdict, errorCategory: run.errorCategory });
  if (['COMPLETED', 'ERRORED', 'CANCELLED'].includes(run.lifecycle)) {
    const report = await request(`/v1/test-runs/${entry.runId}/report`);
    await fs.writeFile(new URL(`${entry.id}.platform-report.json`, output), JSON.stringify(report, null, 2) + '\n');
    entry.matchesBaseline = entry.verdict === entry.expectedVerdict;
    entry.generated = Boolean(report.generatedTest?.source);
    entry.compiledCriteria = report.generatedTest?.compiledCriteria.length ?? 0;
    entry.notCompiled = report.generatedTest?.notCompiled ?? [];
    entry.summary = report.summary;
    entry.allChecksReplayed = report.summary.totalCriteria > 0
      && report.summary.confirmedByRerun === report.summary.totalCriteria
      && entry.compiledCriteria === report.summary.totalCriteria;
    entry.criteria = report.criteria?.map(c => ({ id: c.criterionId, status: c.status, reason: c.reason, verdictSource: c.verdictSource }));
  }
  console.log(JSON.stringify({ ...entry, criteria: undefined }));
}
await save();
if (mode === 'collect') {
  assert(state.runs.length === cases.length && state.runs.every(r => r.lifecycle === 'COMPLETED' && r.matchesBaseline && r.allChecksReplayed), 'Every discovery criterion must match and be replay-confirmed before collecting');
  for (const run of state.runs) {
    if (!run.originalRunId) continue;
    const original = await request(`/v1/test-runs/${run.originalRunId}/criteria`);
    const report = JSON.parse(await fs.readFile(new URL(`${run.id}.platform-report.json`, output), 'utf8'));
    assert.deepEqual(report.requirement.criteria, original.criteria, 'Original criteria changed');
    assert.deepEqual(report.requirement.facts, original.facts, 'Original fact requests changed');
    assert.equal(report.rerunOf, null, 'Expected a real discovery run');
    assert(report.usage.llmCalls > 0, 'Expected real AI planning/exploration');
    assert(report.criteria.every(c => c.verdictSource === 'PLAYWRIGHT_RERUN'), 'Every result must be replay-backed');
  }
  if (!state.suiteId) {
    const suite = await request('/v1/suites', 'POST', { name: `Shopware AI discovery regression — ${runSet || 'baseline'}`,
      description: 'Original confirmed criteria re-planned, explored, compiled and replayed by the AI discovery engine. No explicit test code or verdict imported. Includes the real nonexistent-search failure.' });
    state.suiteId = suite.id;
    await save();
  }
  const detail = await request(`/v1/suites/${state.suiteId}`);
  for (const run of cases.map(c => state.runs.find(r => r.id === c.id))) {
    if (!detail.entries.some(e => e.sourceRunId === run.runId)) {
      await request(`/v1/suites/${state.suiteId}/entries`, 'POST', { sourceRunId: run.runId, confirmDestructiveActions: true });
    }
  }
  if (!state.suiteRunId) {
    state.suiteRunId = (await request(`/v1/suites/${state.suiteId}/runs`, 'POST', {}, `shopware-discovery-suite-${state.suiteId}`)).suiteRunId;
    await save();
  }
  console.log(`Suite: http://localhost:3000/suites/${state.suiteId}`);
}
if (mode === 'suite-status' && state.suiteRunId) {
  const suite = await request(`/v1/suite-runs/${state.suiteRunId}`);
  await fs.writeFile(new URL('suite-run.json', output), JSON.stringify(suite, null, 2) + '\n');
  console.log(JSON.stringify({ status: suite.status, verdict: suite.verdict, counts: suite.counts }));
  if (suite.status === 'COMPLETED') {
    const verified = [];
    for (const child of suite.children) {
      const entry = state.runs.find(r => r.runId === child.sourceRunId);
      assert(entry, 'Unexpected suite source');
      const report = await request(`/v1/test-runs/${child.runId}/report`);
      const source = JSON.parse(await fs.readFile(new URL(`${entry.id}.platform-report.json`, output), 'utf8'));
      assert.equal(report.verdict, entry.expectedVerdict);
      assert.equal(report.generatedTest.source, source.generatedTest.source);
      const statuses = r => r.criteria.map(c => ({ id: c.criterionId, status: c.status })).sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(statuses(report), statuses(source));
      assert.equal(report.summary.confirmedByRerun, report.summary.totalCriteria);
      assert.equal(report.summary.inconclusive, 0);
      assert.equal(report.summary.blocked, 0);
      await fs.writeFile(new URL(`${entry.id}.suite-report.json`, output), JSON.stringify(report, null, 2) + '\n');
      verified.push({ id: entry.id, runId: child.runId, verdict: report.verdict, ...report.summary });
    }
    assert.equal(verified.length, cases.length);
    await fs.writeFile(new URL('verification.json', output), JSON.stringify({ suiteId: state.suiteId, suiteRunId: state.suiteRunId, verifiedAt: new Date().toISOString(), cases: verified }, null, 2) + '\n');
    console.log('Verified: every AI-generated suite assertion matches the discovery result.');
  }
}
