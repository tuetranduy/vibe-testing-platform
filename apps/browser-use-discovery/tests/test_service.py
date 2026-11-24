import pytest
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import json
from discovery_service.protocol import parse_request
import secrets
import time

from starlette.testclient import TestClient

from discovery_service.launcher import Config
from discovery_service.protocol import DiscoveryResponse
from discovery_service.service import NonceCache, create_app, signed_message

SECRET = 'local-test-discovery-token-32-characters'
BASE = '/internal/v1/discoveries'
FIXTURE = 'http://127.0.0.1:4599/'
INPUT = {'schemaVersion': 'discovery.v1', 'runId': 'run_fixture', 'targetUrl': FIXTURE}


def body_of(value) -> bytes:
    return json.dumps(value).encode()


def headers(method, path, body=b'', *, key=None, age=0, nonce=None, run_id='run_fixture'):
    """A fresh signature (new nonce) for this exact method, path, idempotency key and body."""
    timestamp = str(int(time.time()) - age)
    nonce = nonce or secrets.token_hex(16)
    key = f'{run_id}:discovery.v1' if key is None and method == 'POST' else (key or '')
    signature = hmac.new(SECRET.encode(), signed_message(method, path, timestamp, nonce, key, body), hashlib.sha256).hexdigest()
    return {'Authorization': f'Bearer {timestamp}.{nonce}.{signature}', **({'Idempotency-Key': key} if key else {})}


def post(client, value, **kwargs):
    raw = body_of(value)
    return client.post(BASE, content=raw, headers={**headers('POST', BASE, raw, **kwargs), 'content-type': 'application/json'})


def get(client, path, **kwargs):
    return client.get(path, headers=headers('GET', path, **kwargs))


def delete(client, path):
    return client.delete(path, headers=headers('DELETE', path))


def test_job_auth_idempotency_progress_backpressure_and_cancellation():
    calls = []

    async def runner(request, _config, on_progress):
        calls.append(request)
        on_progress(2)
        await asyncio.Event().wait()

    with TestClient(create_app(Config(FIXTURE, 'scripted'), SECRET, runner=runner)) as client:
        assert client.get('/internal/health').status_code == 200
        assert client.post(BASE, json=INPUT).status_code == 401
        assert post(client, INPUT, age=61).status_code == 401
        assert post(client, {**INPUT, 'targetUrl': FIXTURE + 'other'}).status_code == 422
        assert post(client, INPUT).status_code == 202
        assert post(client, INPUT).status_code == 202
        assert post(client, {**INPUT, 'timeoutSeconds': 60}).status_code == 409
        assert len(calls) == 1
        assert post(client, {**INPUT, 'runId': 'run_other'}, run_id='run_other').status_code == 429
        path = BASE + '/run_fixture'
        assert client.get(path + '/events', headers=headers('GET', path)).status_code == 401
        assert get(client, path + '/events').json() == {'agentSteps': 2}
        cancelled = delete(client, path)
        assert cancelled.json()['result']['status'] == 'CANCELLED'
        assert cancelled.json()['result']['reason'] == 'cancelled'
        assert delete(client, path).json() == cancelled.json()


def test_signatures_bind_body_key_and_nonce_and_refuse_replays():
    async def runner(request, _config, on_progress):
        await asyncio.Event().wait()

    with TestClient(create_app(Config(FIXTURE, 'scripted'), SECRET, runner=runner)) as client:
        raw = body_of(INPUT)
        signed = {**headers('POST', BASE, raw), 'content-type': 'application/json'}
        # The same header with another body (another run's budget) is refused.
        other = body_of({**INPUT, 'runId': 'run_other'})
        assert client.post(BASE, content=other, headers={**signed, 'Idempotency-Key': 'run_other:discovery.v1'}).status_code == 401
        assert client.post(BASE, content=body_of({**INPUT, 'timeoutSeconds': 30}), headers=signed).status_code == 401
        # The idempotency key is signed too.
        assert client.post(BASE, content=raw, headers={**signed, 'Idempotency-Key': 'run_x:discovery.v1'}).status_code == 401
        assert client.post(BASE, content=raw, headers=signed).status_code == 202
        # Replaying the accepted request is refused, even though the signature is valid.
        assert client.post(BASE, content=raw, headers=signed).status_code == 401
        path = BASE + '/run_fixture'
        # A status signature does not authorize cancellation of the same path, and a cancel cannot be replayed.
        status = headers('GET', path)
        assert client.delete(path, headers=status).status_code == 401
        cancel = headers('DELETE', path)
        assert client.delete(path, headers=cancel).status_code == 200
        assert client.delete(path, headers=cancel).status_code == 401
        # Malformed shapes, a future timestamp and a body on a status read.
        assert client.get(path, headers={'Authorization': 'Bearer 123.abc.def'}).status_code == 401
        assert get(client, path, age=-61).status_code == 401
        assert client.request('GET', path, content=b'{}', headers=headers('GET', path, b'{}')).status_code == 400


