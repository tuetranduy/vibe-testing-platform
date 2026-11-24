"""One-shot launcher: the executable Node runs (via bin/browser-use-discovery).

stdin:  one JSON line {"schemaVersion":"discovery.v1","runId":"...","targetUrl":"..."}
stdout: one JSON line {"schemaVersion":"discovery.v1","runId":"...","status":"...","candidates":[...]}
stderr: bounded JSON-lines diagnostics (progress, summary). Never page text, model output or agent code.

For each run it starts a fresh, network-less, credential-less container (``runner.py``), brokers its model requests
(``broker.py``), enforces a hard wall-clock deadline, and validates/sanitizes whatever the container returns.
SIGTERM/SIGINT/SIGHUP: the container is killed and removed, CANCELLED is printed, exit 143.

A request's ``timeoutSeconds`` is the whole job's budget. The agent gets what remains after a reserve for container
start and result delivery, and the launcher stops the container at the budget itself, so the caller always receives a
typed response (``PARTIAL``/``timeout`` or ``FAILED``/``hard_deadline``) a little before its own deadline.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from discovery_service.broker import Broker, BrokerRefused, is_zero_cost, make_model, make_run_model
from discovery_service.policy import FixtureTarget, LiveTarget, PolicyError, fixture_paths, match_request
from discovery_service.protocol import (
    AGENT_TIMEOUT_S,
    MAX_AGENT_STEPS,
    MAX_FRAME_BYTES,
    MAX_STDIN_BYTES,
    DiscoveryRequest,
    DiscoveryResponse,
    DiscoveryStatistics,
    FrameError,
    decode_frame,
    encode_frame,
    parse_request,
    clean_focus,
    sanitize_candidates,
    sanitize_findings,
)

APP_DIR = Path(__file__).resolve().parents[2]
SITE_DIR = APP_DIR / 'fixture' / 'site'
DEFAULT_IMAGE = 'vtp-browser-use-discovery:1.0.6'
STARTUP_BUDGET_S = 45  # container start + Chromium launch
HARD_DEADLINE_S = AGENT_TIMEOUT_S + STARTUP_BUDGET_S + 15  # 180 s: the launcher never runs longer
# With a caller budget: reserved for container start and for the runner's teardown plus result delivery.
STARTUP_RESERVE_S = 5.0
DELIVERY_MARGIN_S = 5.0
MIN_AGENT_TIMEOUT_S = 5.0
CLEANUP_TIMEOUT_S = 15.0
CONTAINER_MEMORY_LIMIT_BYTES = 2 * 1024**3  # --memory 2g --memory-swap 2g
MEMORY_SAMPLE_INTERVAL_S = 1.0
_SIZE = re.compile(r'^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKMGT]?i?B)\s*$')
_UNITS = {'B': 1, 'kB': 1000, 'KB': 1000, 'MB': 1000**2, 'GB': 1000**3, 'TB': 1000**4,
          'KiB': 1024, 'MiB': 1024**2, 'GiB': 1024**3, 'TiB': 1024**4}
CLIENT_EXIT_GRACE_S = 3.0
LABEL = 'vtp.browser-use-discovery'
MAX_PROTOCOL_VIOLATIONS = 3
HEARTBEAT_INTERVAL_S = 2.0


@dataclass(frozen=True)
class Config:
    fixture_url: str
    model: str
    image: str = DEFAULT_IMAGE
    docker: str = 'docker'
    # 'bundled' (default): the agent container has no network and explores its own copy of the fixture.
    # 'proxy' (development and test): the agent reaches the fixture's own container through a per-job egress proxy
    # on an internal network; target_network names the pre-created internal network that holds approved targets.
    target_mode: str = 'bundled'
    target_network: str = ''
    # The agent container's memory and swap limit (docker --memory); lower on a small shared host.
    agent_memory: str = '2g'
    # Live interaction with public HTTPS sites (DISCOVERY_LIVE_SITES=on): each job's inspecting egress proxy joins
    # live_egress_network (a plain bridge with a route out); the agent container never does.
    live_sites: bool = False
    live_egress_network: str = 'vtp-discovery-live-egress'
    # Subresource hosts a live page may load from besides its own: same-site (default), public or none.
    live_other_hosts: str = 'same-site'

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Config:
        env = os.environ if env is None else env
        return cls(
            fixture_url=env.get('DISCOVERY_FIXTURE_URL', ''),
            model=env.get('DISCOVERY_MODEL', ''),
            image=env.get('DISCOVERY_IMAGE') or DEFAULT_IMAGE,
            docker=env.get('DISCOVERY_DOCKER') or 'docker',
            target_mode=env.get('DISCOVERY_TARGET_MODE') or 'bundled',
            target_network=env.get('DISCOVERY_TARGET_NETWORK', ''),
            agent_memory=agent_memory(env.get('DISCOVERY_AGENT_MEMORY') or '2g'),
            live_sites=env.get('DISCOVERY_LIVE_SITES') == 'on',
            live_egress_network=env.get('DISCOVERY_LIVE_EGRESS_NETWORK') or 'vtp-discovery-live-egress',
            live_other_hosts=live_other_hosts(env.get('DISCOVERY_LIVE_OTHER_HOSTS') or 'same-site'),
        )


AGENT_MEMORY = ('768m', '1g', '1536m', '2g')


def agent_memory(value: str) -> str:
    if value not in AGENT_MEMORY:
        raise ValueError(f'DISCOVERY_AGENT_MEMORY must be one of {", ".join(AGENT_MEMORY)}')
    return value


def live_other_hosts(value: str) -> str:
    if value not in ('same-site', 'public', 'none'):
        raise ValueError('DISCOVERY_LIVE_OTHER_HOSTS must be same-site, public or none')
    return value


TARGET_NETWORK = re.compile(r'vtp-discovery-targets(-[a-z0-9]{1,32})?')
LIVE_EGRESS_NETWORK = re.compile(r'vtp-discovery-live-egress(-[a-z0-9]{1,32})?')
MAX_LIVE_PAGES = 200
EGRESS_ALIAS, EGRESS_PORT = 'egress-proxy', 3128


class ConfigError(ValueError):
    pass


def check_target_mode(cfg: Config) -> None:
    """Proxy mode stays inside controlled fixtures: an internal target network with an approved name only."""
    if cfg.target_mode == 'bundled':
        return
    if cfg.target_mode != 'proxy':
        raise ConfigError('DISCOVERY_TARGET_MODE must be bundled or proxy')
    if not TARGET_NETWORK.fullmatch(cfg.target_network):
        raise ConfigError('DISCOVERY_TARGET_NETWORK must be a vtp-discovery-targets[-name] network')
    try:
        internal = subprocess.run(
            [cfg.docker, 'network', 'inspect', '--format', '{{.Internal}}', cfg.target_network],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise ConfigError('the target network could not be inspected') from e
    if internal.returncode != 0 or internal.stdout.strip() != 'true':
        # An internal network has no route to the host or the internet: only its own containers are reachable.
        raise ConfigError('DISCOVERY_TARGET_NETWORK must exist and be --internal')


def check_live_network(cfg: Config) -> None:
    """Live mode's way out: a plain (non-internal) bridge that only egress proxies join. Created when missing,
    never labeled for the reaper; refused when it exists as an internal network (it would have no route out)."""
    if not LIVE_EGRESS_NETWORK.fullmatch(cfg.live_egress_network):
        raise ConfigError('DISCOVERY_LIVE_EGRESS_NETWORK must be a vtp-discovery-live-egress[-name] network')
    try:
        inspect = subprocess.run(
            [cfg.docker, 'network', 'inspect', '--format', '{{.Internal}}', cfg.live_egress_network],
            capture_output=True, text=True, timeout=10, check=False,
        )
        if inspect.returncode != 0:
            created = subprocess.run([cfg.docker, 'network', 'create', '--driver', 'bridge', cfg.live_egress_network],
                                     capture_output=True, text=True, timeout=20, check=False)
            if created.returncode != 0 and 'already exists' not in created.stderr:
                raise ConfigError('the live egress network could not be created')
            return
    except (OSError, subprocess.SubprocessError) as e:
        raise ConfigError('the live egress network could not be inspected') from e
    if inspect.stdout.strip() != 'false':
        raise ConfigError('DISCOVERY_LIVE_EGRESS_NETWORK must not be --internal')


def diag(event: str, **fields: Any) -> None:
    """One bounded JSON line on stderr. Values are numbers/codes chosen here, never untrusted text."""
    try:
        sys.stderr.write(json.dumps({'event': event, **fields}, separators=(',', ':'))[:2000] + '\n')
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


def docker_args(cfg: Config, target: FixtureTarget | LiveTarget, name: str, deadline_epoch: int, network: str = 'none') -> list[str]:
    args = [
        cfg.docker, 'run', '-i', '--rm', '--pull', 'never',
        '--name', name,
        '--label', f'{LABEL}=1', '--label', f'{LABEL}.deadline={deadline_epoch}',
        # isolation: loopback only, no host/cloud/metadata/DNS reachability for ANY process (browser or Python)
        # bundled: `none`; proxy: the job's own --internal network, whose only peer is its egress proxy
        '--network', network,
        '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--user', '10001:10001',
        # no --init: the runner must be PID 1 and the sole holder of the stdio channel (see Dockerfile)
        '--pids-limit', '512',
        '--memory', cfg.agent_memory, '--memory-swap', cfg.agent_memory,
        '--cpus', '2',
        '--shm-size', '256m',
        '--ulimit', 'nofile=4096:4096',
        '--log-driver', 'none',
        '--stop-timeout', '3',
        # no -e from the host environment: only these fixed, non-secret values
        '-e', 'HOME=/tmp/home', '-e', 'TMPDIR=/tmp', '-e', 'ANONYMIZED_TELEMETRY=false', '-e', 'BH_TELEMETRY=0',
        '-e', 'BROWSER_USE_UPDATE_CHECK=false', '-e', 'PYTHONDONTWRITEBYTECODE=1',
    ]
    if target.needs_host_alias and network == 'none':
        args += ['--add-host', f'{target.host}:127.0.0.1']
    args.append(cfg.image)
    return args


def egress_proxy_args(cfg: Config, target: FixtureTarget | LiveTarget, name: str, network: str, deadline_epoch: int,
                      job_key: bytes | None = None) -> list[str]:
    """The job's target-site proxy: same image, same hardening, allowlisting only the target's host:port. Live mode
    also gets the job's interception key (ephemeral, this job only) and a small tmpfs for its minted certificates."""
    live = ['-e', 'EGRESS_MODE=live', '-e', f'EGRESS_OTHER_HOSTS={cfg.live_other_hosts}',
            '-e', f'EGRESS_KEY={job_key.decode()}', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=8m,mode=1777'] if target.live and job_key else []
    return [
        cfg.docker, 'run', '-d', '--pull', 'never', '--name', name,
        '--label', f'{LABEL}=1', '--label', f'{LABEL}.deadline={deadline_epoch}',
        '--network', network, '--network-alias', EGRESS_ALIAS,
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001',
        '--pids-limit', '64', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5',
        '-e', f'EGRESS_ALLOW={target.host}:{target.port}', '-e', f'EGRESS_PORT={EGRESS_PORT}', '-e', 'PYTHONDONTWRITEBYTECODE=1',
        *live,
        '--entrypoint', 'python', cfg.image, '-P', '-m', 'discovery_service.egress_proxy',
    ]


def pages_from(log: str) -> frozenset[str]:
    """Live mode's grounding: the document paths the browser really opened on the target (the proxy's egress.page)."""
    from discovery_service.egress_proxy import PAGE_PATH

    pages: set[str] = set()
    for line in log.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        path = entry.get('path') if isinstance(entry, dict) and entry.get('event') == 'egress.page' else None
        if isinstance(path, str) and PAGE_PATH.match(path) and '..' not in path and '//' not in path:
            pages.add(path)
            if len(pages) >= MAX_LIVE_PAGES:
                break
    return frozenset(pages)


def count_egress(log: str) -> tuple[int, dict[str, int]]:
    """Blocked destinations from the proxy's JSON lines (reason codes only)."""
    from discovery_service.egress_proxy import REASONS

    reasons: dict[str, int] = {}
    for line in log.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get('event') == 'egress.blocked' and entry.get('reason') in REASONS:
            reasons[entry['reason']] = reasons.get(entry['reason'], 0) + 1
    return sum(reasons.values()), reasons


def _removed(returncode: int | None, stderr: bytes | str) -> bool:
    text = stderr.decode(errors='replace') if isinstance(stderr, bytes) else stderr
    return returncode == 0 or 'No such container' in text


def _kill_container(cfg: Config, name: str) -> bool:
    """Blocking removal: for the orphan reaper, which runs in a worker thread."""
    try:
        done = subprocess.run([cfg.docker, 'rm', '-f', name], capture_output=True, timeout=CLEANUP_TIMEOUT_S, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    return _removed(done.returncode, done.stderr)


async def _docker(cfg: Config, *args: str, timeout: float) -> tuple[int | None, bytes]:
    try:
        proc = await asyncio.create_subprocess_exec(
            cfg.docker, *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
    except OSError:
        return None, b''
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return None, b''
    return proc.returncode, stderr or b''


def parse_memory_usage(text: str) -> int | None:
    """The used part of `docker stats` MemUsage ("123.4MiB / 2GiB") in bytes, or None."""
    match = _SIZE.match(text.split('/', 1)[0])
    if not match or match.group(2) not in _UNITS:
        return None
    return int(float(match.group(1)) * _UNITS[match.group(2)])


async def container_memory_bytes(cfg: Config, name: str) -> int | None:
    """The container's current memory use as Docker reports it (cgroup usage less inactive file cache)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            cfg.docker, 'stats', '--no-stream', '--format', '{{.MemUsage}}', name,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        return None
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), 10)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return None
    if proc.returncode != 0:
        return None
    return parse_memory_usage(out.decode(errors='replace').strip().splitlines()[0] if out.strip() else '')


async def remove_container(cfg: Config, name: str) -> bool:
    """Removes a job container without blocking the event loop; True once Docker confirms it is gone.

    A container started with ``--rm`` may already be mid-removal ("removal ... already in progress"): then this waits,
    within the same bound, until Docker no longer knows the container.
    """
    deadline = time.monotonic() + CLEANUP_TIMEOUT_S
    code, stderr = await _docker(cfg, 'rm', '-f', name, timeout=CLEANUP_TIMEOUT_S)
    if code is not None and _removed(code, stderr):
        return True
    while (left := deadline - time.monotonic()) > 0:
        code, stderr = await _docker(cfg, 'container', 'inspect', name, timeout=left)
        if code is None:
            return False
        if code != 0 and (b'No such' in stderr or b'no such' in stderr):
            return True
        await asyncio.sleep(0.2)
    return False


def reap_orphans(cfg: Config) -> int:
    """Containers (and proxy-mode job networks) whose launcher died are removed once past their deadline label."""
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
    try:
        nets = subprocess.run(
            [cfg.docker, 'network', 'ls', '--filter', f'label={LABEL}=1', '--format', f'{{{{.Name}}}} {{{{.Label "{LABEL}.deadline"}}}}'],
            capture_output=True, text=True, timeout=15, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return reaped
    for line in nets.splitlines():
        name, _, deadline = line.partition(' ')
        if name and (not deadline.isdigit() or int(deadline) < now):
            subprocess.run([cfg.docker, 'network', 'rm', name], capture_output=True, timeout=CLEANUP_TIMEOUT_S, check=False)
    return reaped


class Session:
    def __init__(self, cfg: Config, request: DiscoveryRequest, target: FixtureTarget | LiveTarget, broker: Broker,
                 on_progress: Callable[[int], None] | None = None, deadline: float | None = None) -> None:
        self.cfg, self.request, self.target, self.broker = cfg, request, target, broker
        self.deadline = deadline  # monotonic end of the caller's job budget, when it set one
        self.cleanup_ok: bool | None = None
        self.name = f'vtp-discovery-{request.runId[:40]}-{secrets.token_hex(4)}'
        self.live = target.live
        self.proxy_mode = cfg.target_mode == 'proxy' or self.live
        self.job_key, self.spki = (None, None)
        if self.live:
            from discovery_service.interception import new_job_key

            self.job_key, self.spki = new_job_key()
        self.pages: frozenset[str] = frozenset()
        self.network = f'{self.name}-net' if self.proxy_mode else 'none'
        self.egress_name = f'{self.name}-egress'
        self.blocked: tuple[int, dict[str, int]] | None = (0, {}) if self.proxy_mode else None
        self.proc: asyncio.subprocess.Process | None = None
        self.steps = 0
        self.violations = 0
        self.stderr_bytes = 0
        self.peak_memory: int | None = None  # host-sampled peak of this job's agent container
        self.on_progress = on_progress

    async def _drain_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        debug = os.environ.get('DISCOVERY_DEBUG') == '1'
        while chunk := await self.proc.stderr.read(65536):
            self.stderr_bytes += len(chunk)
            if debug and self.stderr_bytes < 200_000:  # local debugging only: container logs may contain page text
                sys.stderr.write(chunk.decode(errors='replace'))

    async def _sample_memory(self) -> None:
        """Host-side sampling: the container cannot influence these numbers. Samples are about a second apart,
        so a spike shorter than that can be missed; the kernel still enforces the 2 GiB limit."""
        while True:
            used = await container_memory_bytes(self.cfg, self.name)
            if used is not None:
                self.peak_memory = max(self.peak_memory or 0, min(used, 8 * 1024**3))
            await asyncio.sleep(MEMORY_SAMPLE_INTERVAL_S)

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

    def agent_timeout(self) -> float:
        if self.deadline is None:
            return float(AGENT_TIMEOUT_S)
        left = self.deadline - time.monotonic() - STARTUP_RESERVE_S - DELIVERY_MARGIN_S
        return max(MIN_AGENT_TIMEOUT_S, min(float(AGENT_TIMEOUT_S), left))

    async def _serve(self) -> dict[str, Any] | None:
        assert self.proc and self.proc.stdout
        await self._send(
            'start', host=self.target.host, port=self.target.port, path=self.target.path,
            max_steps=min(MAX_AGENT_STEPS, self.broker.max_requests - 1),
            timeout_s=self.agent_timeout(),
            **({'proxy': f'http://{EGRESS_ALIAS}:{EGRESS_PORT}'} if self.proxy_mode else {}),
            **({'scheme': 'https', 'spki': self.spki} if self.live else {}),
            **({'snapshot': [page.model_dump() for page in self.request.snapshot]} if self.request.snapshot else {}),
            **({'focus': focus} if (focus := clean_focus(self.request.focus)) else {}),
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
                if type(steps) is int and self.steps < steps <= self.broker.max_requests:
                    self.steps = steps
                    diag('discovery.progress', runId=self.request.runId, agentSteps=steps)
                    if self.on_progress:
                        self.on_progress(steps)
            elif kind == 'result':
                result = frame.get('result')
                return result if isinstance(result, dict) else None
            else:
                self.violations += 1
                if self.violations >= MAX_PROTOCOL_VIOLATIONS:
                    return None

    async def _start_egress(self, deadline_epoch: int) -> None:
        """Proxy mode: a fresh internal network and egress proxy for this job alone."""
        label = ['--label', f'{LABEL}=1', '--label', f'{LABEL}.deadline={deadline_epoch}']
        for args in (
            ['network', 'create', '--internal', *label, self.network],
            egress_proxy_args(self.cfg, self.target, self.egress_name, self.network, deadline_epoch, self.job_key)[1:],
            ['network', 'connect', self.cfg.live_egress_network if self.live else self.cfg.target_network, self.egress_name],
        ):
            code, _ = await _docker(self.cfg, *args, timeout=30)
            if code != 0:
                raise OSError('egress setup failed')
        for _ in range(50):
            if 'egress.ready' in await self._egress_log():
                return
            await asyncio.sleep(0.1)
        raise OSError('egress proxy did not start')

    async def _egress_log(self) -> str:
        try:
            proc = await asyncio.create_subprocess_exec(
                self.cfg.docker, 'logs', self.egress_name, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), 10)
        except (OSError, TimeoutError):
            return ''
        return out.decode(errors='replace')[:2_000_000]

    async def run(self) -> dict[str, Any] | None:
        deadline_epoch = int(time.time()) + HARD_DEADLINE_S + 30
        if self.proxy_mode:
            try:
                await self._start_egress(deadline_epoch)
            except BaseException:
                await asyncio.shield(self.aclose())
                raise
        self.proc = await asyncio.create_subprocess_exec(
            *docker_args(self.cfg, self.target, self.name, deadline_epoch, self.network),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=MAX_FRAME_BYTES,
            env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), **({'HOME': os.environ['HOME']} if 'HOME' in os.environ else {}),
                 **({'DOCKER_HOST': os.environ['DOCKER_HOST']} if 'DOCKER_HOST' in os.environ else {})},
            start_new_session=True,  # a TERM to Node's process group does not race our own teardown
        )
        drain = asyncio.ensure_future(self._drain_stderr())
        memory = asyncio.ensure_future(self._sample_memory())
        beat = asyncio.ensure_future(self._heartbeat())
        try:
            return await self._serve()
        finally:
            beat.cancel()
            memory.cancel()
            # Shielded: a second cancellation must not interrupt the container's removal.
            await asyncio.shield(self.aclose())
            try:
                # The container is gone; its docker client only needs to notice. Do not hold the caller's budget.
                await asyncio.wait_for(self.proc.wait(), CLIENT_EXIT_GRACE_S)
            except TimeoutError:
                self.proc.kill()
                await self.proc.wait()
            drain.cancel()

    async def aclose(self) -> bool:
        """Stops the runner and removes its container without blocking other jobs' requests. Idempotent."""
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.stdin and self.proc.stdin.close()  # the runner sees EOF and stops
            except OSError:
                pass
        removed = await remove_container(self.cfg, self.name)
        if self.proxy_mode:
            log = await self._egress_log()
            if log:
                self.blocked = count_egress(log)
                if self.live:
                    self.pages = pages_from(log)
            removed = await remove_container(self.cfg, self.egress_name) and removed
            code, stderr = await _docker(self.cfg, 'network', 'rm', self.network, timeout=CLEANUP_TIMEOUT_S)
            removed = removed and (code == 0 or b'not found' in stderr.lower())
        self.cleanup_ok = removed if self.cleanup_ok is None else (self.cleanup_ok and removed)
        if not removed:
            diag('discovery.cleanup_error', runId=self.request.runId)
        return removed


def scoped_paths(known: frozenset[str], start_path: str) -> frozenset[str]:
    """Grounding stays within the requested fixture: only pages under the start page's directory count, so an idea
    about another fixture on the same origin (a benchmark page wandering to the shop at /) is dropped."""
    scope = start_path.rsplit('/', 1)[0] + '/'
    return frozenset(path for path in known if path.startswith(scope))


def to_response(run_id: str, outcome: dict[str, Any] | None, known: frozenset[str]) -> tuple[DiscoveryResponse, str]:
    if outcome is None:
        return DiscoveryResponse(runId=run_id, status='FAILED', reason='no_result'), 'no_result'
    status = outcome.get('status')
    if status == 'cancelled':
        return DiscoveryResponse(runId=run_id, status='CANCELLED', reason='cancelled'), 'cancelled'
    if status == 'completed':
        candidates = sanitize_candidates(outcome.get('output'), known)
        if outcome.get('success') is False or not candidates:
            return DiscoveryResponse(runId=run_id, status='PARTIAL', reason='no_valid_candidates'), 'no_valid_candidates'
        findings = sanitize_findings(outcome.get('output'), known)
        return DiscoveryResponse(runId=run_id, status='COMPLETED', reason='ok', candidates=candidates, findings=findings), 'ok'
    if status == 'timeout':  # only COMPLETED carries candidates
        return DiscoveryResponse(runId=run_id, status='PARTIAL', reason='timeout'), 'timeout'
    if status == 'max_steps':
        return DiscoveryResponse(runId=run_id, status='PARTIAL', reason='max_steps'), 'max_steps'
    return DiscoveryResponse(runId=run_id, status='FAILED', reason='agent_error'), 'agent_error'


async def discover(request: DiscoveryRequest, cfg: Config, model: Any = None,
                   on_progress: Callable[[int], None] | None = None) -> tuple[DiscoveryResponse, dict[str, Any]]:
    """Library entry (tests pass a model object). Returns the wire response and safe statistics."""
    started = time.monotonic()
    try:
        target = match_request(cfg.fixture_url, cfg.live_sites, request.targetUrl, request.live)
    except PolicyError:
        return DiscoveryResponse(runId=request.runId, status='BLOCKED', reason='target_not_allowed'), {'reason': 'target_not_allowed'}
    if request.snapshot and cfg.target_mode != 'bundled':
        return DiscoveryResponse(runId=request.runId, status='BLOCKED', reason='target_not_allowed'), {'reason': 'snapshot_requires_offline_mode'}
    try:
        await asyncio.to_thread(check_live_network if target.live else check_target_mode, cfg)
    except ConfigError as e:
        diag('discovery.config_error', code=str(e)[:80])
        return DiscoveryResponse(runId=request.runId, status='BLOCKED', reason='target_not_allowed'), {'reason': 'target_mode'}
    try:
        chosen = model if model is not None else make_run_model(request.model) if request.model else make_model(cfg.model)
        broker = Broker(chosen, max_requests=request.maxAgentSteps or 20)
    # RuntimeError: Pydantic AI's UserError for a provider whose key is not set (e.g. DEEPSEEK_API_KEY). Without it
    # here, a missing key escaped to the job service and was reported as an agent crash (FAILED / agent_error).
    except (ValueError, ImportError, RuntimeError) as e:
        diag('discovery.config_error', code=type(e).__name__)
        return DiscoveryResponse(runId=request.runId, status='BLOCKED', reason='model_not_configured'), {'reason': 'model_not_configured'}
    # The caller's budget is measured from receipt and includes the reaper, container start and delivery.
    limit = float(request.timeoutSeconds) if request.timeoutSeconds else float(HARD_DEADLINE_S)
    deadline = started + limit
    await asyncio.to_thread(reap_orphans, cfg)
    session = Session(cfg, request, target, broker, on_progress, deadline if request.timeoutSeconds else None)
    deadline_hit = False
    try:
        outcome = await asyncio.wait_for(session.run(), max(1.0, deadline - time.monotonic()))
    except TimeoutError:
        await asyncio.shield(session.aclose())
        outcome, deadline_hit = None, True
    except asyncio.CancelledError:
        await asyncio.shield(session.aclose())
        return DiscoveryResponse(runId=request.runId, status='CANCELLED', reason='cancelled'), {'reason': 'cancelled'}
    except OSError:
        return DiscoveryResponse(runId=request.runId, status='FAILED', reason='docker_unavailable'), {'reason': 'docker_unavailable'}
    # Grounding: the snapshot's pages; on a live site the pages the browser really opened (start page included);
    # else the bundled fixture's pages under the start page.
    known = (frozenset(page.path for page in request.snapshot) if request.snapshot
             else session.pages | {target.path} if target.live
             else scoped_paths(fixture_paths(SITE_DIR), target.path))
    response, reason = to_response(request.runId, outcome, known)
    if deadline_hit:
        reason = response.reason = 'hard_deadline'
    reported_steps = (outcome or {}).get('steps')
    steps = max(session.steps, reported_steps if type(reported_steps) is int and 0 <= reported_steps <= broker.max_requests else 0)
    statistics = DiscoveryStatistics(
        agentSteps=steps, modelRequests=broker.requests,
        inputTokens=min(broker.usage['input'], 100_000_000), outputTokens=min(broker.usage['output'], 1_000_000),
        durationMs=min(int((time.monotonic() - started) * 1000), 240_000),
        modelCostUsd=0 if model is None and not request.model and is_zero_cost(cfg.model) else broker.estimated_cost_usd,
        protocolViolations=min(session.violations, 1000),
        blockedDestinations=None if session.blocked is None else min(session.blocked[0], 100_000),
        blockedByReason=None if session.blocked is None else {k: min(v, 100_000) for k, v in session.blocked[1].items()},
        peakMemoryBytes=session.peak_memory,
    )
    response.statistics = statistics
    stats = {
        'reason': reason,
        **statistics.model_dump(),
        'cleanup': 'ok' if session.cleanup_ok is not False else 'failed',
        **({'blockedByReason': session.blocked[1]} if session.blocked else {}),
        **({'livePages': len(session.pages)} if target.live else {}),
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
        _write(DiscoveryResponse(runId='invalid', status='FAILED', reason='invalid_request'))
        diag('discovery.summary', status='FAILED', reason='invalid_request')
        return 2
    task = asyncio.ensure_future(discover(request, cfg))
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        loop.add_signal_handler(sig, task.cancel)
    try:
        response, stats = await task
    except asyncio.CancelledError:
        response, stats = DiscoveryResponse(runId=request.runId, status='CANCELLED', reason='cancelled'), {'reason': 'cancelled'}
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
