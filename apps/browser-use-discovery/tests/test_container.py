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
    assert json.loads(out) == {'schemaVersion': 'discovery.v1', 'runId': 'cli-2', 'status': 'BLOCKED', 'candidates': []}


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