def test_nonce_cache_is_bounded_and_expires():
    cache = NonceCache(limit=2)
    assert cache.claim('a' * 32, 0) is True
    assert cache.claim('a' * 32, 1) is False
    assert cache.claim('b' * 32, 1) is True
    assert cache.claim('c' * 32, 2) is None  # full of live nonces: refuse rather than forget one
    assert cache.claim('c' * 32, 1000) is True  # expired entries make room
    assert cache.claim('a' * 32, 1000) is True


def test_job_returns_a_typed_final_response_and_rejects_unbounded_input():
    async def runner(request, _config, on_progress):
        on_progress(1)
        return DiscoveryResponse(runId=request.runId, status='PARTIAL', reason='timeout'), {}

    with TestClient(create_app(Config(FIXTURE, 'scripted'), SECRET, runner=runner)) as client:
        big = b'x' * 20000
        assert client.post(BASE, content=big, headers=headers('POST', BASE, big)).status_code == 413
        assert post(client, {**INPUT, 'maxAgentSteps': 61}).status_code == 422
        assert post(client, {**INPUT, 'timeoutSeconds': 9}).status_code == 422
        assert post(client, INPUT).status_code == 202
        path = BASE + '/run_fixture'
        assert get(client, path).json() == {
            'jobId': 'run_fixture', 'agentSteps': 1,
            'result': {'schemaVersion': 'discovery.v1', 'runId': 'run_fixture', 'status': 'PARTIAL', 'reason': 'timeout',
                       'candidates': []},
        }


def test_cleanup_failures_are_counted_for_health():
    async def runner(request, _config, on_progress):
        return DiscoveryResponse(runId=request.runId, status='FAILED', reason='no_result'), {'cleanup': 'failed'}

    with TestClient(create_app(Config(FIXTURE, 'scripted'), SECRET, runner=runner)) as client:
        assert post(client, INPUT).status_code == 202
        assert get(client, BASE + '/run_fixture').json()['result']['reason'] == 'no_result'
        assert client.get('/internal/health').json() == {'status': 'ready', 'activeJobs': 0, 'jobSlots': 1, 'cleanupFailures': 1, 'defaultModel': 'ready'}


def test_health_reports_the_single_slot_and_the_active_job():
    release = asyncio.Event()

    async def runner(request, _config, on_progress):
        await release.wait()
        return DiscoveryResponse(runId=request.runId, status='PARTIAL'), {}

    with TestClient(create_app(Config(FIXTURE, 'scripted'), SECRET, runner=runner)) as client:
        assert client.get('/internal/health').json() == {'status': 'ready', 'activeJobs': 0, 'jobSlots': 1, 'cleanupFailures': 0, 'defaultModel': 'ready'}
        assert post(client, INPUT).status_code == 202
        assert client.get('/internal/health').json()['activeJobs'] == 1
        assert delete(client, BASE + '/run_fixture').status_code == 200
        assert client.get('/internal/health').json()['activeJobs'] == 0


def test_overlapping_submitters_get_one_run_and_bounded_backpressure():
    started = []

    async def runner(request, _config, _on_progress=None, **_kwargs):
        started.append(request.runId)
        await asyncio.Event().wait()

    def submit(client, run_id):
        return post(client, {**INPUT, 'runId': run_id}, run_id=run_id).status_code

    with TestClient(create_app(Config(FIXTURE, 'scripted'), SECRET, runner=runner)) as client:
        with ThreadPoolExecutor(max_workers=10) as pool:
            statuses = list(pool.map(lambda i: submit(client, f'load-{i}'), range(24)))
        assert statuses.count(202) == 1
        assert statuses.count(429) == 23
        assert len(started) == 1
        with ThreadPoolExecutor(max_workers=10) as pool:
            duplicate = list(pool.map(lambda _: submit(client, started[0]), range(24)))
        assert duplicate == [202] * 24
        assert len(started) == 1


def test_expired_results_are_unavailable_and_release_their_registry_slot(monkeypatch):
    monkeypatch.setattr('discovery_service.service.RESULT_TTL_SECONDS', 0)
    monkeypatch.setattr('discovery_service.service.JOB_LIMIT', 1)

    async def runner(request, _config, on_progress):
        return DiscoveryResponse(runId=request.runId, status='PARTIAL'), {}

    with TestClient(create_app(Config(FIXTURE, 'scripted'), SECRET, runner=runner)) as client:
        assert post(client, INPUT).status_code == 202
        path = BASE + '/run_fixture'
        assert get(client, path).status_code == 404
        assert post(client, {**INPUT, 'runId': 'run_next'}, run_id='run_next').status_code == 202


