from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from discovery_service.fixture_server import serve, serve_snapshot


def test_fixture_only_serves_read_requests():
    server = serve('127.0.0.1', 0)
    try:
        url = f'http://127.0.0.1:{server.server_port}/benchmark/workspace/index.html'
        for method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            with pytest.raises(HTTPError) as denied:
                urlopen(Request(url, method=method, data=b'fixture-canary'), timeout=2)
            assert denied.value.code == 405
        with urlopen(url, timeout=2) as response:
            assert b'Guest workspace' in response.read()
    finally:
        server.shutdown()
        server.server_close()


def test_snapshot_exposes_only_escaped_captured_pages():
    server = serve_snapshot(0, [{'path': '/catalog', 'title': '<script>test</script>', 'evidence': 'Read items'}])
    try:
        url = f'http://127.0.0.1:{server.server_port}'
        with urlopen(url + '/catalog', timeout=2) as response:
            assert response.headers['Content-Security-Policy'] == "default-src 'none'"
            body = response.read()
            assert b'&lt;script&gt;test&lt;/script&gt;' in body and b'<script>' not in body
        for path in ('/', '/products.html', '/catalog?other'):
            with pytest.raises(HTTPError) as denied:
                urlopen(url + path, timeout=2)
            assert denied.value.code == 404
    finally:
        server.shutdown()
        server.server_close()
