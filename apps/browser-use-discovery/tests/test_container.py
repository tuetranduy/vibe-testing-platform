"""End-to-end tests against the real image (docker build -t vtp-browser-use-discovery:1.0.6 apps/browser-use-discovery).

No paid model calls: the scripted model drives the real Browser Use 1.0.6 agent loop through the broker.
Skipped when Docker or the image is unavailable.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest

from discovery_service.launcher import APP_DIR, DEFAULT_IMAGE, LABEL, Config, discover
from discovery_service.protocol import DiscoveryRequest, DiscoveryResponse
from discovery_service.scripted_model import ScriptedModel

IMAGE = os.environ.get('DISCOVERY_IMAGE', DEFAULT_IMAGE)
FIXTURE_URL = 'http://127.0.0.1:4611/'  # what Node would also open on the host; the container serves its own copy


def _image_ready() -> bool:
    try:
        return subprocess.run(['docker', 'image', 'inspect', IMAGE], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


pytestmark = [pytest.mark.docker, pytest.mark.skipif(not _image_ready(), reason=f'docker image {IMAGE} not available')]


def cfg() -> Config:
    return Config(fixture_url=FIXTURE_URL, model='scripted', image=IMAGE)


def req(run_id: str) -> DiscoveryRequest:
    return DiscoveryRequest(schemaVersion='discovery.v1', runId=run_id, targetUrl=FIXTURE_URL)


def leftover_containers() -> list[str]:
    out = subprocess.run(['docker', 'ps', '-aq', '--filter', f'label={LABEL}=1'], capture_output=True, text=True).stdout
    return out.split()


class Canary:
    """A host TCP listener on all interfaces that records every connection: nothing in the container may reach it."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(('0.0.0.0', 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.hits = 0
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self) -> None:
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            self.hits += 1
            c.close()


def test_scripted_discovery_completes():
    resp, stats = asyncio.run(discover(req('it-complete'), cfg(), model=ScriptedModel()))
    assert resp.status == 'COMPLETED', stats
    assert 4 <= len(resp.candidates) <= 12
    for c in resp.candidates:
        assert all(p.startswith('/') and '://' not in p for p in c.relevantPaths)
    assert 1 <= stats['agentSteps'] <= 19 and stats['modelRequests'] <= 20
    DiscoveryResponse.model_validate_json(resp.line())
    assert leftover_containers() == []


def test_caller_budget_completes_within_the_job_budget_and_removes_the_container():
    request = DiscoveryRequest(schemaVersion='discovery.v1', runId='it-budget', targetUrl=FIXTURE_URL, timeoutSeconds=30)
    started = time.monotonic()
    resp, stats = asyncio.run(discover(request, cfg(), model=ScriptedModel()))
    assert resp.status == 'COMPLETED' and resp.reason == 'ok', stats
    assert time.monotonic() - started < 30
    assert resp.statistics is not None and resp.statistics.durationMs < 30_000
    # Host-sampled peak memory of this job's own agent container, below its 2 GiB hard limit.
    assert resp.statistics.peakMemoryBytes is not None
    assert 16 * 1024**2 < resp.statistics.peakMemoryBytes < 2 * 1024**3
    assert stats['cleanup'] == 'ok'
    assert leftover_containers() == []


def test_cleanup_keeps_the_event_loop_responsive_during_a_real_job():
    """While a real container starts, runs and is removed, other coroutines (the job service's requests) keep running."""

    async def scenario():
        gaps: list[float] = []

        async def ticker():
            last = time.monotonic()
            while True:
                await asyncio.sleep(0.05)
                now = time.monotonic()
                gaps.append(now - last)
                last = now

        task = asyncio.ensure_future(ticker())
        resp, stats = await discover(req('it-loop'), cfg(), model=ScriptedModel())
        task.cancel()
        return resp, stats, max(gaps)

    resp, stats, worst_gap = asyncio.run(scenario())
    assert resp.status == 'COMPLETED' and stats['cleanup'] == 'ok'
    assert worst_gap < 1.0, worst_gap  # the old synchronous `docker rm -f` stalled every request for its duration
    assert leftover_containers() == []


