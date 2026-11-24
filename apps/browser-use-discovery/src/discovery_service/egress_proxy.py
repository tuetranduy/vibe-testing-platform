"""Target-site egress proxy for the agent container (``DISCOVERY_TARGET_MODE=proxy``; development and test only).

The agent container sits on its own ``--internal`` Docker network with this proxy as its only peer. The proxy also
joins the network that holds the approved target, and forwards plain HTTP only to the exact ``host:port`` pairs in
``EGRESS_ALLOW`` whose addresses are not loopback, link-local (cloud metadata), multicast or unspecified. Everything
else is refused with 403: other hosts and ports, CONNECT tunnels (no HTTPS pass-through), malformed requests, and an
allowed name that resolves to a forbidden address. Model traffic never comes here: it leaves only through the
launcher's broker over the container's stdin/stdout.

Each decision is one JSON line on stdout with a reason code and nothing else (no host, path or page content), so
the launcher can count blocked destinations without collecting browsing data.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import socket
import sys

MAX_HEAD_BYTES = 32 * 1024
IDLE_TIMEOUT_S = 30.0
HOP_HEADERS = {'proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'}
REASONS = ('not_allowlisted', 'forbidden_address', 'connect_denied', 'bad_request', 'unresolvable', 'upstream_error')


def event(kind: str, reason: str | None = None) -> None:
    sys.stdout.write(json.dumps({'event': kind, **({'reason': reason} if reason else {})}) + '\n')
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


async def main() -> None:
    allow = parse_allow(os.environ.get('EGRESS_ALLOW', ''))
    port = int(os.environ.get('EGRESS_PORT', '3128'))
    server = await asyncio.start_server(lambda r, w: handle(r, w, allow), '0.0.0.0', port, limit=MAX_HEAD_BYTES)
    event('egress.ready')
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    asyncio.run(main())
