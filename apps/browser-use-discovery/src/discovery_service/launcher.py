"""One-shot launcher: the executable Node runs (via bin/browser-use-discovery).

stdin:  one JSON line {"schemaVersion":"discovery.v1","runId":"...","targetUrl":"..."}
stdout: one JSON line {"schemaVersion":"discovery.v1","runId":"...","status":"...","candidates":[...]}
stderr: bounded JSON-lines diagnostics (progress, summary). Never page text, model output or agent code.

For each run it starts a fresh, network-less, credential-less container (``runner.py``), brokers its model requests
(``broker.py``), enforces a hard wall-clock deadline, and validates/sanitizes whatever the container returns.
SIGTERM/SIGINT/SIGHUP: the container is killed and removed, CANCELLED is printed, exit 143.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from discovery_service.broker import Broker, BrokerRefused, make_model
from discovery_service.policy import FixtureTarget, PolicyError, fixture_paths, match_target
from discovery_service.protocol import (
    AGENT_TIMEOUT_S,
    MAX_AGENT_STEPS,
    MAX_FRAME_BYTES,
    MAX_STDIN_BYTES,
    DiscoveryRequest,
    DiscoveryResponse,
    FrameError,
    decode_frame,
    encode_frame,
    parse_request,
    sanitize_candidates,
)

APP_DIR = Path(__file__).resolve().parents[2]
SITE_DIR = APP_DIR / 'fixture' / 'site'
DEFAULT_IMAGE = 'vtp-browser-use-discovery:1.0.6'
STARTUP_BUDGET_S = 45  # container start + Chromium launch
HARD_DEADLINE_S = AGENT_TIMEOUT_S + STARTUP_BUDGET_S + 15  # 180 s: the launcher never runs longer
LABEL = 'vtp.browser-use-discovery'
MAX_PROTOCOL_VIOLATIONS = 3
HEARTBEAT_INTERVAL_S = 2.0


@dataclass(frozen=True)
class Config:
    fixture_url: str
    model: str
    image: str = DEFAULT_IMAGE
    docker: str = 'docker'

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Config:
        env = os.environ if env is None else env
        return cls(
            fixture_url=env.get('DISCOVERY_FIXTURE_URL', ''),
            model=env.get('DISCOVERY_MODEL', ''),
            image=env.get('DISCOVERY_IMAGE') or DEFAULT_IMAGE,
            docker=env.get('DISCOVERY_DOCKER') or 'docker',
        )


def diag(event: str, **fields: Any) -> None:
    """One bounded JSON line on stderr. Values are numbers/codes chosen here, never untrusted text."""
    try:
        sys.stderr.write(json.dumps({'event': event, **fields}, separators=(',', ':'))[:2000] + '\n')
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


def docker_args(cfg: Config, target: FixtureTarget, name: str, deadline_epoch: int) -> list[str]:
    args = [
        cfg.docker, 'run', '-i', '--rm', '--pull', 'never',
        '--name', name,
        '--label', f'{LABEL}=1', '--label', f'{LABEL}.deadline={deadline_epoch}',
        # isolation: loopback only, no host/cloud/metadata/DNS reachability for ANY process (browser or Python)
        '--network', 'none',
        '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--user', '10001:10001',
        # no --init: the runner must be PID 1 and the sole holder of the stdio channel (see Dockerfile)
        '--pids-limit', '512',
        '--memory', '2g', '--memory-swap', '2g',
        '--cpus', '2',
        '--shm-size', '256m',
        '--ulimit', 'nofile=4096:4096',
        '--log-driver', 'none',
        '--stop-timeout', '3',
        # no -e from the host environment: only these fixed, non-secret values
        '-e', 'HOME=/tmp/home', '-e', 'TMPDIR=/tmp', '-e', 'ANONYMIZED_TELEMETRY=false', '-e', 'BH_TELEMETRY=0',
        '-e', 'BROWSER_USE_UPDATE_CHECK=false', '-e', 'PYTHONDONTWRITEBYTECODE=1',
    ]
    if target.needs_host_alias:
        args += ['--add-host', f'{target.host}:127.0.0.1']
    args.append(cfg.image)
    return args


def _kill_container(cfg: Config, name: str) -> None:
    try:
        subprocess.run([cfg.docker, 'rm', '-f', name], capture_output=True, timeout=15, check=False)
    except (OSError, subprocess.SubprocessError):
        pass


def reap_orphans(cfg: Config) -> int:
    """Containers whose launcher died (SIGKILL) are removed once past their deadline label."""
    try:
        out = subprocess.run(
            [cfg.docker, 'ps', '-a', '--filter', f'label={LABEL}=1', '--format', f'{{{{.ID}}}} {{{{.Label "{LABEL}.deadline"}}}}'],
            capture_output=True, text=True, timeout=15, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return 0
    now, reaped = int(time.time()), 0
    for line in out.splitlines():
        cid, _, deadline = line.partition(' ')
        if cid and (not deadline.isdigit() or int(deadline) < now):
            _kill_container(cfg, cid)
            reaped += 1
    return reaped


class Session:
    def __init__(self, cfg: Config, request: DiscoveryRequest, target: FixtureTarget, broker: Broker) -> None:
        self.cfg, self.request, self.target, self.broker = cfg, request, target, broker
        self.name = f'vtp-discovery-{request.runId[:40]}-{secrets.token_hex(4)}'
        self.proc: asyncio.subprocess.Process | None = None
        self.steps = 0
        self.violations = 0
        self.stderr_bytes = 0

    async def _drain_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        debug = os.environ.get('DISCOVERY_DEBUG') == '1'
        while chunk := await self.proc.stderr.read(65536):
            self.stderr_bytes += len(chunk)
            if debug and self.stderr_bytes < 200_000:  # local debugging only: container logs may contain page text
                sys.stderr.write(chunk.decode(errors='replace'))

    async def _heartbeat(self) -> None:
        """Independent of model calls: the runner exits after 10 s without any host frame (launcher death)."""
        try:
            while True:
                await self._send('hb')
                await asyncio.sleep(HEARTBEAT_INTERVAL_S)
        except (OSError, ConnectionError, RuntimeError):
            return

    async def _send(self, kind: str, **fields: Any) -> None:
        assert self.proc and self.proc.stdin
        self.proc.stdin.write(encode_frame(kind, **fields))
        await self.proc.stdin.drain()

    async def _serve(self) -> dict[str, Any] | None:
        assert self.proc and self.proc.stdout
        await self._send(
            'start', host=self.target.host, port=self.target.port, path=self.target.path,
            max_steps=MAX_AGENT_STEPS, timeout_s=AGENT_TIMEOUT_S,
        )
        while True:
            try:
                line = await self.proc.stdout.readuntil(b'\n')
            except asyncio.IncompleteReadError:
                return None  # container exited without a result
            except asyncio.LimitOverrunError:
                return None
            try:
                frame = decode_frame(line)
            except FrameError:
                self.violations += 1
                if self.violations >= MAX_PROTOCOL_VIOLATIONS:
                    return None
                continue
            kind = frame['t']
            if kind == 'model_request':
                rid = frame.get('id')
                if not isinstance(rid, int):
                    self.violations += 1
                    continue
                try:
                    payload = await self.broker.handle(frame.get('payload'))
                    await self._send('model_response', id=rid, payload=payload)
                except (BrokerRefused, FrameError) as e:
                    await self._send('model_error', id=rid, message=str(e)[:120])
                except Exception as e:  # noqa: BLE001 - provider error: a code only, the agent may retry within budget
                    diag('discovery.model_error', runId=self.request.runId, code=type(e).__name__[:60])
                    await self._send('model_error', id=rid, message='model request failed')
            elif kind == 'progress':
                steps = frame.get('steps')
                if isinstance(steps, int) and self.steps < steps <= MAX_AGENT_STEPS + 5:
                    self.steps = steps
                    diag('discovery.progress', runId=self.request.runId, agentSteps=steps)
            elif kind == 'result':
                result = frame.get('result')
                return result if isinstance(result, dict) else None
            else:
                self.violations += 1
                if self.violations >= MAX_PROTOCOL_VIOLATIONS:
                    return None

    async def run(self) -> dict[str, Any] | None:
        deadline_epoch = int(time.time()) + HARD_DEADLINE_S + 30
        self.proc = await asyncio.create_subprocess_exec(
            *docker_args(self.cfg, self.target, self.name, deadline_epoch),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=MAX_FRAME_BYTES,
            env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), **({'HOME': os.environ['HOME']} if 'HOME' in os.environ else {}),
                 **({'DOCKER_HOST': os.environ['DOCKER_HOST']} if 'DOCKER_HOST' in os.environ else {})},
            start_new_session=True,  # a TERM to Node's process group does not race our own teardown
        )
        drain = asyncio.ensure_future(self._drain_stderr())
        beat = asyncio.ensure_future(self._heartbeat())
        try:
            return await self._serve()
        finally:
            beat.cancel()
            self.close()
            try:
                await asyncio.wait_for(self.proc.wait(), 20)
            except TimeoutError:
                self.proc.kill()
            drain.cancel()

    def close(self) -> None:
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.stdin and self.proc.stdin.close()  # the runner sees EOF and stops
            except OSError:
                pass
        _kill_container(self.cfg, self.name)


def to_response(run_id: str, outcome: dict[str, Any] | None, known: frozenset[str]) -> tuple[DiscoveryResponse, str]:
    if outcome is None:
        return DiscoveryResponse(runId=run_id, status='FAILED'), 'no_result'
    status = outcome.get('status')
    if status == 'cancelled':
        return DiscoveryResponse(runId=run_id, status='CANCELLED'), 'cancelled'
    if status == 'completed':
        candidates = sanitize_candidates(outcome.get('output'), known)
        if outcome.get('success') is False or not candidates:
            return DiscoveryResponse(runId=run_id, status='PARTIAL'), 'no_valid_candidates'
        return DiscoveryResponse(runId=run_id, status='COMPLETED', candidates=candidates), 'ok'
    if status in ('timeout', 'max_steps'):
        return DiscoveryResponse(runId=run_id, status='PARTIAL'), str(status)  # only COMPLETED carries candidates
    return DiscoveryResponse(runId=run_id, status='FAILED'), 'agent_error'


async def discover(request: DiscoveryRequest, cfg: Config, model: Any = None) -> tuple[DiscoveryResponse, dict[str, Any]]:
    """Library entry (tests pass a model object). Returns the wire response and safe statistics."""
    started = time.monotonic()
    try:
        target = match_target(cfg.fixture_url, request.targetUrl)
    except PolicyError:
        return DiscoveryResponse(runId=request.runId, status='BLOCKED'), {'reason': 'target_not_allowed'}
    try:
        broker = Broker(model if model is not None else make_model(cfg.model))
    except (ValueError, ImportError) as e:
        diag('discovery.config_error', code=type(e).__name__)
        return DiscoveryResponse(runId=request.runId, status='BLOCKED'), {'reason': 'model_not_configured'}
    reap_orphans(cfg)
    session = Session(cfg, request, target, broker)
    deadline_hit = False
    try:
        outcome = await asyncio.wait_for(session.run(), HARD_DEADLINE_S)
    except TimeoutError:
        session.close()
        outcome, deadline_hit = None, True
    except asyncio.CancelledError:
        session.close()
        return DiscoveryResponse(runId=request.runId, status='CANCELLED'), {'reason': 'cancelled'}
    except OSError:
        return DiscoveryResponse(runId=request.runId, status='FAILED'), {'reason': 'docker_unavailable'}
    response, reason = to_response(request.runId, outcome, fixture_paths(SITE_DIR))
    if deadline_hit:
        reason = 'hard_deadline'
    stats = {
        'reason': reason,
        'agentSteps': int((outcome or {}).get('steps') or session.steps or 0),
        'modelRequests': broker.requests,
        'inputTokens': broker.usage['input'],
        'outputTokens': broker.usage['output'],
        'durationMs': int((time.monotonic() - started) * 1000),
        'protocolViolations': session.violations,
    }
    return response, stats


def _write(response: DiscoveryResponse) -> None:
    data = response.line().encode()
    os.write(1, data)


async def _main_async(raw: bytes, cfg: Config) -> int:
    loop = asyncio.get_running_loop()
    try:
        request = parse_request(raw)
    except ValueError:
        _write(DiscoveryResponse(runId='invalid', status='FAILED'))
        diag('discovery.summary', status='FAILED', reason='invalid_request')
        return 2
    task = asyncio.ensure_future(discover(request, cfg))
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        loop.add_signal_handler(sig, task.cancel)
    try:
        response, stats = await task
    except asyncio.CancelledError:
        response, stats = DiscoveryResponse(runId=request.runId, status='CANCELLED'), {'reason': 'cancelled'}
    _write(response)
    diag('discovery.summary', runId=request.runId, status=response.status, candidates=len(response.candidates), **stats)
    return 143 if response.status == 'CANCELLED' else 0


def _read_stdin(limit: int = MAX_STDIN_BYTES, timeout_s: float = 10.0) -> bytes:
    import select

    buf = bytearray()
    end = time.monotonic() + timeout_s
    while len(buf) <= limit:
        left = end - time.monotonic()
        if left <= 0 or not select.select([0], [], [], left)[0]:
            break
        chunk = os.read(0, 4096)
        if not chunk:
            break
        buf += chunk
        if b'\n' in buf:
            break
    return bytes(buf[: limit + 1])


def main() -> None:
    cfg = Config.from_env()
    raw = _read_stdin()
    sys.exit(asyncio.run(_main_async(raw, cfg)))


if __name__ == '__main__':
    main()
