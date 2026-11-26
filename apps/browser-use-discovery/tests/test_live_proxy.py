"""Live interaction mode (Phase A): the inspecting egress proxy, end to end in one process.

A local TLS server stands in for the public site; the proxy is told to treat its loopback address as permitted and to
trust its certificate. Everything else is the production code path: CONNECT, the per-job interception certificate
(checked here by its SPKI pin, as Chromium does), the method / body / upgrade / navigation policy and the relay.
"""

import asyncio
import base64
import hashlib
import json
import ssl

import pytest

from discovery_service import egress_proxy
from discovery_service.egress_proxy import LiveProxy, RateLimit, observed_pages, request_decision, site_of
from discovery_service.interception import leaf_certificate_pem, new_job_key
from discovery_service.launcher import Config, egress_proxy_args, pages_from
from discovery_service.policy import LiveTarget, PolicyError, match_request, normalize_live_url
from discovery_service.protocol import parse_request

HOST = 'shop.example.com'


def test_live_urls_are_public_https_pages_only():
    assert normalize_live_url('https://Shop.Example.com/catalog/') == LiveTarget(url='https://shop.example.com/catalog/', host=HOST, path='/catalog/')
    for bad in ('http://shop.example.com/', 'https://shop.example.com:8443/', 'https://10.0.0.1/', 'https://localhost/',
                'https://intranet.local/', 'https://shop.example.com/?q=1', 'https://u:p@shop.example.com/', 'https://shop/'):
        with pytest.raises(PolicyError):
            normalize_live_url(bad)
    with pytest.raises(PolicyError):
        match_request('http://127.0.0.1:4599/', False, 'https://shop.example.com/', True)  # the operator has not enabled it
    assert match_request('http://127.0.0.1:4599/', True, 'https://shop.example.com/', True).live


def test_a_live_request_never_carries_a_snapshot():
    body = {'schemaVersion': 'discovery.v1', 'runId': 'r1', 'targetUrl': 'https://shop.example.com/', 'live': True}
    assert parse_request(json.dumps(body).encode()).live
    with pytest.raises(ValueError):
        parse_request(json.dumps({**body, 'snapshot': [{'path': '/', 'title': 'Home', 'evidence': 'x'}]}).encode())


def test_browser_methods_and_request_bodies_pass_on_approved_destinations():
    assert request_decision('GET', {'sec-fetch-dest': 'document'}, HOST, HOST).allowed
    for method in ('POST', 'PUT', 'PATCH', 'DELETE'):
        assert request_decision(method, {'content-length': '12'}, HOST, HOST).allowed
    assert request_decision('POST', {'transfer-encoding': 'chunked'}, HOST, HOST).allowed
    assert request_decision('POST', {'transfer-encoding': 'chunked', 'content-length': '12'}, HOST, HOST).reason == 'bad_request'
    assert request_decision('CONNECT', {}, HOST, HOST).reason == 'method_denied'
    assert request_decision('GET', {'upgrade': 'websocket', 'connection': 'Upgrade'}, HOST, HOST).reason == 'upgrade_denied'
    # Another host serves subresources only: no top-level navigation off the site.
    assert request_decision('GET', {'sec-fetch-dest': 'script'}, 'cdn.example.com', HOST).allowed
    assert request_decision('GET', {'sec-fetch-dest': 'document'}, 'cdn.example.com', HOST).reason == 'not_allowlisted'


def test_observed_pages_include_in_app_routes_named_by_a_same_origin_referer():
    # A single-page app changes route without loading a document (run_0mww1vvpf1f95f4eb053a2d17: /register, /login
    # and /home were never document requests); its later requests name the page they came from.
    assert observed_pages(b'/catalog?page=2', {'sec-fetch-dest': 'document'}, HOST, HOST) == ['/catalog']
    assert observed_pages(b'/api/auth/register', {'sec-fetch-dest': 'empty', 'referer': f'https://{HOST}/register?step=1#top'},
                          HOST, HOST) == ['/register']
    assert observed_pages(b'/next', {'sec-fetch-dest': 'document', 'referer': f'https://{HOST}/prev'}, HOST, HOST) == ['/next', '/prev']
    assert observed_pages(b'/next', {'sec-fetch-dest': 'document', 'referer': f'https://{HOST}/next'}, HOST, HOST) == ['/next']
    # Only the target's own pages: not another host's referer, not a subresource host's request, not plain http.
    for referer in ('https://evil.test/register', f'http://{HOST}/register', f'https://{HOST}:8443/register',
                    f'https://{HOST}/../etc', f'https://{HOST}//x', 'not a url', ''):
        assert observed_pages(b'/api/x', {'referer': referer}, HOST, HOST) == [], referer
    assert observed_pages(b'/lib.js', {'referer': f'https://{HOST}/register'}, 'cdn.example.com', HOST) == []
    assert observed_pages(b'/api/x', {'referer': f'https://{HOST}:443/home'}, HOST, HOST) == ['/home']