def test_signature_golden_vector_matches_the_worker_client():
    # The same vector is asserted in apps/worker/src/discovery-client.test.ts.
    message = signed_message('POST', '/internal/v1/discoveries', '1764000000', '0123456789abcdef0123456789abcdef',
                             'run_fixture:discovery.v1', b'{"runId":"run_fixture"}')
    signature = hmac.new(b'golden-vector-token-of-32-characters!!', message, hashlib.sha256).hexdigest()
    assert signature == '428bee0cd490a7181fa39d355cd20400df9d0d9064d22a3d44f23f3ec1fcdbba'


def test_job_slots_allow_parallel_agents_up_to_the_configured_limit():
    from discovery_service.service import job_slots

    async def runner(request, _config, on_progress):
        await asyncio.Event().wait()

    with TestClient(create_app(Config(FIXTURE, 'scripted'), SECRET, runner=runner, slots=2)) as client:
        assert post(client, INPUT).status_code == 202
        assert post(client, {**INPUT, 'runId': 'run_fixture-a2'}, run_id='run_fixture-a2').status_code == 202
        assert post(client, {**INPUT, 'runId': 'run_fixture-a3'}, run_id='run_fixture-a3').status_code == 429
        assert client.get('/internal/health').json()['jobSlots'] == 2
    assert job_slots(None) == 1 and job_slots('3') == 3
    for bad in ('0', '4', 'two'):
        with pytest.raises(ValueError):
            job_slots(bad)


def test_a_missing_provider_key_is_not_configured_not_an_agent_crash(monkeypatch):
    """Production 2026-11-24: DEEPSEEK_API_KEY was unset, Pydantic AI raised UserError (a RuntimeError), and the job
    service reported FAILED / agent_error a second after the start. It is a configuration state, and health says so."""
    from discovery_service.launcher import discover

    monkeypatch.delenv('DEEPSEEK_API_KEY', raising=False)
    request = parse_request(json.dumps(INPUT).encode())
    resp, stats = asyncio.run(discover(request, Config(FIXTURE, 'deepseek:deepseek-flash')))
    assert (resp.status, resp.reason, stats['reason']) == ('BLOCKED', 'model_not_configured', 'model_not_configured')
    with TestClient(create_app(Config(FIXTURE, 'deepseek:deepseek-flash'), SECRET)) as client:
        assert client.get('/internal/health').json()['defaultModel'] == 'not_configured'
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'sk-test-not-used')
    with TestClient(create_app(Config(FIXTURE, 'deepseek:deepseek-flash'), SECRET)) as client:
        assert client.get('/internal/health').json()['defaultModel'] == 'ready'



def test_a_job_uses_the_runs_own_model_and_settings_key_not_the_environment(monkeypatch):
    """The run's model and key (the platform's Settings, as Stagehand uses them) build this job's client; the key is
    hidden in every representation and never reaches the agent container's start frame."""
    from discovery_service import launcher
    from discovery_service.protocol import DiscoveryModel

    monkeypatch.delenv('DEEPSEEK_API_KEY', raising=False)
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    built = {}

    def fake_run_model(run_model):
        built['spec'], built['key'] = run_model.spec, run_model.apiKey.get_secret_value()
        raise RuntimeError('stop before docker')  # classified like any model that cannot be built

    monkeypatch.setattr(launcher, 'make_run_model', fake_run_model)
    body = {**INPUT, 'model': {'provider': 'anthropic', 'model': 'claude-sonnet-5-5', 'apiKey': 'sk-ant-run-key-1234'}}
    request = parse_request(json.dumps(body).encode())
    assert 'sk-ant-run-key-1234' not in repr(request) and 'sk-ant-run-key-1234' not in request.model_dump_json()
    resp, stats = asyncio.run(launcher.discover(request, Config(FIXTURE, 'deepseek:deepseek-flash')))
    assert built == {'spec': 'anthropic:claude-sonnet-5-5', 'key': 'sk-ant-run-key-1234'}
    assert (resp.status, resp.reason) == ('BLOCKED', 'model_not_configured')
    assert 'sk-ant-run-key-1234' not in json.dumps(stats) and 'sk-ant-run-key-1234' not in resp.line()
    with pytest.raises(ValueError):
        parse_request(json.dumps({**INPUT, 'model': {'provider': 'openai', 'model': 'x', 'apiKey': 'sk-0123456789'}}).encode())
