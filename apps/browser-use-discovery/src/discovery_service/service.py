"""Authenticated, single-replica job API on the trusted host running the launcher.

Every request carries ``Authorization: Bearer <unix-seconds>.<nonce>.<signature>``. The signature is
HMAC-SHA256 over ``v2``, the method, path, timestamp, nonce, idempotency key and the SHA-256 of the body, so a
captured header cannot be reused for another body, key, path or method. Each nonce is accepted once within the
clock-skew window, which turns a replayed request into ``401``.
"""

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import hmac
import os
import re
import subprocess
import time

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from discovery_service.launcher import Config, diag, discover
from discovery_service.policy import PolicyError, match_target
from discovery_service.protocol import MAX_STDIN_BYTES, DiscoveryRequest, DiscoveryResponse, parse_request

RESULT_TTL_SECONDS = 900
JOB_LIMIT = 128
SIGNATURE_WINDOW_SECONDS = 60
NONCE_LIMIT = 4096
AUTHORIZATION = re.compile(r'Bearer ([0-9]{10})\.([0-9a-f]{32})\.([0-9a-f]{64})')


def signed_message(method: str, path: str, timestamp: str, nonce: str, idempotency_key: str, body: bytes) -> bytes:
    """The canonical string both sides sign (mirrors apps/worker/src/discovery-client.ts)."""
    digest = hashlib.sha256(body).hexdigest()
    return f'v2\n{method}\n{path}\n{timestamp}\n{nonce}\n{idempotency_key}\n{digest}'.encode()


class NonceCache:
    """Nonces seen inside the signature window. Bounded: when full of live nonces, new requests are refused."""

    def __init__(self, limit: int = NONCE_LIMIT) -> None:
        self.limit = limit
        self.seen: dict[str, float] = {}

    def claim(self, nonce: str, now: float) -> bool | None:
        """True: first use. False: a replay. None: the cache is full of unexpired nonces."""
        if nonce in self.seen and self.seen[nonce] > now:
            return False
        if len(self.seen) >= self.limit:
            for key in [key for key, expiry in self.seen.items() if expiry <= now]:
                del self.seen[key]
            if len(self.seen) >= self.limit:
                return None
        # Keep it past both edges of the window: a timestamp may sit up to the window ahead of this clock.
        self.seen[nonce] = now + 2 * SIGNATURE_WINDOW_SECONDS
        return True


@dataclass
class Job:
    request: DiscoveryRequest
    steps: int = 0
    task: asyncio.Task | None = None
    result: DiscoveryResponse | None = None
    finished_at: float = 0

    def progress(self, steps: int) -> None:
        self.steps = steps

    def finish(self, result: DiscoveryResponse) -> None:
        self.result = result
        self.finished_at = time.monotonic()