def test_subresource_hosts_and_rate_limit():
    key, _ = new_job_key()
    proxy = LiveProxy(HOST, key, workdir='/tmp/vtp-egress-test')
    assert proxy.host_allowed('cdn.example.com') and not proxy.host_allowed('evil.test')
    assert not LiveProxy(HOST, key, other_hosts='none', workdir='/tmp/vtp-egress-test').host_allowed('cdn.example.com')
    assert LiveProxy(HOST, key, other_hosts='public', workdir='/tmp/vtp-egress-test').host_allowed('fonts.gstatic.com')
    assert site_of('www.shop.co.uk') == 'shop.co.uk'
    now = [0.0]
    limit = RateLimit(rate=1, burst=2, total=3, clock=lambda: now[0])
    assert [limit.take(), limit.take(), limit.take()] == [True, True, False]
    now[0] = 5
    assert [limit.take(), limit.take()] == [True, False]  # the job's total is spent


def test_the_proxy_gets_the_job_key_and_the_agent_never_does(tmp_path):
    key, _ = new_job_key()
    args = egress_proxy_args(Config(fixture_url='http://127.0.0.1:4599/', model='scripted', live_sites=True),
                             LiveTarget(url=f'https://{HOST}/', host=HOST, path='/'), 'egress', 'net', 0, key)
    assert 'EGRESS_MODE=live' in args and f'EGRESS_ALLOW={HOST}:443' in args
    assert any(a.startswith('EGRESS_KEY=-----BEGIN PRIVATE KEY-----') for a in args)


def test_grounding_uses_the_pages_the_browser_opened():
    log = '\n'.join([json.dumps({'event': 'egress.page', 'path': '/catalog'}), json.dumps({'event': 'egress.page', 'path': '/../etc'}),
                     json.dumps({'event': 'egress.allowed'}), 'not json', json.dumps({'event': 'egress.page', 'path': '/cart'})])
    assert pages_from(log) == frozenset({'/catalog', '/cart'})


