"""The target-site egress proxy's policy, run in-process against local synthetic upstreams only."""

import asyncio
import json

import pytest

from discovery_service import egress_proxy
from discovery_service.egress_proxy import decide, forbidden_address, handle, parse_allow, split_target
from discovery_service.launcher import Config, ConfigError, check_target_mode, count_egress, egress_proxy_args
from discovery_service.policy import match_target


def test_allowlist_and_request_target_parsing():
    assert parse_allow('vtp-fixture:4599, Other.Host.:8080') == {('vtp-fixture', 4599), ('other.host', 8080)}
    for bad in ('nohost', 'h:0', 'h:99999', ':80', 'h:x'):
        with pytest.raises(ValueError):
            parse_allow(bad)
    assert split_target('http://vtp-fixture:4599/a/b?q=1') == ('vtp-fixture', 4599, '/a/b?q=1')
    assert split_target('http://vtp-fixture') == ('vtp-fixture', 80, '/')
    for bad in ('https://vtp-fixture/', 'http://user@vtp-fixture/', 'ftp://x/', '/relative', 'http://:80/', 'http://h:x/'):
        assert split_target(bad) is None


def test_forbidden_addresses_cover_metadata_loopback_and_unspecified():
    for address in ('169.254.169.254', '127.0.0.1', '::1', '0.0.0.0', 'fe80::1', '224.0.0.1'):
        assert forbidden_address(address)
    for address in ('172.18.0.5', '10.20.30.40', '93.184.216.34'):
        assert not forbidden_address(address)


def test_decisions(monkeypatch):
    allow = parse_allow('vtp-fixture:4599,rebind:4599')
    answers = {'vtp-fixture': '172.18.0.5', 'rebind': '169.254.169.254'}

    async def getaddrinfo(host, port, **_):
        if host not in answers:
            raise OSError('no such host')
        return [(None, None, None, None, (answers[host], port))]

    async def scenario():
        monkeypatch.setattr(asyncio.get_running_loop(), 'getaddrinfo', getaddrinfo)
        return [await decide(host, port, allow) for host, port in (
            ('vtp-fixture', 4599), ('vtp-fixture', 22), ('elsewhere', 4599), ('rebind', 4599),
        )]

    assert asyncio.run(scenario()) == [
        (['172.18.0.5'], None), (None, 'not_allowlisted'), (None, 'not_allowlisted'), (None, 'forbidden_address'),
    ]


async def _exchange(port: int, request: bytes) -> bytes:
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    writer.write(request)
    await writer.drain()
    data = await asyncio.wait_for(reader.read(), 5)
    writer.close()
    return data


def test_proxy_refuses_and_forwards(monkeypatch, capsys):
    """CONNECT, off-allowlist hosts and malformed requests get 403; the allowlisted upstream is forwarded to, with
    proxy credentials stripped. Loopback is permitted here only by patching, to stand in for the fixture container."""
    seen: list[bytes] = []

    async def scenario():
        async def upstream(reader, writer):
            seen.append(await reader.readuntil(b'\r\n\r\n'))
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
            await writer.drain()
            writer.close()

        up = await asyncio.start_server(upstream, '127.0.0.1', 0)
        up_port = up.sockets[0].getsockname()[1]
        allow = parse_allow(f'localhost:{up_port}')
        monkeypatch.setattr(egress_proxy, 'forbidden_address', lambda address: False)
        proxy = await asyncio.start_server(lambda r, w: handle(r, w, allow), '127.0.0.1', 0)
        port = proxy.sockets[0].getsockname()[1]
        results = {
            'connect': await _exchange(port, b'CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n'),
            'other_host': await _exchange(port, b'GET http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\n\r\n'),
            'other_port': await _exchange(port, f'GET http://localhost:{up_port + 1}/ HTTP/1.1\r\n\r\n'.encode()),
            'garbage': await _exchange(port, b'hello\r\n\r\n'),
            'allowed': await _exchange(port, (
                f'GET http://localhost:{up_port}/page.html HTTP/1.1\r\nHost: localhost:{up_port}\r\n'
                'Proxy-Authorization: Basic c2VjcmV0\r\nProxy-Connection: keep-alive\r\n\r\n'
            ).encode()),
        }
        proxy.close()
        up.close()
        return results

    results = asyncio.run(scenario())
    for key in ('connect', 'other_host', 'other_port', 'garbage'):
        assert results[key].startswith(b'HTTP/1.1 403'), key
    assert results['allowed'].startswith(b'HTTP/1.1 200') and results['allowed'].endswith(b'ok')
    assert seen and seen[0].startswith(b'GET /page.html HTTP/1.1')
    assert b'Proxy-Authorization' not in seen[0] and b'Proxy-Connection' not in seen[0]
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    blocked, reasons = count_egress('\n'.join(json.dumps(e) for e in events))
    assert blocked == 4
    assert reasons == {'connect_denied': 1, 'not_allowlisted': 2, 'bad_request': 1}
    assert sum(1 for e in events if e['event'] == 'egress.allowed') == 1
    assert all(set(e) <= {'event', 'reason'} for e in events)  # codes only: no hosts, paths or content


def test_proxy_mode_stays_on_an_approved_internal_target_network(tmp_path):
    script = tmp_path / 'docker'

    def docker(internal: str):
        script.write_text(f'#!/bin/sh\necho {internal}\n')
        script.chmod(0o755)
        return str(script)

    check_target_mode(Config('http://127.0.0.1:4599/', 'scripted'))  # bundled: nothing to check
    for cfg in (
        Config('http://vtp-fixture:4599/', 'scripted', target_mode='tunnel'),
        Config('http://vtp-fixture:4599/', 'scripted', target_mode='proxy', target_network='bridge'),
        Config('http://vtp-fixture:4599/', 'scripted', target_mode='proxy', target_network='host'),
        Config('http://vtp-fixture:4599/', 'scripted', docker=docker('false'), target_mode='proxy',
               target_network='vtp-discovery-targets'),
    ):
        with pytest.raises(ConfigError):
            check_target_mode(cfg)
    check_target_mode(Config('http://vtp-fixture:4599/', 'scripted', docker=docker('true'), target_mode='proxy',
                             target_network='vtp-discovery-targets-ci'))
    cfg = Config('http://vtp-fixture:4599/', 'scripted', target_mode='proxy', target_network='vtp-discovery-targets')
    args = egress_proxy_args(cfg, match_target(cfg.fixture_url, cfg.fixture_url), 'n-egress', 'n-net', 0)
    joined = ' '.join(args)
    assert 'EGRESS_ALLOW=vtp-fixture:4599' in joined  # exactly the fixture's origin, nothing else
    for flag in ('--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 10001:10001', '--network n-net'):
        assert flag in joined
    assert not any(a.startswith(('-v', '--volume', '--mount', '--privileged')) for a in args)
