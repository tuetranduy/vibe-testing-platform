from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from discovery_service.fixture_server import serve


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