def test_positive_control_bridge_container_reaches_host_canary():
    """Proves the probe below would detect a leak: the same image on a normal network does reach the canary."""
    canary = Canary()
    code = f"import socket; socket.create_connection(('host.docker.internal', {canary.port}), 3); print('reached')"
    r = subprocess.run(
        ['docker', 'run', '--rm', '--add-host', 'host.docker.internal:host-gateway', '--entrypoint', 'python', IMAGE, '-c', code],
        capture_output=True, text=True, timeout=60,
    )
    assert 'reached' in r.stdout, r.stderr[-500:]
    assert canary.hits >= 1


def test_agent_python_cannot_reach_network_or_secrets():
    canary = Canary()
    secret = 'sk-ant-canary-' + secrets.token_hex(16)
    os.environ['ANTHROPIC_API_KEY'] = secret  # present in the launcher (host) process, as a real key would be
    os.environ['DISCOVERY_CANARY_SECRET'] = secret
    try:
        model = ScriptedModel(probe=True, canary_port=canary.port)
        resp, stats = asyncio.run(discover(req('it-probe'), cfg(), model=model))
    finally:
        os.environ.pop('ANTHROPIC_API_KEY', None)
        os.environ.pop('DISCOVERY_CANARY_SECRET', None)
    probe = model.observations.get('probe')
    assert isinstance(probe, dict) and 'tcp' in probe, model.observations
    dump = json.dumps(probe)
    print(json.dumps(probe, indent=1)[:6000])

    assert probe['uid'] == 10001
    assert probe['interfaces_up'] == ['lo']  # placeholder tunnel devices (gre0, sit0, ...) exist but are down
    assert probe['ipv4_routes'] == [] and probe['ipv6_routes'] == []
    for kind in ('tcp', 'udp', 'http'):
        for dest, outcome in probe[kind].items():
            assert outcome.startswith('BLOCKED'), (kind, dest, outcome)
    for name, outcome in probe['dns'].items():
        assert outcome.startswith('BLOCKED'), (name, outcome)
    for url, outcome in probe['browser'].items():
        assert not outcome.startswith('AT http'), (url, outcome)
    # The host channel lives only in the runner, which is PID 1 and non-dumpable: its descriptors cannot be opened.
    # (Chromium/REPL processes the agent already controls are openable, but hold only /dev/null or internal pipes.)
    assert 'discovery_service.runner' in probe['pid1'], probe['pid1']
    runner_fds = {k: v for k, v in probe['procfd'].items() if k.startswith('1/')}
    assert runner_fds and all(v.startswith('DENIED') for v in runner_fds.values()), runner_fds
    assert secret not in dump and 'sk-ant-canary' not in dump
    # allowed: the base image's public Python release-signing key id, and Browser Use's own per-run REPL token
    # (random, created inside this container for its agent<->REPL socket)
    allowed = ('GPG_KEY=7169605F62C751356D054A26A821E680E5FA6305', 'BU_REPL_TOKEN=')
    assert [x for x in probe['env']['suspicious'] if not x.startswith(allowed)] == [], probe['env']
    assert not any('API_KEY' in n for n in probe['env']['names'])
    assert canary.hits == 0
    # the hostile run still ends with validated, grounded output
    assert resp.status == 'COMPLETED' and resp.candidates, stats
    assert leftover_containers() == []


def _cli(tmp_path: Path, extra: str = '') -> tuple[subprocess.Popen, dict[str, str]]:
    conf = tmp_path / 'discovery.env'
    conf.write_text(f'DISCOVERY_FIXTURE_URL={FIXTURE_URL}\nDISCOVERY_MODEL=scripted\nDISCOVERY_IMAGE={IMAGE}\n{extra}')
    env = {'PATH': os.environ['PATH'], 'BROWSER_USE_DISCOVERY_ENV': str(conf)}
    proc = subprocess.Popen(
        [str(APP_DIR / 'bin' / 'browser-use-discovery')],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
    )
    return proc, env


