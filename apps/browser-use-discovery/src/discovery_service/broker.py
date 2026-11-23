"""Host side of the model broker.

The container sends ``model_request`` frames; the broker re-validates each one, clamps the few settings it accepts,
enforces a request budget, calls the real model (credential lives only in this host process) and returns the
serialized ``ModelResponse``. Nothing else crosses: no tools, no URLs, no files.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from pydantic import TypeAdapter, ValidationError
from pydantic_ai.messages import BinaryContent, FilePart, FileUrl, ModelMessagesTypeAdapter, ModelResponse, UploadedFile
from pydantic_ai.models import Model, ModelRequestParameters
from pydantic_ai.settings import ToolOrOutput


PARAMS = TypeAdapter(ModelRequestParameters)
RESPONSE = TypeAdapter(ModelResponse)
MAX_REQUESTS = 20  # every model call of a run, delivery repairs and compaction summaries included
MAX_TOKENS = 12_000
REQUEST_TIMEOUT_S = 60.0


class BrokerRefused(Exception):
    pass


def make_model(spec: str) -> Model:
    """DISCOVERY_MODEL: 'scripted' (local, free, deterministic) or a Pydantic AI model string such as
    'anthropic:claude-sonnet-5-5' (its key must be in this host process's environment, never the container's)."""
    if spec in ('scripted', 'scripted:probe'):
        from discovery_service.scripted_model import ScriptedModel

        return ScriptedModel(probe=spec.endswith(':probe'), canary_port=int(os.environ.get('DISCOVERY_PROBE_CANARY_PORT', '9')))
    if ':' not in spec or spec.startswith(('test', 'function')):
        raise ValueError('DISCOVERY_MODEL must be "scripted" or a provider:model string')
    from pydantic_ai.models import infer_model

    return infer_model(spec)


_MEDIA = (FileUrl, BinaryContent, UploadedFile, FilePart)


def _has_media(value: Any, depth: int = 0) -> bool:
    """Any image/audio/video/document by URL (the provider would fetch it) or inline bytes. Screenshots are off, so a
    legitimate request carries text and tool calls only."""
    if depth > 8:
        return True
    if isinstance(value, _MEDIA):
        return True
    if isinstance(value, (list, tuple)):
        return any(_has_media(v, depth + 1) for v in value)
    if isinstance(value, dict):
        return any(_has_media(v, depth + 1) for v in value.values())
    for attr in ('parts', 'content'):
        if hasattr(value, attr) and not isinstance(value, (str, bytes)) and _has_media(getattr(value, attr), depth + 1):
            return True
    return False


def _tool_choice(value: Any, params: ModelRequestParameters) -> Any:
    names = {t.name for t in params.function_tools} | {t.name for t in params.output_tools}
    if value in ('auto', 'none', 'required'):
        return value
    if isinstance(value, dict) and value.get('kind') == 'tools':
        chosen = [n for n in value.get('names', []) if isinstance(n, str) and n in names]
        return chosen or None
    if isinstance(value, dict) and value.get('kind') == 'tool_or_output':
        return ToolOrOutput(function_tools=[n for n in value.get('function_tools', []) if isinstance(n, str) and n in names])
    return None


@dataclass
class Broker:
    model: Model
    max_requests: int = MAX_REQUESTS
    requests: int = 0
    usage: dict[str, int] = field(default_factory=lambda: {'input': 0, 'output': 0})

    async def handle(self, payload: Any) -> dict[str, Any]:
        if self.requests >= self.max_requests:
            raise BrokerRefused('model request budget exhausted')
        if not isinstance(payload, dict):
            raise BrokerRefused('malformed model request')
        try:
            messages = ModelMessagesTypeAdapter.validate_python(payload.get('messages'))
            params = PARAMS.validate_python(payload.get('params'))
        except ValidationError:
            raise BrokerRefused('malformed model request') from None
        if params.native_tools:  # e.g. provider-side web search or code execution: never forwarded
            raise BrokerRefused('native tools are not allowed')
        if _has_media(messages):
            raise BrokerRefused('media content is not allowed')
        raw = payload.get('settings') if isinstance(payload.get('settings'), dict) else {}
        settings: dict[str, Any] = {'max_tokens': MAX_TOKENS, 'timeout': REQUEST_TIMEOUT_S}
        if isinstance(raw.get('max_tokens'), int):
            settings['max_tokens'] = max(256, min(raw['max_tokens'], MAX_TOKENS))
        if isinstance(raw.get('temperature'), (int, float)):
            settings['temperature'] = max(0.0, min(float(raw['temperature']), 1.0))
        if isinstance(raw.get('request_timeout'), (int, float)):
            settings['timeout'] = max(5.0, min(float(raw['request_timeout']), REQUEST_TIMEOUT_S))
        if (choice := _tool_choice(raw.get('tool_choice'), params)) is not None:
            settings['tool_choice'] = choice
        self.requests += 1
        response = await self.model.request(messages, settings, params)  # type: ignore[arg-type]
        self.usage['input'] += int(response.usage.input_tokens or 0)
        self.usage['output'] += int(response.usage.output_tokens or 0)
        return RESPONSE.dump_python(response, mode='json')
