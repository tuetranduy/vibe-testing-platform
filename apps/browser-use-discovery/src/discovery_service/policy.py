"""Target policy for the fixture-only slice.

An operator configures ONE fixture URL (DISCOVERY_FIXTURE_URL). A request is served only when its targetUrl equals
that URL after normalization; anything else is BLOCKED before a container starts. The agent never reaches the
operator's URL over a network: inside the network-less container the same origin is answered by the bundled copy of
the fixture (a loopback server on the same port, the hostname pinned to 127.0.0.1 with --add-host).
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

_HOSTNAME = re.compile(r'^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$')


class PolicyError(ValueError):
    pass


@dataclass(frozen=True)
class FixtureTarget:
    url: str  # normalized, e.g. http://127.0.0.1:4599/
    host: str
    port: int
    path: str

    @property
    def origin(self) -> str:
        return f'http://{self.host}:{self.port}'

    @property
    def needs_host_alias(self) -> bool:
        return self.host not in ('127.0.0.1', 'localhost')


def normalize_url(raw: str) -> FixtureTarget:
    if not isinstance(raw, str) or len(raw) > 2048 or raw != raw.strip():
        raise PolicyError('URL is not a clean string')
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError as e:
        raise PolicyError('URL does not parse') from e
    if parts.scheme != 'http':  # the in-container copy is plain HTTP on loopback
        raise PolicyError('only http:// fixture URLs are supported')
    if parts.username is not None or parts.password is not None or '?' in raw or '#' in raw:
        raise PolicyError('fixture URL must not carry credentials, a query or a fragment')
    host = (parts.hostname or '').lower().rstrip('.')
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None and str(ip) != '127.0.0.1':
        raise PolicyError('an IP fixture host must be 127.0.0.1')
    if ip is None and not _HOSTNAME.match(host):
        raise PolicyError('invalid fixture hostname')
    port = port or 80
    if not 1024 <= port <= 65535:
        raise PolicyError('fixture port must be 1024-65535')
    path = parts.path or '/'
    if not re.fullmatch(r'/[A-Za-z0-9._~/-]*', path) or '..' in path or '//' in path:
        raise PolicyError('invalid fixture path')
    return FixtureTarget(url=f'http://{host}:{port}{path}', host=host, port=port, path=path)


def match_target(configured: str, requested: str) -> FixtureTarget:
    """The configured fixture, when the request names exactly it. Raises PolicyError otherwise."""
    want = normalize_url(configured)
    try:
        got = normalize_url(requested)
    except PolicyError as e:
        raise PolicyError(f'targetUrl rejected: {e}') from None
    if got != want:
        raise PolicyError('targetUrl is not the configured discovery fixture')
    return want


def fixture_paths(site_dir: Path) -> frozenset[str]:
    """URL paths the bundled fixture serves (HTML pages only): the grounding set for candidate relevantPaths."""
    paths = {'/'}
    for f in site_dir.rglob('*.html'):
        rel = f.relative_to(site_dir).as_posix()
        paths.add('/' + rel)
    paths.discard('/index.html')
    return frozenset(paths)