def test_cli_one_shot_with_path_only_env(tmp_path):
    proc, _ = _cli(tmp_path)
    line = json.dumps({'schemaVersion': 'discovery.v1', 'runId': 'cli-1', 'targetUrl': FIXTURE_URL}) + '\n'
    out, err = proc.communicate(line.encode(), timeout=240)
    assert proc.returncode == 0, err.decode()[-2000:]
    lines = out.decode().splitlines()
    assert len(lines) == 1
    resp = DiscoveryResponse.model_validate_json(lines[0])
    assert resp.runId == 'cli-1' and resp.status == 'COMPLETED' and resp.candidates
    events = [json.loads(x) for x in err.decode().splitlines() if x.startswith('{')]
    assert any(e['event'] == 'discovery.summary' for e in events)


def test_cli_blocks_other_targets(tmp_path):
    proc, _ = _cli(tmp_path)
    line = json.dumps({'schemaVersion': 'discovery.v1', 'runId': 'cli-2', 'targetUrl': 'http://169.254.169.254/'}) + '\n'
    out, _ = proc.communicate(line.encode(), timeout=60)
    assert json.loads(out) == {'schemaVersion': 'discovery.v1', 'runId': 'cli-2', 'status': 'BLOCKED', 'reason': 'target_not_allowed',
                               'candidates': []}


def test_cli_sigterm_cancels_and_tears_down(tmp_path):
    proc, _ = _cli(tmp_path)
    assert proc.stdin and proc.stderr
    proc.stdin.write((json.dumps({'schemaVersion': 'discovery.v1', 'runId': 'cli-3', 'targetUrl': FIXTURE_URL}) + '\n').encode())
    proc.stdin.flush()
    # wait until the container exists (the run is in flight), then abort as Node would
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline and not leftover_containers():
        time.sleep(0.2)
    assert leftover_containers(), 'container never started'
    time.sleep(2)
    proc.send_signal(signal.SIGTERM)
    out, _ = proc.communicate(timeout=60)
    assert proc.returncode == 143
    assert json.loads(out)['status'] == 'CANCELLED'
    t = time.monotonic()
    while leftover_containers() and time.monotonic() - t < 20:
        time.sleep(0.5)
    assert leftover_containers() == []


def test_sigkilled_launcher_container_still_dies(tmp_path):
    """Caller and launcher both gone (SIGKILL): stdin EOF stops the runner, so no container is left behind."""
    proc, _ = _cli(tmp_path)
    assert proc.stdin
    proc.stdin.write((json.dumps({'schemaVersion': 'discovery.v1', 'runId': 'cli-4', 'targetUrl': FIXTURE_URL}) + '\n').encode())
    proc.stdin.flush()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline and not leftover_containers():
        time.sleep(0.2)
    assert leftover_containers()
    proc.kill()
    proc.wait()
    t = time.monotonic()
    while leftover_containers() and time.monotonic() - t < 45:
        time.sleep(0.5)
    assert leftover_containers() == []


# --- proxy mode: target-site traffic through a per-job egress proxy, model traffic only through the broker --------

PROXY_TARGETS = 'vtp-discovery-targets-it'
PROXY_FIXTURE = 'http://vtp-fixture:4599/'


def leftover_networks() -> list[str]:
    out = subprocess.run(['docker', 'network', 'ls', '-q', '--filter', f'label={LABEL}=1'], capture_output=True, text=True).stdout
    return out.split()


@pytest.fixture(scope='module')
def target_network():
    """A controlled, --internal target network holding only a container serving the bundled disposable fixture."""
    subprocess.run(['docker', 'rm', '-f', 'vtp-fixture-it'], capture_output=True)
    subprocess.run(['docker', 'network', 'rm', PROXY_TARGETS], capture_output=True)
    subprocess.run(['docker', 'network', 'create', '--internal', PROXY_TARGETS], check=True, capture_output=True)
    subprocess.run([
        'docker', 'run', '-d', '--rm', '--name', 'vtp-fixture-it', '--network', PROXY_TARGETS, '--network-alias', 'vtp-fixture',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001',
        '--entrypoint', 'python', IMAGE, '-P', '-m', 'discovery_service.fixture_server', '--host', '0.0.0.0', '--port', '4599',
    ], check=True, capture_output=True)
    time.sleep(1)
    yield PROXY_TARGETS
    subprocess.run(['docker', 'rm', '-f', 'vtp-fixture-it'], capture_output=True)
    subprocess.run(['docker', 'network', 'rm', PROXY_TARGETS], capture_output=True)


