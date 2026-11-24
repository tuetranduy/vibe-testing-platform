"""Target-site egress proxy for the agent container (``DISCOVERY_TARGET_MODE=proxy``; development and test only).

The agent container sits on its own ``--internal`` Docker network with this proxy as its only peer. The proxy also
joins the network that holds the approved target, and forwards plain HTTP only to the exact ``host:port`` pairs in
``EGRESS_ALLOW`` whose addresses are not loopback, link-local (cloud metadata), multicast or unspecified. Everything
else is refused with 403: other hosts and ports, CONNECT tunnels (no HTTPS pass-through), malformed requests, and an
allowed name that resolves to a forbidden address. Model traffic never comes here: it leaves only through the
launcher's broker over the container's stdin/stdout.

Each decision is one JSON line on stdout with a reason code and nothing else (no host, path or page content), so
the launcher can count blocked destinations without collecting browsing data.

``EGRESS_MODE=live`` (public HTTPS sites; see ``LiveProxy``): the proxy also joins a network with a route out, and is
the agent's only way to the target. It accepts CONNECT to approved hosts on port 443 only and terminates that TLS
with a per-job key that only this job's Chromium trusts (``--ignore-certificate-errors-spki-list``), so every request
is inspected. Standard browser HTTP methods and their bodies can reach approved destinations. Protocol upgrades
(web sockets) and document navigation to another host are refused. Upstream, the proxy resolves the name itself,
refuses any non-public address, connects to the address it checked (no second lookup: DNS rebinding cannot swap it)
and verifies the real certificate. Requests are rate limited. The one piece of browsing data it reports is the path
of each document the browser opened on the target (``egress.page``), which grounds the agent's ideas in pages it
really visited; it is held in the launcher's memory for the job only.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

import h11

MAX_HEAD_BYTES = 32 * 1024
IDLE_TIMEOUT_S = 30.0
HOP_HEADERS = {'proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'}
REASONS = (
    'not_allowlisted', 'forbidden_address', 'connect_denied', 'bad_request', 'unresolvable', 'upstream_error',
    # live mode
    'method_denied', 'upgrade_denied', 'tls_error', 'rate_limited',
)


def event(kind: str, reason: str | None = None, **fields: str) -> None:
    sys.stdout.write(json.dumps({'event': kind, **({'reason': reason} if reason else {}), **fields}) + '\n')
    sys.stdout.flush()


def parse_allow(raw: str) -> frozenset[tuple[str, int]]:
    pairs = set()
    for item in filter(None, (part.strip() for part in raw.split(','))):
        host, _, port = item.rpartition(':')
        if not host or not port.isdigit() or not 1 <= int(port) <= 65535:
            raise ValueError('EGRESS_ALLOW entries are host:port')
        pairs.add((host.lower().rstrip('.'), int(port)))
    return frozenset(pairs)


def forbidden_address(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved


def split_target(target: str) -> tuple[str, int, str] | None:
    """Absolute-form http://host[:port]/path -> (host, port, origin-form path)."""
    if not target.startswith('http://'):
        return None
    rest = target[len('http://'):]
    authority, slash, path = rest.partition('/')
    if '@' in authority or not authority:
        return None
    host, colon, port = authority.rpartition(':') if authority.count(':') == 1 else (authority, '', '')
    if not colon:
        host, port = authority, '80'
    if not host or not port.isdigit():
        return None
    return host.lower().rstrip('.'), int(port), '/' + path if slash else '/'


