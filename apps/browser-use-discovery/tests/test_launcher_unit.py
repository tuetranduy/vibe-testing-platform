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
