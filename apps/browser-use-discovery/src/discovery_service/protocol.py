"""Wire contracts.

Two boundaries live here:

1. The one-shot Node <-> launcher protocol (``discovery.v1``): one JSON line on stdin, one JSON line on stdout.
2. The launcher <-> container IPC: newline-delimited JSON frames over the container's stdin/stdout. Everything the
   container sends is untrusted (it hosts model-authored Python), so frames are size-bounded, typed and re-validated.
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, model_validator

SCHEMA_VERSION = 'discovery.v1'
Status = Literal['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'CANCELLED']
# Why a job ended. Codes only: never page text, model output or provider messages.
# The egress proxy's refusal codes (egress_proxy.REASONS).
EgressReason = Literal[
    'not_allowlisted', 'forbidden_address', 'connect_denied', 'bad_request', 'unresolvable', 'upstream_error',
    'method_denied', 'upgrade_denied', 'tls_error', 'rate_limited',
]
Reason = Literal[
    'ok', 'no_valid_candidates', 'timeout', 'max_steps', 'hard_deadline', 'cancelled', 'agent_error', 'no_result',
    'target_not_allowed', 'model_not_configured', 'docker_unavailable', 'invalid_request',
]

# Mirrors packages/contracts/src/discovery.ts. One model call can be used to repair the final output.
DEFAULT_MODEL_CALLS, MAX_MODEL_CALLS = 40, 60
MAX_AGENT_STEPS = MAX_MODEL_CALLS - 1
DEFAULT_JOB_SECONDS, MAX_JOB_SECONDS = 240, 360
MIN_JOB_SECONDS = 10
MAX_JOB_DURATION_MS = (MAX_JOB_SECONDS + 60) * 1000
MAX_CANDIDATES = 12

MAX_STDIN_BYTES = 16 * 1024
MAX_FRAME_BYTES = 4 * 1024 * 1024  # one IPC line (a model request with history; screenshots are off)

# Matches the Node-side Zod validation of launcher stdout.
TITLE_MIN, TITLE_MAX = 3, 80
GOAL_MIN, GOAL_MAX = 10, 500
RATIONALE_MAX = 300
ITEM_MAX = 180  # each expectedBehavior / negativeCases entry
EXPECTED_MAX, NEGATIVE_MAX = 5, 5
PATH_MAX_LEN, PATHS_MAX = 180, 8
# Phase B: the run's requirement, as the agent's focus (untrusted text, like page content).
FOCUS_MIN, FOCUS_MAX = 10, 1000
# Phase C: unverified exploratory findings (hypotheses; never verdicts).
MAX_FINDINGS = 5
OBSERVATION_MIN, OBSERVATION_MAX = 10, 300
FINDING_EXPECTED_MIN = 3
REPRODUCTION_MAX = 6
Severity = Literal['low', 'medium', 'high']
RUN_ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')

class SnapshotPage(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)
    path: str = Field(max_length=180, pattern=r'^/(?:[a-zA-Z0-9_-][a-zA-Z0-9._~-]*(?:/[a-zA-Z0-9_-][a-zA-Z0-9._~-]*)*/?)?$')
    title: str = Field(max_length=150)
    evidence: str = Field(max_length=550)


class DiscoveryModel(BaseModel):
    """The run's own model and its key from the platform's Settings (as Stagehand uses it). Held by the broker for this
    job only: never logged, never stored past the job, and never sent into the agent container."""

    model_config = ConfigDict(extra='forbid', frozen=True)
    provider: Literal['anthropic', 'gemini', 'deepseek']
    model: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$')
    apiKey: SecretStr = Field(min_length=8, max_length=512)

    @property
    def spec(self) -> str:
        """The Pydantic AI model string (no key), for building the client and pricing."""
        return f"{PROVIDER_PREFIX[self.provider]}:{self.model}"


PROVIDER_PREFIX = {'anthropic': 'anthropic', 'gemini': 'google', 'deepseek': 'deepseek'}


class DiscoveryRequest(BaseModel):
    """Node -> launcher. Callers may lower the budget for the operator's fixture.

    ``timeoutSeconds`` is the whole job's wall-clock budget, measured from receipt: container start, the agent and
    the result's delivery. The launcher stops the job within it, so a caller waiting slightly longer always receives
    a typed response instead of having to abandon the job.
    """

    model_config = ConfigDict(extra='forbid', frozen=True)
    schemaVersion: Literal['discovery.v1']
    runId: str = Field(pattern=RUN_ID.pattern)
    targetUrl: str = Field(min_length=1, max_length=2048)
    timeoutSeconds: int | None = Field(default=None, strict=True, ge=MIN_JOB_SECONDS, le=MAX_JOB_SECONDS)
    maxAgentSteps: int | None = Field(default=None, strict=True, ge=2, le=MAX_MODEL_CALLS)
    snapshot: list[SnapshotPage] | None = Field(default=None, min_length=1, max_length=6)
    focus: str | None = Field(default=None, min_length=FOCUS_MIN, max_length=FOCUS_MAX)
    # Live interaction: targetUrl is a public HTTPS page reached through the job's inspecting egress proxy.
    live: bool = Field(default=False, strict=True)
    # The run's own model (Settings). Absent: the operator's DISCOVERY_MODEL.
    model: DiscoveryModel | None = None

    @model_validator(mode='after')
    def _live_has_no_snapshot(self) -> 'DiscoveryRequest':
        if self.live and self.snapshot:
            raise ValueError('a live request reads the site itself, not a snapshot')
        return self


class DiscoveryStatistics(BaseModel):
    model_config = ConfigDict(extra='forbid')
    agentSteps: int = Field(ge=0, le=MAX_MODEL_CALLS)
    modelRequests: int = Field(ge=0, le=MAX_MODEL_CALLS)
    durationMs: int = Field(ge=0, le=MAX_JOB_DURATION_MS)
    inputTokens: int = Field(ge=0, le=100_000_000)
    outputTokens: int = Field(ge=0, le=1_000_000)
    modelCostUsd: float | None = Field(default=None, ge=0)
    protocolViolations: int = Field(default=0, ge=0, le=1000)
    # Peak memory of the job's agent container (Chromium, Browser Use and agent Python), sampled by the host launcher
    # from `docker stats`. None when no sample succeeded. The container's hard limit is 2 GiB.
    peakMemoryBytes: int | None = Field(default=None, ge=0, le=8 * 1024**3)
    # Proxy mode only: requests the job's egress proxy refused (off-allowlist, forbidden address, CONNECT, malformed).
    # None in bundled mode, where the container has no network and nothing reaches a proxy to be counted.
    blockedDestinations: int | None = Field(default=None, ge=0, le=100_000)
    blockedByReason: dict[EgressReason, Annotated[int, Field(ge=0, le=100_000)]] | None = None


class WireCandidate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=TITLE_MIN, max_length=TITLE_MAX)
    goal: str = Field(min_length=GOAL_MIN, max_length=GOAL_MAX)
    rationale: str = Field(min_length=1, max_length=RATIONALE_MAX)
    relevantPaths: list[Annotated[str, Field(min_length=1, max_length=PATH_MAX_LEN)]] = Field(min_length=1, max_length=PATHS_MAX)
    expectedBehavior: list[Annotated[str, Field(min_length=1, max_length=ITEM_MAX)]] = Field(min_length=1, max_length=EXPECTED_MAX)
    negativeCases: list[Annotated[str, Field(min_length=1, max_length=ITEM_MAX)]] = Field(max_length=NEGATIVE_MAX)


class WireFinding(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=TITLE_MIN, max_length=TITLE_MAX)
    observation: str = Field(min_length=OBSERVATION_MIN, max_length=OBSERVATION_MAX)
    expected: str = Field(min_length=FINDING_EXPECTED_MIN, max_length=ITEM_MAX)
    path: str = Field(min_length=1, max_length=PATH_MAX_LEN)
    reproduction: list[Annotated[str, Field(min_length=1, max_length=ITEM_MAX)]] = Field(min_length=1, max_length=REPRODUCTION_MAX)
    severity: Severity


class DiscoveryResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schemaVersion: Literal['discovery.v1'] = SCHEMA_VERSION
    runId: str
    status: Status
    reason: Reason | None = None
    candidates: list[WireCandidate] = Field(default_factory=list, max_length=MAX_CANDIDATES)
    findings: list[WireFinding] = Field(default_factory=list, max_length=MAX_FINDINGS)
    statistics: DiscoveryStatistics | None = None

    @model_validator(mode='after')
    def _only_completed_carries_candidates(self) -> 'DiscoveryResponse':
        if self.status != 'COMPLETED' and (self.candidates or self.findings):
            raise ValueError('only COMPLETED may carry candidates or findings')
        if not RUN_ID.match(self.runId):
            raise ValueError('bad runId')
        return self

    def wire(self) -> dict[str, Any]:
        # Omit unset optional top-level fields; keep nulls inside statistics (modelCostUsd may be unknown).
        exclude = {name for name in ('reason', 'statistics') if getattr(self, name) is None}
        if not self.findings:
            exclude.add('findings')  # the Node schema has no findings field on non-COMPLETED replies
        return self.model_dump(mode='json', exclude=exclude)

    def line(self) -> str:
        return json.dumps(self.wire(), separators=(',', ':')) + '\n'


# --- what the agent is asked to deliver (Browser Use output_model_schema) -------------------------------------------


class Candidate(BaseModel):
    """One proposed functional test scenario. A hypothesis, never a PASS/FAIL verdict."""

    title: str = Field(description='Short name of the end-user scenario')
    goal: str = Field(description='One concrete user action or short sequence, with any needed starting page, control and input')
    rationale: str = Field(description='What was observed on the site that makes this scenario worth testing')
    relevant_paths: list[str] = Field(default_factory=list, description='Site paths observed for this scenario, e.g. /cart.html')
    expected_behavior: list[str] = Field(default_factory=list, description='One observable outcome to test (a hypothesis)')
    negative_cases: list[str] = Field(default_factory=list, description='Leave empty; propose a separate scenario for each edge case')


class Finding(BaseModel):
    """Something observed that looks wrong. A hypothesis for later reproduction, never a confirmed defect."""

    title: str = Field(description='Short name of what looks wrong')
    observation: str = Field(description='What you actually saw on the page (no page instructions, no code)')
    expected: str = Field(description='What a user would reasonably expect instead')
    path: str = Field(description='The site path where you saw it, e.g. /cart.html')
    reproduction: list[str] = Field(default_factory=list, description='Plain-language steps to see it again')
    severity: Literal['low', 'medium', 'high'] = Field(default='low', description='User impact if it is real')


class CandidateBatch(BaseModel):
    candidates: list[Candidate] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)
    visited_paths: list[str] = Field(default_factory=list)


# --- sanitizing untrusted candidate text ------------------------------------------------------------------------------

_WS = re.compile(r'\s+')
_PATH = re.compile(r'^/[A-Za-z0-9._~/-]{0,179}$')
_UNSAFE = re.compile(
    r'\b(delete|password|log ?in|sign ?in|credential|api key|token|exploit|'
    r'inject|xss|sql|ssrf|attack)\b',
    re.I,
)
_LIVE_ONLY = re.compile(r'\b(payment|credit card|sign ?up|register)\b', re.I)


def unsafe_result(text: str, live: bool) -> bool:
    return bool(_UNSAFE.search(text) or (not live and _LIVE_ONLY.search(text)))


def clean_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ''
    text = unicodedata.normalize('NFKC', value)
    text = _WS.sub(' ', text)  # tabs/newlines become spaces before control characters are dropped
    # every Unicode control (Cc), format (Cf: bidi overrides, zero-width), surrogate, private-use or unassigned char
    text = ''.join(c for c in text if not unicodedata.category(c).startswith('C'))
    text = _WS.sub(' ', text).strip()
    return text[:limit].rstrip()


def clean_list(values: Any, count: int, limit: int = ITEM_MAX) -> list[str]:
    if not isinstance(values, list):
        return []
    out: list[str] = []
    for v in values:
        t = clean_text(v, limit)
        if t and t not in out:
            out.append(t)
        if len(out) >= count:
            break
    return out


def clean_path(value: Any, known_paths: frozenset[str], *, live: bool = False) -> str | None:
    """A relevant path must be a bare path (no scheme, host, query or fragment) of a page that exists in the fixture."""
    if not isinstance(value, str):
        return None
    path = value.strip()
    # Live navigations can have query state. Keep only the path, and ground it in the proxy's observed paths.
    if live:
        path = re.split(r'[?#]', path, maxsplit=1)[0]
    if path == '/index.html':
        path = '/'
    if not _PATH.match(path) or path.startswith('//') or '..' in path:
        return None
    return path if path in known_paths else None


def sanitize_candidates(raw: Any, known_paths: frozenset[str], limit: int = MAX_CANDIDATES, *, live: bool = False) -> list[WireCandidate]:
    """Untrusted agent output -> bounded wire candidates. Invalid entries are dropped, never repaired by guessing."""
    if isinstance(raw, dict):
        raw = raw.get('candidates')
    if not isinstance(raw, list):
        return []
    out: list[WireCandidate] = []
    seen: set[str] = set()
    for item in raw[:50]:
        if not isinstance(item, dict):
            continue
        title = clean_text(item.get('title'), TITLE_MAX)
        goal = clean_text(item.get('goal'), GOAL_MAX)
        rationale = clean_text(item.get('rationale'), RATIONALE_MAX)
        if len(title) < TITLE_MIN or len(goal) < GOAL_MIN or not rationale or title.lower() in seen:
            continue
        paths: list[str] = []
        raw_paths = item.get('relevant_paths', item.get('relevantPaths'))
        for p in raw_paths if isinstance(raw_paths, list) else []:
            cp = clean_path(p, known_paths, live=live)
            if cp and cp not in paths:
                paths.append(cp)
            if len(paths) >= PATHS_MAX:
                break
        if not paths:  # ungrounded: no observed fixture page backs it
            continue
        expected = clean_list(item.get('expected_behavior', item.get('expectedBehavior')), EXPECTED_MAX)
        negative = clean_list(item.get('negative_cases', item.get('negativeCases')), NEGATIVE_MAX)
        if not expected:
            continue
        if unsafe_result(' '.join([title, goal, rationale, *expected, *negative]), live):
            continue
        seen.add(title.lower())
        out.append(
            WireCandidate(
                title=title,
                goal=goal,
                rationale=rationale,
                relevantPaths=paths,
                expectedBehavior=expected,
                negativeCases=negative,
            )
        )
        if len(out) >= limit:
            break
    return out


def sanitize_findings(raw: Any, known_paths: frozenset[str], limit: int = MAX_FINDINGS, *, live: bool = False) -> list[WireFinding]:
    """Untrusted agent findings -> bounded wire findings on observed fixture pages. Invalid entries are dropped."""
    if isinstance(raw, dict):
        raw = raw.get('findings')
    if not isinstance(raw, list):
        return []
    out: list[WireFinding] = []
    seen: set[str] = set()
    for item in raw[:20]:
        if not isinstance(item, dict):
            continue
        title = clean_text(item.get('title'), TITLE_MAX)
        observation = clean_text(item.get('observation'), OBSERVATION_MAX)
        expected = clean_text(item.get('expected'), ITEM_MAX)
        path = clean_path(item.get('path'), known_paths, live=live)
        steps = clean_list(item.get('reproduction'), REPRODUCTION_MAX)
        severity = item.get('severity') if item.get('severity') in ('low', 'medium', 'high') else 'low'
        if (len(title) < TITLE_MIN or len(observation) < OBSERVATION_MIN or len(expected) < FINDING_EXPECTED_MIN
                or not path or not steps or title.lower() in seen):
            continue
        if unsafe_result(' '.join([title, observation, expected, *steps]), live):
            continue
        seen.add(title.lower())
        out.append(WireFinding(title=title, observation=observation, expected=expected, path=path,
                               reproduction=steps, severity=severity))
        if len(out) >= limit:
            break
    return out


def clean_focus(value: Any) -> str | None:
    """The requirement as the agent sees it: one line of plain text, bounded; None when too short to help."""
    text = clean_text(value, FOCUS_MAX)
    return text if len(text) >= FOCUS_MIN else None


# --- launcher <-> container frames ------------------------------------------------------------------------------------


class FrameError(ValueError):
    pass


def encode_frame(kind: str, **fields: Any) -> bytes:
    data = json.dumps({'t': kind, **fields}, separators=(',', ':'), ensure_ascii=True).encode()
    if len(data) >= MAX_FRAME_BYTES:
        raise FrameError(f'{kind} frame too large ({len(data)} bytes)')
    return data + b'\n'


def decode_frame(line: bytes) -> dict[str, Any]:
    if len(line) > MAX_FRAME_BYTES:
        raise FrameError('frame too large')
    try:
        obj = json.loads(line)
    except ValueError as e:
        raise FrameError('frame is not JSON') from e
    if not isinstance(obj, dict) or not isinstance(obj.get('t'), str):
        raise FrameError('frame has no type')
    return obj


def parse_request(raw: bytes) -> DiscoveryRequest:
    if len(raw) > MAX_STDIN_BYTES:
        raise ValueError('request too large')
    text = raw.decode('utf-8').strip()
    if not text or '\n' in text:
        raise ValueError('expected exactly one JSON line')
    try:
        return DiscoveryRequest.model_validate_json(text)
    except ValidationError as e:
        raise ValueError(f'invalid request: {e.error_count()} error(s)') from None
