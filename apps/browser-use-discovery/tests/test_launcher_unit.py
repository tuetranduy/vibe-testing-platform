import asyncio

from discovery_service.launcher import Config, discover, docker_args
from discovery_service.policy import match_target
from discovery_service.protocol import DiscoveryRequest


def test_docker_args_isolation():
    cfg = Config(fixture_url='http://127.0.0.1:4599/', model='scripted')
    args = docker_args(cfg, match_target(cfg.fixture_url, cfg.fixture_url), 'n', 0)
    joined = ' '.join(args)
    for flag in ('--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges',
                 '--user 10001:10001', '--pids-limit', '--memory 2g', '--rm', '--pull never'):
        assert flag in joined
    envs = [args[i + 1] for i, a in enumerate(args) if a == '-e']
    assert all(e.split('=')[0] in {'HOME', 'TMPDIR', 'ANONYMIZED_TELEMETRY', 'BH_TELEMETRY', 'BROWSER_USE_UPDATE_CHECK',
                                   'PYTHONDONTWRITEBYTECODE'} for e in envs)
    assert not any(a.startswith(('--env-file', '-v', '--volume', '--mount', '--privileged', '--network=host')) for a in args)
    assert '--add-host' not in args


def test_hostname_alias():
    cfg = Config(fixture_url='http://fixture.test:8080/', model='scripted')
    args = docker_args(cfg, match_target(cfg.fixture_url, cfg.fixture_url), 'n', 0)
    assert 'fixture.test:127.0.0.1' in args


def test_mismatched_target_blocked_before_docker():
    cfg = Config(fixture_url='http://127.0.0.1:4599/', model='scripted', docker='/nonexistent/docker')
    req = DiscoveryRequest(schemaVersion='discovery.v1', runId='r1', targetUrl='http://example.com/')
    resp, stats = asyncio.run(discover(req, cfg))
    assert resp.status == 'BLOCKED' and resp.candidates == [] and stats['reason'] == 'target_not_allowed'


def test_unconfigured_model_blocked():
    cfg = Config(fixture_url='http://127.0.0.1:4599/', model='', docker='/nonexistent/docker')
    req = DiscoveryRequest(schemaVersion='discovery.v1', runId='r1', targetUrl='http://127.0.0.1:4599/')
    resp, stats = asyncio.run(discover(req, cfg))
    assert resp.status == 'BLOCKED' and stats['reason'] == 'model_not_configured'


def test_docker_missing_fails_cleanly():
    cfg = Config(fixture_url='http://127.0.0.1:4599/', model='scripted', docker='/nonexistent/docker')
    req = DiscoveryRequest(schemaVersion='discovery.v1', runId='r1', targetUrl='http://127.0.0.1:4599/')
    resp, stats = asyncio.run(discover(req, cfg))
    assert resp.status == 'FAILED' and stats['reason'] == 'docker_unavailable'


def _fake_docker(tmp_path, body: str):
    script = tmp_path / 'docker'
    script.write_text('#!/bin/sh\n' + body)
    script.chmod(0o755)
    return str(script)


def test_container_removal_does_not_block_the_event_loop(tmp_path):
    from discovery_service.launcher import remove_container

    slow = Config('http://127.0.0.1:4599/', 'scripted', docker=_fake_docker(tmp_path, 'sleep 0.6\nexit 0\n'))

    async def scenario():
        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        task = asyncio.ensure_future(ticker())
        removed = await remove_container(slow, 'vtp-discovery-x')
        task.cancel()
        return removed, ticks

    removed, ticks = asyncio.run(scenario())
    assert removed is True
    assert ticks >= 20  # the loop kept serving other work while Docker removed the container