async def decide(host: str, port: int, allow: frozenset[tuple[str, int]]) -> tuple[list[str] | None, str | None]:
    """(addresses to connect to, None) when allowed; (None, reason) when refused. Every resolved address must be
    permitted, so a name that also resolves to a forbidden address (DNS rebinding) is refused outright."""
    if (host, port) not in allow:
        return None, 'not_allowlisted'
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return None, 'unresolvable'
    addresses = list(dict.fromkeys(info[4][0] for info in infos))
    if not addresses or any(forbidden_address(address) for address in addresses):
        return None, 'forbidden_address'
    return addresses, None


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await asyncio.wait_for(reader.read(65536), IDLE_TIMEOUT_S):
            writer.write(data)
            await writer.drain()
    except (OSError, TimeoutError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def refuse(writer: asyncio.StreamWriter, reason: str) -> None:
    event('egress.blocked', reason)
    try:
        writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        await writer.drain()
    finally:
        writer.close()


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, allow: frozenset[tuple[str, int]]) -> None:
    try:
        head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), IDLE_TIMEOUT_S)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, OSError):
        await refuse(writer, 'bad_request')
        return
    lines = head.decode('latin-1').split('\r\n')
    parts = lines[0].split(' ')
    if len(parts) != 3 or not parts[2].startswith('HTTP/'):
        await refuse(writer, 'bad_request')
        return
    method, target, version = parts
    if method.upper() == 'CONNECT':
        await refuse(writer, 'connect_denied')
        return
    split = split_target(target)
    if split is None:
        await refuse(writer, 'bad_request')
        return
    host, port, path = split
    addresses, reason = await decide(host, port, allow)
    if reason or not addresses:
        await refuse(writer, reason or 'unresolvable')
        return
    for address in addresses:  # the addresses checked above, never a fresh lookup
        try:
            up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(address, port), 10)
            break
        except (OSError, TimeoutError):
            continue
    else:
        await refuse(writer, 'upstream_error')
        return
    event('egress.allowed')
    headers = [line for line in lines[1:] if line and line.split(':', 1)[0].strip().lower() not in HOP_HEADERS]
    up_writer.write(('\r\n'.join([f'{method} {path} {version}', *headers, 'Connection: close']) + '\r\n\r\n').encode('latin-1'))
    await up_writer.drain()
    await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))


# --- live mode ------------------------------------------------------------------------------------------------------

BROWSER_METHODS = frozenset({'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'})
NAVIGATION_DESTS = frozenset({'document', 'iframe', 'frame', 'embed', 'object'})
PAGE_PATH = re.compile(r'^/[A-Za-z0-9._~/-]{0,179}$')
MAX_REQUESTS = 1500  # per job, every host
MAX_OTHER_HOST_REQUESTS = 400  # per job, subresources from the target's other hosts
RATE_PER_S, BURST = 15.0, 30
_LABEL = re.compile(r'^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')


def site_of(host: str) -> str:
    """An approximate registrable domain: the last two labels, or three under a short second-level label of a
    two-letter country code (co.uk, com.au). Used only to decide which subresource hosts count as the same site."""
    labels = host.split('.')
    if len(labels) >= 3 and len(labels[-1]) == 2 and len(labels[-2]) <= 3:
        return '.'.join(labels[-3:])
    return '.'.join(labels[-2:])


def valid_host(host: str) -> bool:
    labels = host.split('.')
    return 2 <= len(labels) and len(host) <= 253 and all(_LABEL.match(label) for label in labels) and not labels[-1].isdigit()