def proxy_cfg(network: str) -> Config:
    return Config(fixture_url=PROXY_FIXTURE, model='scripted', image=IMAGE, target_mode='proxy', target_network=network)


def test_proxy_mode_reaches_the_fixture_container_and_counts_nothing_blocked(target_network):
    request = DiscoveryRequest(schemaVersion='discovery.v1', runId='it-proxy', targetUrl=PROXY_FIXTURE, timeoutSeconds=60)
    resp, stats = asyncio.run(discover(request, proxy_cfg(target_network), model=ScriptedModel()))
    assert resp.status == 'COMPLETED' and resp.candidates, stats  # crawled through the egress proxy
    # Chromium's own leftover background requests are refused and counted too (a few per job), never forwarded.
    statistics = resp.statistics
    assert statistics is not None and statistics.blockedDestinations is not None and statistics.blockedByReason is not None
    assert statistics.blockedDestinations == sum(statistics.blockedByReason.values())
    assert statistics.blockedByReason.get('forbidden_address', 0) == 0
    print('baseline blocked by reason', statistics.blockedByReason)
    assert stats['cleanup'] == 'ok'
    assert leftover_containers() == [] and leftover_networks() == []


def test_proxy_mode_refuses_every_other_destination_and_counts_them(target_network):
    canary = Canary()
    secret = 'sk-ant-canary-' + secrets.token_hex(16)
    os.environ['ANTHROPIC_API_KEY'] = secret
    try:
        model = ScriptedModel(probe=True, canary_port=canary.port)
        request = DiscoveryRequest(schemaVersion='discovery.v1', runId='it-proxy-probe', targetUrl=PROXY_FIXTURE, timeoutSeconds=90)
        resp, stats = asyncio.run(discover(request, proxy_cfg(target_network), model=model))
    finally:
        os.environ.pop('ANTHROPIC_API_KEY', None)
    probe = model.observations.get('probe')
    assert isinstance(probe, dict) and 'proxy' in probe, model.observations
    print(json.dumps({k: probe[k] for k in ('tcp', 'dns', 'http', 'browser', 'proxy', 'proxy_allowed', 'ipv4_routes')}, indent=1))
    # Direct traffic: no route anywhere (an --internal network has no gateway), and no external name resolution.
    for kind in ('tcp', 'udp', 'http'):
        for dest, outcome in probe[kind].items():
            assert outcome.startswith('BLOCKED'), (kind, dest, outcome)
    assert probe['dns']['example.com'].startswith('BLOCKED') and probe['dns']['metadata.google.internal'].startswith('BLOCKED')
    assert not any(route.split('\t')[1] == '00000000' for route in probe['ipv4_routes'] if '\t' in route)  # no default route
    # Through the proxy: everything but the fixture's own origin is refused; the fixture is the positive control.
    for url, outcome in probe['proxy'].items():
        assert 'HTTPError' in outcome and '403' in outcome, (url, outcome)
    assert probe['proxy_allowed'] == 'FETCHED 200'
    for url, outcome in probe['browser'].items():
        assert 'meta-data' not in outcome and 'example.com/' not in outcome.replace('AT ', '') or not outcome.startswith('AT http'), (url, outcome)
    # Model traffic never used the network: the provider key stayed in the host process.
    assert secret not in json.dumps(probe) and canary.hits == 0
    assert resp.statistics is not None and resp.statistics.blockedDestinations >= len(probe['proxy'])
    assert stats['blockedByReason'].get('not_allowlisted', 0) >= len(probe['proxy'])
    assert resp.status == 'COMPLETED'
    assert leftover_containers() == [] and leftover_networks() == []


def test_proxy_mode_refuses_unapproved_target_networks():
    for network in ('bridge', 'host', 'vtp-discovery-targets-missing'):
        request = DiscoveryRequest(schemaVersion='discovery.v1', runId='it-proxy-bad', targetUrl=PROXY_FIXTURE)
        resp, stats = asyncio.run(discover(request, proxy_cfg(network), model=ScriptedModel()))
        assert resp.status == 'BLOCKED' and stats['reason'] == 'target_mode', (network, stats)
    assert leftover_containers() == [] and leftover_networks() == []