def test_container_removal_is_verified(tmp_path, monkeypatch):
    from discovery_service.launcher import remove_container

    monkeypatch.setattr('discovery_service.launcher.CLEANUP_TIMEOUT_S', 1.0)

    gone = Config('http://127.0.0.1:4599/', 'scripted',
                  docker=_fake_docker(tmp_path, 'echo "Error: No such container: x" >&2\nexit 1\n'))
    assert asyncio.run(remove_container(gone, 'x')) is True
    (tmp_path / 'docker').unlink()
    broken = Config('http://127.0.0.1:4599/', 'scripted', docker=_fake_docker(tmp_path, 'echo "daemon error" >&2\nexit 1\n'))
    assert asyncio.run(remove_container(broken, 'x')) is False  # never confirmed gone within the bound
    (tmp_path / 'docker').unlink()
    # Docker's own --rm removal is in progress: wait until the container is gone.
    racing = Config('http://127.0.0.1:4599/', 'scripted', docker=_fake_docker(tmp_path, (
        'if [ "$1" = rm ]; then echo "Error: removal of container x is already in progress" >&2; exit 1; fi\n'
        'echo "Error: No such object: x" >&2\nexit 1\n')))
    assert asyncio.run(remove_container(racing, 'x')) is True
    assert asyncio.run(remove_container(Config('http://127.0.0.1:4599/', 'scripted', docker='/nonexistent/docker'), 'x')) is False


def test_caller_budget_bounds_the_agent_and_the_whole_job(tmp_path):
    import time

    from discovery_service.broker import Broker, make_model
    from discovery_service.launcher import DELIVERY_MARGIN_S, STARTUP_RESERVE_S, Session

    cfg = Config('http://127.0.0.1:4599/', 'scripted')
    target = match_target(cfg.fixture_url, cfg.fixture_url)
    request = DiscoveryRequest(schemaVersion='discovery.v1', runId='r1', targetUrl=cfg.fixture_url, timeoutSeconds=60)
    session = Session(cfg, request, target, Broker(make_model('scripted')), deadline=time.monotonic() + 60)
    assert 60 - STARTUP_RESERVE_S - DELIVERY_MARGIN_S - 1 <= session.agent_timeout() <= 60 - STARTUP_RESERVE_S - DELIVERY_MARGIN_S
    assert Session(cfg, request, target, Broker(make_model('scripted')), deadline=time.monotonic() + 3).agent_timeout() == 5
    assert Session(cfg, request, target, Broker(make_model('scripted'))).agent_timeout() == 120


def test_a_hung_container_ends_at_the_caller_budget_as_a_hard_deadline(tmp_path):
    import time

    log = tmp_path / 'calls'
    docker = _fake_docker(tmp_path, f'echo "$1" >> {log}\nif [ "$1" = run ]; then exec sleep 30; fi\nexit 0\n')
    cfg = Config('http://127.0.0.1:4599/', 'scripted', docker=docker)
    # Below the wire minimum on purpose: the budget is what is under test, not request validation.
    request = DiscoveryRequest.model_construct(schemaVersion='discovery.v1', runId='r1', targetUrl=cfg.fixture_url,
                                               timeoutSeconds=1, maxAgentSteps=None)
    started = time.monotonic()
    response, stats = asyncio.run(discover(request, cfg))
    elapsed = time.monotonic() - started
    assert response.status == 'FAILED' and response.reason == 'hard_deadline' and stats['reason'] == 'hard_deadline'
    assert response.wire()['reason'] == 'hard_deadline'
    assert elapsed < 8
    assert stats['cleanup'] == 'ok' and 'rm' in log.read_text().split()


def test_docker_memory_usage_parsing():
    from discovery_service.launcher import parse_memory_usage

    assert parse_memory_usage('123.5MiB / 2GiB') == int(123.5 * 1024**2)
    assert parse_memory_usage('1.2GiB / 2GiB') == int(1.2 * 1024**3)
    assert parse_memory_usage('512KiB / 2GiB') == 512 * 1024
    assert parse_memory_usage('900MB / 2GB') == 900 * 1000**2
    assert parse_memory_usage('0B / 0B') == 0
    for bad in ('', '--', 'lots / 2GiB', '12XB / 1GiB', '-1MiB / 2GiB'):
        assert parse_memory_usage(bad) is None