def public_address(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return ip.is_global and not ip.is_multicast


@dataclass
class Decision:
    allowed: bool
    reason: str | None = None


def request_decision(method: str, headers: dict[str, str], host: str, target_host: str) -> Decision:
    """The method and header policy for one decrypted request (pure; unit tested)."""
    if method not in BROWSER_METHODS:
        return Decision(False, 'method_denied')
    if 'transfer-encoding' in headers and 'content-length' in headers:
        return Decision(False, 'bad_request')
    if headers.get('upgrade') or 'upgrade' in headers.get('connection', '').lower():
        return Decision(False, 'upgrade_denied')
    if host != target_host and headers.get('sec-fetch-dest', '').lower() in NAVIGATION_DESTS:
        return Decision(False, 'not_allowlisted')  # the agent may not navigate to another site
    return Decision(True)


async def relay_request_body(incoming: h11.Connection, outgoing: h11.Connection, reader: asyncio.StreamReader,
                             upstream: asyncio.StreamWriter) -> None:
    """Relay exactly one HTTP message, framing chunked data afresh and discarding trailers."""
    while True:
        part = incoming.next_event()
        if part is h11.NEED_DATA:
            incoming.receive_data(await asyncio.wait_for(reader.read(65536), IDLE_TIMEOUT_S))
            continue
        if isinstance(part, h11.Data):
            upstream.write(outgoing.send(h11.Data(data=part.data)))
            await upstream.drain()
            continue
        if isinstance(part, h11.EndOfMessage):
            upstream.write(outgoing.send(h11.EndOfMessage()))
            await upstream.drain()
            return
        raise h11.RemoteProtocolError('request body ended before its framing was complete')


class RateLimit:
    def __init__(self, rate: float = RATE_PER_S, burst: int = BURST, total: int = MAX_REQUESTS,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.rate, self.burst, self.total, self.clock = rate, burst, total, clock
        self.tokens, self.used, self.at = float(burst), 0, clock()

    def take(self) -> bool:
        now = self.clock()
        self.tokens = min(self.burst, self.tokens + (now - self.at) * self.rate)
        self.at = now
        if self.used >= self.total or self.tokens < 1:
            return False
        self.tokens -= 1
        self.used += 1
        return True


class LiveProxy:
    """Live-mode policy and relay. ``permitted`` decides upstream addresses (tests substitute it)."""

    def __init__(self, target_host: str, key_pem: bytes, *, other_hosts: str = 'same-site', workdir: str = '/tmp/egress',
                 permitted: Callable[[str], bool] = public_address, upstream_ssl: ssl.SSLContext | None = None,
                 upstream_port: int = 443, lookup: Callable[[str, int], Awaitable[list[str]]] | None = None) -> None:
        if not valid_host(target_host):
            raise ValueError('EGRESS_ALLOW must name one public host')
        if other_hosts not in ('same-site', 'public', 'none'):
            raise ValueError('EGRESS_OTHER_HOSTS must be same-site, public or none')
        self.target_host, self.other_hosts, self.permitted = target_host, other_hosts, permitted
        self.key_pem, self.workdir = key_pem, workdir
        self.upstream_ssl = upstream_ssl or ssl.create_default_context()
        self.upstream_port = upstream_port
        self.lookup = lookup
        self.limit = RateLimit()
        self.other_used = 0
        self.contexts: dict[str, ssl.SSLContext] = {}
        os.makedirs(workdir, mode=0o700, exist_ok=True)

    def host_allowed(self, host: str) -> bool:
        if host == self.target_host:
            return True
        if not valid_host(host) or self.other_hosts == 'none':
            return False
        return self.other_hosts == 'public' or site_of(host) == site_of(self.target_host)

    def server_context(self, host: str) -> ssl.SSLContext:
        """A leaf certificate for `host` on the job's single key: Chromium trusts it by that key's SPKI pin."""
        if host not in self.contexts:
            from discovery_service.interception import leaf_certificate_pem

            cert, key = os.path.join(self.workdir, f'{host}.crt'), os.path.join(self.workdir, 'job.key')
            if not os.path.exists(key):
                with open(os.open(key, os.O_WRONLY | os.O_CREAT, 0o600), 'wb') as f:
                    f.write(self.key_pem)
            with open(cert, 'wb') as f:
                f.write(leaf_certificate_pem(self.key_pem, host))
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.set_alpn_protocols(['http/1.1'])  # one request per connection; no HTTP/2 multiplexing to inspect
            ctx.load_cert_chain(cert, key)
            self.contexts[host] = ctx
        return self.contexts[host]

    async def resolve(self, host: str) -> tuple[list[str] | None, str | None]:
        try:
            if self.lookup:
                addresses = list(dict.fromkeys(await self.lookup(host, self.upstream_port)))
            else:
                infos = await asyncio.get_running_loop().getaddrinfo(host, self.upstream_port, type=socket.SOCK_STREAM)
                addresses = list(dict.fromkeys(str(info[4][0]) for info in infos))
        except OSError:
            return None, 'unresolvable'
        # Every address must be public: a name that also resolves privately is refused outright.
        if not addresses or not all(self.permitted(address) for address in addresses):
            return None, 'forbidden_address'
        return addresses, None

    async def connect(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, target: str) -> None:
        host, _, port = target.rpartition(':')
        host = host.lower().rstrip('.')
        if port != '443' or not self.host_allowed(host):
            await refuse(writer, 'not_allowlisted')
            return
        if host != self.target_host:
            if self.other_used >= MAX_OTHER_HOST_REQUESTS:
                await refuse(writer, 'rate_limited')
                return
        writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        await writer.drain()
        try:
            await asyncio.wait_for(writer.start_tls(self.server_context(host)), IDLE_TIMEOUT_S)
        except (OSError, ssl.SSLError, TimeoutError, ValueError):
            event('egress.blocked', 'tls_error')
            writer.close()
            return
        await self.serve_request(reader, writer, host)

    async def serve_request(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, host: str) -> None:
        """One decrypted request per connection, answered with Connection: close."""
        incoming = h11.Connection(h11.SERVER, max_incomplete_event_size=MAX_HEAD_BYTES)
        try:
            head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), IDLE_TIMEOUT_S)
            if len(head) > MAX_HEAD_BYTES:
                await refuse(writer, 'bad_request')
                return
            incoming.receive_data(head)
            request = incoming.next_event()
        except h11.RemoteProtocolError:
            await refuse(writer, 'bad_request')
            return
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, OSError, ssl.SSLError):
            writer.close()
            return
        if not isinstance(request, h11.Request) or not request.target.startswith(b'/') or request.http_version not in (b'1.1', b'1.0'):
            await refuse(writer, 'bad_request')
            return
        method = request.method.decode('ascii')
        headers = {name.decode('ascii'): value.decode('latin-1') for name, value in request.headers}
        named = headers.get('host', '').lower().rstrip('.')
        if named not in (host, f'{host}:443'):
            await refuse(writer, 'bad_request')
            return
        decision = request_decision(method, headers, host, self.target_host)
        if not decision.allowed:
            await refuse(writer, decision.reason or 'method_denied')
            return
        if not self.limit.take():
            await refuse(writer, 'rate_limited')
            return
        if host != self.target_host:
            self.other_used += 1
        addresses, reason = await self.resolve(host)
        if reason or not addresses:
            await refuse(writer, reason or 'unresolvable')
            return
        for address in addresses:  # the addresses checked above, never a fresh lookup
            try:
                up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(
                    address, self.upstream_port, ssl=self.upstream_ssl, server_hostname=host), 10)
                break
            except (OSError, ssl.SSLError, TimeoutError):
                continue
        else:
            await refuse(writer, 'upstream_error')
            return
        try:
            event('egress.allowed')
            outgoing = h11.Connection(h11.CLIENT)
            kept = [(name, value) for name, value in request.headers if name.decode('ascii') not in HOP_HEADERS | {'expect'}]
            kept.append((b'connection', b'close'))
            up_writer.write(outgoing.send(h11.Request(method=request.method, target=request.target, headers=kept)))
            await up_writer.drain()
            if incoming.they_are_waiting_for_100_continue:
                writer.write(b'HTTP/1.1 100 Continue\r\n\r\n')
                await writer.drain()
            await relay_request_body(incoming, outgoing, reader, up_writer)
            page = request.target.split(b'?', 1)[0].decode('latin-1')
            if host == self.target_host and headers.get('sec-fetch-dest') == 'document' and PAGE_PATH.fullmatch(page):
                event('egress.page', path=page)
            await pipe(up_reader, writer)
        except (h11.RemoteProtocolError, h11.LocalProtocolError):
            await refuse(writer, 'bad_request')
        except (OSError, TimeoutError):
            writer.close()
        finally:
            up_writer.close()

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), IDLE_TIMEOUT_S)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, OSError):
            await refuse(writer, 'bad_request')
            return
        parts = head.decode('latin-1').split('\r\n')[0].split(' ')
        if len(parts) != 3 or parts[0].upper() != 'CONNECT':
            # Plain http:// is never relayed in live mode: the target is HTTPS only.
            await refuse(writer, 'not_allowlisted' if len(parts) == 3 else 'bad_request')
            return
        await self.connect(reader, writer, parts[1])


async def main() -> None:
    port = int(os.environ.get('EGRESS_PORT', '3128'))
    if os.environ.get('EGRESS_MODE') == 'live':
        allow = os.environ.get('EGRESS_ALLOW', '')
        host, _, allowed_port = allow.rpartition(':')
        if allowed_port != '443':
            raise ValueError('live mode allows one host on port 443')
        proxy = LiveProxy(host.lower(), os.environ.get('EGRESS_KEY', '').encode(), other_hosts=os.environ.get('EGRESS_OTHER_HOSTS', 'same-site'))
        os.environ.pop('EGRESS_KEY', None)
        server = await asyncio.start_server(proxy.handle, '0.0.0.0', port, limit=MAX_HEAD_BYTES)
        event('egress.ready')
        async with server:
            await server.serve_forever()
        return
    allow = parse_allow(os.environ.get('EGRESS_ALLOW', ''))
    server = await asyncio.start_server(lambda r, w: handle(r, w, allow), '0.0.0.0', port, limit=MAX_HEAD_BYTES)
    event('egress.ready')
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    asyncio.run(main())