def create_app(config: Config, secret: str, *, runner=discover) -> Starlette:
    if len(secret) < 32:
        raise ValueError('DISCOVERY_SERVICE_TOKEN requires at least 32 characters')
    match_target(config.fixture_url, config.fixture_url)
    if not config.model:
        raise ValueError('DISCOVERY_MODEL is required')
    jobs: dict[str, Job] = {}
    nonces = NonceCache()
    cleanup = {'failures': 0}

    def credentials(request: Request) -> tuple[str, str, str] | None:
        """Header shape and clock window only: cheap checks before reading any body."""
        match = AUTHORIZATION.fullmatch(request.headers.get('authorization', ''))
        if not match or abs(time.time() - int(match.group(1))) > SIGNATURE_WINDOW_SECONDS:
            return None
        return match.group(1), match.group(2), match.group(3)

    def verify(request: Request, parts: tuple[str, str, str] | None, body: bytes) -> JSONResponse | None:
        """None when the signature is valid and its nonce is new; otherwise the refusal to send."""
        if parts is None:
            return JSONResponse({}, 401)
        timestamp, nonce, signature = parts
        key = request.headers.get('idempotency-key', '')
        expected = hmac.new(secret.encode(), signed_message(request.method, request.url.path, timestamp, nonce, key, body),
                            hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return JSONResponse({}, 401)
        claimed = nonces.claim(nonce, time.time())
        if claimed is None:
            return JSONResponse({}, 503)
        return None if claimed else JSONResponse({}, 401)

    async def work(job: Job) -> None:
        try:
            result, stats = await runner(job.request, config, on_progress=job.progress)
            if isinstance(stats, dict) and stats.get('cleanup') == 'failed':
                cleanup['failures'] += 1
        except asyncio.CancelledError:
            result = DiscoveryResponse(runId=job.request.runId, status='CANCELLED', reason='cancelled')
        except Exception as err:
            diag('discovery.service_error', code=type(err).__name__)
            result = DiscoveryResponse(runId=job.request.runId, status='FAILED', reason='agent_error')
        job.finish(result)

    @asynccontextmanager
    async def lifespan(_app):
        yield
        active = [job.task for job in jobs.values() if job.task and not job.task.done()]
        for task in active:
            task.cancel()
        await asyncio.gather(*active, return_exceptions=True)

    def capacity() -> dict[str, int]:
        """Counts only: one active job at a time across every worker and tenant (no queue, no fairness)."""
        return {
            'activeJobs': sum(1 for job in jobs.values() if job.result is None),
            'jobSlots': 1,
            'cleanupFailures': cleanup['failures'],
        }

    async def health(_request: Request) -> JSONResponse:
        if runner is not discover:
            return JSONResponse({'status': 'ready', **capacity()})
        try:
            image = await asyncio.to_thread(
                subprocess.run, [config.docker, 'image', 'inspect', config.image],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3,
            )
        except (OSError, subprocess.TimeoutExpired):
            return JSONResponse({'status': 'unavailable'}, 503)
        if image.returncode != 0:
            return JSONResponse({'status': 'unavailable'}, 503)
        return JSONResponse({'status': 'ready', **capacity()})

    def respond(job: Job, status: int = 200) -> JSONResponse:
        data = {'jobId': job.request.runId, 'agentSteps': job.steps}
        if job.result is not None:
            data['result'] = job.result.wire()
        return JSONResponse(data, status_code=status, headers={'Cache-Control': 'no-store'})

    async def read_body(request: Request) -> bytes | JSONResponse:
        raw = bytearray()
        try:
            async with asyncio.timeout(5):
                async for chunk in request.stream():
                    if len(raw) + len(chunk) > MAX_STDIN_BYTES:
                        return JSONResponse({}, 413)
                    raw.extend(chunk)
        except TimeoutError:
            return JSONResponse({}, 408)
        return bytes(raw)

    async def submit(request: Request) -> JSONResponse:
        parts = credentials(request)
        if parts is None:
            return JSONResponse({}, 401)
        raw = await read_body(request)
        if isinstance(raw, JSONResponse):
            return raw
        if (refused := verify(request, parts, raw)) is not None:
            return refused
        try:
            discovery = parse_request(raw)
            match_target(config.fixture_url, discovery.targetUrl)
        except (ValueError, PolicyError):
            return JSONResponse({}, 422)
        if request.headers.get('idempotency-key') != f'{discovery.runId}:{discovery.schemaVersion}':
            return JSONResponse({}, 400)
        now = time.monotonic()
        for key, job in list(jobs.items()):
            if job.finished_at and now - job.finished_at >= RESULT_TTL_SECONDS:
                del jobs[key]
        existing = jobs.get(discovery.runId)
        if existing:
            return respond(existing, 202) if existing.request == discovery else JSONResponse({}, 409)
        if len(jobs) >= JOB_LIMIT or any(job.result is None for job in jobs.values()):
            return JSONResponse({}, 429)
        job = jobs[discovery.runId] = Job(discovery)
        job.task = asyncio.create_task(work(job))
        return respond(job, 202)

    async def resource(request: Request) -> JSONResponse:
        parts = credentials(request)
        if parts is None:
            return JSONResponse({}, 401)
        raw = await read_body(request)
        if isinstance(raw, JSONResponse):
            return raw
        if (refused := verify(request, parts, raw)) is not None:
            return refused
        if raw:  # status and cancellation take no body
            return JSONResponse({}, 400)
        job = jobs.get(request.path_params['job_id'])
        if not job or (job.finished_at and time.monotonic() - job.finished_at >= RESULT_TTL_SECONDS):
            return JSONResponse({}, 404)
        if request.method == 'DELETE' and job.task and not job.task.done() and not job.task.cancelling():
            job.task.cancel()
            await asyncio.gather(job.task, return_exceptions=True)
            if job.result is None:  # cancelled before the task entered work()
                job.finish(DiscoveryResponse(runId=job.request.runId, status='CANCELLED', reason='cancelled'))
        if request.url.path.endswith('/events'):
            return JSONResponse({'agentSteps': job.steps}, headers={'Cache-Control': 'no-store'})
        return respond(job)

    base = '/internal/v1/discoveries'
    return Starlette(routes=[
        Route('/internal/health', health),
        Route(base, submit, methods=['POST']),
        Route(base + '/{job_id}', resource, methods=['GET', 'DELETE']),
        Route(base + '/{job_id}/events', resource),
    ], lifespan=lifespan)


if __name__ == '__main__':
    import uvicorn

    app = create_app(Config.from_env(), os.environ.get('DISCOVERY_SERVICE_TOKEN', ''))
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ.get('DISCOVERY_SERVICE_PORT', '4600')),
                access_log=False, proxy_headers=False, limit_concurrency=32)
