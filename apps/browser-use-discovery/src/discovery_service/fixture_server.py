"""Static server for the bundled fixture site.

Used twice, from the same files:
- inside the discovery container, on loopback, as the only site the agent can reach;
- on the host (``python -m discovery_service.fixture_server --port 4599``) so the normal Node survey can open the same
  pages at the operator-configured DISCOVERY_FIXTURE_URL.

GET/HEAD only, no directory listings, no files outside the site directory, no query-driven behaviour server-side.
"""

from __future__ import annotations

import argparse
import http.server
import os
import threading
from functools import partial
from pathlib import Path

SITE_DIR = Path(os.environ.get('DISCOVERY_FIXTURE_DIR') or Path(__file__).resolve().parents[2] / 'fixture' / 'site')


class _Handler(http.server.SimpleHTTPRequestHandler):
    server_version = 'fixture'
    sys_version = ''

    def list_directory(self, path):  # noqa: ANN001 - stdlib signature
        self.send_error(404)
        return None

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        self.send_error(405)

    do_PUT = do_DELETE = do_PATCH = do_POST

    def end_headers(self) -> None:
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def log_message(self, format, *args):  # noqa: A002, ANN001 - quiet: stdout/stderr carry protocol data
        return


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve(host: str, port: int, site_dir: Path = SITE_DIR) -> _Server:
    if not (site_dir / 'index.html').is_file():
        raise FileNotFoundError(f'fixture site missing: {site_dir}')
    server = _Server((host, port), partial(_Handler, directory=str(site_dir)))
    threading.Thread(target=server.serve_forever, name='fixture', daemon=True).start()
    return server


def main() -> None:
    ap = argparse.ArgumentParser(description='Serve the bundled discovery fixture for the Node survey.')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=4599)
    args = ap.parse_args()
    server = serve(args.host, args.port)
    print(f'fixture: http://{args.host}:{server.server_address[1]}/ ({SITE_DIR})', flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == '__main__':
    main()
