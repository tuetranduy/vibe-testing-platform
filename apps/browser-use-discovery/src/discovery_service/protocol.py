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

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

SCHEMA_VERSION = 'discovery.v1'
Status = Literal['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'CANCELLED']

# Hard budgets for this slice. Not caller-configurable.
MAX_AGENT_STEPS = 19  # Browser Use max_steps; +1 possible delivery repair = the broker's 20-call cap
AGENT_TIMEOUT_S = 120
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
RUN_ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


class DiscoveryRequest(BaseModel):
    """Node -> launcher. Unknown fields are rejected: callers cannot pass policy, limits or credentials."""

    model_config = ConfigDict(extra='forbid', frozen=True)
    schemaVersion: Literal['discovery.v1']
    runId: str = Field(pattern=RUN_ID.pattern)
    targetUrl: str = Field(min_length=1, max_length=2048)


class WireCandidate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=TITLE_MIN, max_length=TITLE_MAX)
    goal: str = Field(min_length=GOAL_MIN, max_length=GOAL_MAX)
    rationale: str = Field(min_length=1, max_length=RATIONALE_MAX)
    relevantPaths: list[Annotated[str, Field(min_length=1, max_length=PATH_MAX_LEN)]] = Field(min_length=1, max_length=PATHS_MAX)
    expectedBehavior: list[Annotated[str, Field(min_length=1, max_length=ITEM_MAX)]] = Field(min_length=1, max_length=EXPECTED_MAX)
    negativeCases: list[Annotated[str, Field(min_length=1, max_length=ITEM_MAX)]] = Field(max_length=NEGATIVE_MAX)


class DiscoveryResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schemaVersion: Literal['discovery.v1'] = SCHEMA_VERSION
    runId: str
    status: Status
    candidates: list[WireCandidate] = Field(default_factory=list, max_length=MAX_CANDIDATES)

    @model_validator(mode='after')
    def _only_completed_carries_candidates(self) -> 'DiscoveryResponse':
        if self.status != 'COMPLETED' and self.candidates:
            raise ValueError('only COMPLETED may carry candidates')
        if not RUN_ID.match(self.runId):
            raise ValueError('bad runId')
        return self

    def line(self) -> str:
        return self.model_dump_json() + '\n'


# --- what the agent is asked to deliver (Browser Use output_model_schema) -------------------------------------------


class Candidate(BaseModel):
    """One proposed functional test scenario. A hypothesis, never a PASS/FAIL verdict."""

    title: str = Field(description='Short name of the end-user scenario')
    goal: str = Field(description='What a user tries to achieve')
    rationale: str = Field(description='What was observed on the site that makes this scenario worth testing')
    relevant_paths: list[str] = Field(default_factory=list, description='Site paths observed for this scenario, e.g. /cart.html')
    expected_behavior: list[str] = Field(default_factory=list, description='Expected observable outcomes (hypotheses)')
    negative_cases: list[str] = Field(default_factory=list, description='Invalid input or edge cases worth checking')


class CandidateBatch(BaseModel):
    candidates: list[Candidate] = Field(default_factory=list)
    visited_paths: list[str] = Field(default_factory=list)


# --- sanitizing untrusted candidate text ------------------------------------------------------------------------------

_WS = re.compile(r'\s+')
_PATH = re.compile(r'^/[A-Za-z0-9._~/-]{0,179}$')
# MVP: discovery stays read-only; scenarios about destructive/credentialed flows are dropped, not surfaced.
_UNSAFE = re.compile(
    r'\b(delete|payment|credit card|password|log ?in|sign ?in|sign ?up|register|credential|api key|token|exploit|'
    r'inject|xss|sql|ssrf|attack)\b',
    re.I,
)


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


def clean_path(value: Any, known_paths: frozenset[str]) -> str | None:
    """A relevant path must be a bare path (no scheme, host, query or fragment) of a page that exists in the fixture."""
    if not isinstance(value, str):
        return None
    path = value.strip()
    # bare paths only: an absolute URL (any origin), protocol-relative //host, query or fragment is rejected
    if path == '/index.html':
        path = '/'
    if not _PATH.match(path) or path.startswith('//') or '..' in path:
        return None
    return path if path in known_paths else None


def sanitize_candidates(raw: Any, known_paths: frozenset[str], limit: int = MAX_CANDIDATES) -> list[WireCandidate]:
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
            cp = clean_path(p, known_paths)
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
        if _UNSAFE.search(' '.join([title, goal, rationale, *expected, *negative])):
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