@pytest.fixture
def upstream(tmp_path):
    """A TLS 'public site' on loopback, recording what it receives."""
    key, _ = new_job_key()
    cert = tmp_path / 'up.crt'
    cert.write_bytes(leaf_certificate_pem(key, HOST))
    (tmp_path / 'up.key').write_bytes(key)
    seen: list[tuple[bytes, bytes]] = []

    async def serve(reader, writer):
        head = await reader.readuntil(b'\r\n\r\n')
        request_line, *fields = head.strip().split(b'\r\n')
        headers = {name.lower(): value.strip() for name, value in (line.split(b':', 1) for line in fields)}
        body = await reader.readexactly(int(headers.get(b'content-length', b'0')))
        if headers.get(b'transfer-encoding') == b'chunked':
            while size := int(await reader.readline(), 16):
                body += await reader.readexactly(size)
                assert await reader.readexactly(2) == b'\r\n'
            assert await reader.readline() == b'\r\n'
        seen.append((request_line, body))
        if request_line.startswith(b'POST /checkout '):
            writer.write(b'HTTP/1.1 303 See Other\r\nLocation: /payment\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        else:
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello')
        await writer.drain()
        writer.close()

    server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_ctx.load_cert_chain(cert, tmp_path / 'up.key')
    client_ctx = ssl.create_default_context(cafile=str(cert))
    client_ctx.check_hostname = True
    return serve, server_ctx, client_ctx, seen


async def _request(proxy_port: int, connect_to: str, request: bytes, pin: str) -> tuple[bytes, bytes]:
    reader, writer = await asyncio.open_connection('127.0.0.1', proxy_port)
    writer.write(f'CONNECT {connect_to} HTTP/1.1\r\nHost: {connect_to}\r\n\r\n'.encode())
    await writer.drain()
    status = await reader.readuntil(b'\r\n\r\n')
    if b' 200 ' not in status:
        writer.close()
        return status, b''
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE  # trust by pin below, as Chromium does
    await writer.start_tls(ctx, server_hostname=connect_to.split(':')[0])
    der = writer.get_extra_info('ssl_object').getpeercert(binary_form=True)
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization

    spki = x509.load_der_x509_certificate(der).public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    assert base64.b64encode(hashlib.sha256(spki).digest()).decode() == pin
    writer.write(request)
    await writer.drain()
    body = await reader.read()
    writer.close()
    return status, body


def test_live_proxy_end_to_end(upstream, tmp_path, capsys):
    serve, server_ctx, client_ctx, seen = upstream

    async def scenario():
        up = await asyncio.start_server(serve, '127.0.0.1', 0, ssl=server_ctx)
        up_port = up.sockets[0].getsockname()[1]
        key, pin = new_job_key()

        async def lookup(host, port):
            return ['127.0.0.1']

        proxy = LiveProxy(HOST, key, workdir=str(tmp_path / 'egress'), permitted=lambda a: True,
                          upstream_ssl=client_ctx, upstream_port=up_port, lookup=lookup)
        srv = await asyncio.start_server(proxy.handle, '127.0.0.1', 0)
        port = srv.sockets[0].getsockname()[1]
        get = f'GET /catalog?page=2 HTTP/1.1\r\nHost: {HOST}\r\nSec-Fetch-Dest: document\r\n\r\n'.encode()
        _, page = await _request(port, f'{HOST}:443', get, pin)
        post = (f'POST /checkout HTTP/1.1\r\nHost: {HOST}\r\nSec-Fetch-Dest: document\r\n'
                'Content-Type: application/x-www-form-urlencoded\r\nContent-Length: 10\r\n\r\nquantity=1').encode()
        _, submitted = await _request(port, f'{HOST}:443', post, pin)
        _, payment = await _request(port, f'{HOST}:443', f'GET /payment HTTP/1.1\r\nHost: {HOST}\r\n\r\n'.encode(), pin)
        chunked = (f'PATCH /cart HTTP/1.1\r\nHost: {HOST}\r\nTransfer-Encoding: chunked\r\n\r\n'
                   '3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n').encode()
        _, updated = await _request(port, f'{HOST}:443', chunked, pin)
        ambiguous = f'POST /checkout HTTP/1.1\r\nHost: {HOST}\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n'.encode()
        _, refused = await _request(port, f'{HOST}:443', ambiguous, pin)
        api = f'POST /api/auth/register HTTP/1.1\r\nHost: {HOST}\r\nSec-Fetch-Dest: empty\r\nReferer: https://{HOST}/register\r\nContent-Length: 2\r\n\r\n{{}}'.encode()
        await _request(port, f'{HOST}:443', api, pin)
        ws = f'GET /live HTTP/1.1\r\nHost: {HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'.encode()
        _, upgrade = await _request(port, f'{HOST}:443', ws, pin)
        smuggled = b'GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n'
        _, wrong_host = await _request(port, f'{HOST}:443', smuggled, pin)
        off_site, _ = await _request(port, 'evil.test:443', b'', pin)
        other_port, _ = await _request(port, f'{HOST}:8443', b'', pin)
        # A name that resolves to a private address is refused before any connection.
        private = LiveProxy(HOST, key, workdir=str(tmp_path / 'egress2'), lookup=lambda h, p: asyncio.sleep(0, ['10.0.0.5']))
        resolved = await private.resolve(HOST)
        for s in (srv, up):
            s.close()
            await s.wait_closed()
        return page, submitted, payment, updated, refused, upgrade, wrong_host, off_site, other_port, resolved

    page, submitted, payment, updated, refused, upgrade, wrong_host, off_site, other_port, resolved = asyncio.run(scenario())
    assert page.endswith(b'hello')
    assert b'303 See Other\r\nLocation: /payment\r\n' in submitted
    assert payment.endswith(b'hello') and updated.endswith(b'hello')
    assert seen == [
        (b'GET /catalog?page=2 HTTP/1.1', b''),
        (b'POST /checkout HTTP/1.1', b'quantity=1'),
        (b'GET /payment HTTP/1.1', b''),
        (b'PATCH /cart HTTP/1.1', b'abcde'),
        (b'POST /api/auth/register HTTP/1.1', b'{}'),
    ]
    assert b'403' in refused and b'403' in upgrade and b'403' in wrong_host
    assert b'403' in off_site and b'403' in other_port
    assert resolved == (None, 'forbidden_address')
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{')]
    assert {'event': 'egress.page', 'path': '/catalog'} in events
    assert {'event': 'egress.page', 'path': '/checkout'} in events
    assert {'event': 'egress.page', 'path': '/register'} in events  # an in-app route, named by its fetch's referer
    assert {'event': 'egress.page', 'path': '/api/auth/register'} not in events
    reasons = [e.get('reason') for e in events if e['event'] == 'egress.blocked']
    assert 'bad_request' in reasons and 'upgrade_denied' in reasons and 'not_allowlisted' in reasons
    assert set(reasons) <= set(egress_proxy.REASONS)
