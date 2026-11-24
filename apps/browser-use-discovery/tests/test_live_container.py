"""Live interaction in real containers (needs Docker, the agent image and internet access to example.com).

Run with: DISCOVERY_LIVE_NET_TESTS=1 DISCOVERY_IMAGE=<image> uv run --frozen pytest -q -s -m docker tests/test_live_container.py
"""

import asyncio
import json
import os
import subprocess

import pytest

from discovery_service.launcher import DEFAULT_IMAGE, LABEL, Config, discover
from discovery_service.protocol import DiscoveryRequest
from discovery_service.scripted_model import ScriptedModel

IMAGE = os.environ.get('DISCOVERY_IMAGE', DEFAULT_IMAGE)
NETWORK = 'vtp-discovery-live-egress-test'
pytestmark = [
    pytest.mark.docker,
    pytest.mark.skipif(os.environ.get('DISCOVERY_LIVE_NET_TESTS') != '1', reason='live network tests are opt-in'),
]


def cfg() -> Config:
    return Config(fixture_url='http://127.0.0.1:4599/', model='scripted', image=IMAGE, live_sites=True, live_egress_network=NETWORK)


def leftovers() -> list[str]:
    out = subprocess.run(['docker', 'ps', '-aq', '--filter', f'label={LABEL}=1'], capture_output=True, text=True).stdout.split()
    nets = subprocess.run(['docker', 'network', 'ls', '-q', '--filter', f'label={LABEL}=1'], capture_output=True, text=True).stdout.split()
    return out + nets


def test_live_mode_crawls_the_site_through_the_inspecting_proxy_and_refuses_everything_that_sends_data():
    model = ScriptedModel(probe=True)
    request = DiscoveryRequest(schemaVersion='discovery.v1', runId='it-live-probe', targetUrl='https://example.com/', live=True, timeoutSeconds=110)
    resp, stats = asyncio.run(discover(request, cfg(), model=model))
    probe = model.observations.get('probe')
    print(json.dumps({'status': resp.status, 'stats': {k: stats.get(k) for k in ('reason', 'livePages', 'blockedByReason', 'cleanup')},
                      'live': probe and probe.get('live'), 'tcp': probe and probe.get('tcp')}, indent=1))
    assert isinstance(probe, dict) and 'live' in probe, model.observations
    # The browser opened the real page through the proxy, and that page grounds the result.
    assert '/' in model.observations.get('pages', [])
    assert stats['livePages'] >= 1
    # The agent's own Python: a GET passes, anything that sends data or leaves the site is refused by the proxy.
    assert probe['live']['get'] == 'FETCHED 200'
    for kind in ('post', 'put', 'delete'):
        assert '403' in probe['live'][kind], (kind, probe['live'][kind])
    assert probe['live']['off_site'].startswith('BLOCKED') and probe['live']['metadata'].startswith('BLOCKED')
    # Direct traffic still has no route at all.
    for dest, outcome in probe['tcp'].items():
        assert outcome.startswith('BLOCKED'), (dest, outcome)
    reasons = stats['blockedByReason']
    assert reasons.get('method_denied', 0) >= 3 and reasons.get('not_allowlisted', 0) >= 1
    assert stats['cleanup'] == 'ok' and leftovers() == []


def test_an_internal_network_is_refused_as_the_live_egress():
    subprocess.run(['docker', 'network', 'create', '--internal', 'vtp-discovery-live-egress-internal'], capture_output=True)
    try:
        bad = Config(fixture_url='http://127.0.0.1:4599/', model='scripted', image=IMAGE, live_sites=True,
                     live_egress_network='vtp-discovery-live-egress-internal')
        request = DiscoveryRequest(schemaVersion='discovery.v1', runId='it-live-bad', targetUrl='https://example.com/', live=True)
        resp, stats = asyncio.run(discover(request, bad, model=ScriptedModel()))
        assert resp.status == 'BLOCKED' and stats['reason'] == 'target_mode'
    finally:
        subprocess.run(['docker', 'network', 'rm', 'vtp-discovery-live-egress-internal'], capture_output=True)