def test_the_launcher_samples_the_agent_containers_peak_memory(tmp_path, monkeypatch):
    """Host-side samples of the job's own container; the peak (not the last value) is reported."""
    monkeypatch.setattr('discovery_service.launcher.MEMORY_SAMPLE_INTERVAL_S', 0.05)
    from discovery_service.broker import Broker, make_model
    from discovery_service.launcher import Session

    counter = tmp_path / 'n'
    counter.write_text('0')
    docker = _fake_docker(tmp_path, (
        f'n=$(cat {counter}); n=$((n+1)); echo $n > {counter}\n'
        'case $n in 1) echo "100MiB / 2GiB";; 2) echo "300MiB / 2GiB";; *) echo "200MiB / 2GiB";; esac\n'
    ))
    cfg = Config('http://127.0.0.1:4599/', 'scripted', docker=docker)
    request = DiscoveryRequest(schemaVersion='discovery.v1', runId='r1', targetUrl=cfg.fixture_url)
    session = Session(cfg, request, match_target(cfg.fixture_url, cfg.fixture_url), Broker(make_model('scripted')))

    async def scenario():
        task = asyncio.ensure_future(session._sample_memory())
        await asyncio.sleep(0.5)
        task.cancel()

    asyncio.run(scenario())
    assert session.peak_memory == 300 * 1024**2


def test_grounding_stays_inside_the_requested_fixture():
    from discovery_service.launcher import SITE_DIR, scoped_paths, to_response
    from discovery_service.policy import fixture_paths

    known = fixture_paths(SITE_DIR)
    museum = scoped_paths(known, '/benchmark/museum/index.html')
    assert museum and all(path.startswith('/benchmark/museum/') for path in museum)
    assert '/cart.html' not in museum and '/benchmark/library/index.html' not in museum
    assert scoped_paths(known, '/') == known  # the shop at / keeps the whole site
    idea = {'title': 'Cart totals', 'goal': 'A shopper sees a correct cart total.', 'rationale': 'Seen on the cart page.',
            'expected_behavior': ['The total is the sum of the lines'], 'negative_cases': []}
    outcome = {'status': 'completed', 'success': True, 'output': {'candidates': [
        {**idea, 'relevant_paths': ['/cart.html']},
        {**idea, 'title': 'Exhibit navigation', 'relevant_paths': ['/benchmark/museum/exhibit.html']},
    ]}}
    response, _ = to_response('r1', outcome, museum)
    assert [c.title for c in response.candidates] == ['Exhibit navigation']
    response, reason = to_response('r1', {**outcome, 'output': {'candidates': [{**idea, 'relevant_paths': ['/cart.html']}]}}, museum)
    assert response.status == 'PARTIAL' and reason == 'no_valid_candidates'


def test_the_task_names_the_fixture_scope():
    from discovery_service.runner import build_task, path_scope

    assert path_scope('/benchmark/museum/index.html') == '/benchmark/museum/' and path_scope('/') == '/'
    task = build_task('http://127.0.0.1:4599', 'http://127.0.0.1:4599/benchmark/museum/index.html', '/benchmark/museum/')
    assert 'pages under http://127.0.0.1:4599/benchmark/museum/' in task and 'out of scope' in task


def test_agent_memory_is_configurable_within_fixed_choices():
    import pytest
    from discovery_service.launcher import agent_memory

    cfg = Config.from_env({'DISCOVERY_FIXTURE_URL': 'http://127.0.0.1:4599/', 'DISCOVERY_MODEL': 'scripted', 'DISCOVERY_AGENT_MEMORY': '1g'})
    args = docker_args(cfg, match_target(cfg.fixture_url, cfg.fixture_url), 'n', 0)
    assert args[args.index('--memory') + 1] == '1g' and args[args.index('--memory-swap') + 1] == '1g'
    assert Config.from_env({'DISCOVERY_FIXTURE_URL': 'x', 'DISCOVERY_MODEL': 'scripted'}).agent_memory == '2g'
    for bad in ('4g', '64m', 'unlimited', '-1'):
        with pytest.raises(ValueError):
            agent_memory(bad)
