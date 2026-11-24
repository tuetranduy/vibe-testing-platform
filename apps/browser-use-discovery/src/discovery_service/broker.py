"""Host side of the model broker.

The container sends ``model_request`` frames; the broker re-validates each one, clamps the few settings it accepts,
enforces a request budget, calls the real model (credential lives only in this host process) and returns the
serialized ``ModelResponse``. Nothing else crosses: no tools, no URLs, no files.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field, replace
from decimal import Decimal
from typing import Any

from genai_prices import calc_price
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
    if spec.startswith('local:'):
        return make_local_model(spec.removeprefix('local:'))
    if ':' not in spec or spec.startswith(('test', 'function')):
        raise ValueError('DISCOVERY_MODEL must be "scripted", "local:<model>" or a provider:model string')
    from pydantic_ai.models import infer_model

    return infer_model(spec)


LOCAL_MODEL_HOSTS = ('127.0.0.1', 'localhost', '::1')


def make_local_model(name: str) -> Model:
    """A zero-cost model served on this host's loopback by an OpenAI-compatible server (LM Studio, llama.cpp, vLLM).

    ``DISCOVERY_LOCAL_MODEL_URL`` (default ``http://127.0.0.1:1234/v1``) must be a loopback HTTP origin: model traffic
    stays on the trusted host, separate from any target-site path, and never needs a provider key.
    """
    from urllib.parse import urlsplit

    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}', name):
        raise ValueError('local model names are letters, digits and . _ / : -')
    url = os.environ.get('DISCOVERY_LOCAL_MODEL_URL', 'http://127.0.0.1:1234/v1')
    parts = urlsplit(url)
    if parts.scheme != 'http' or parts.hostname not in LOCAL_MODEL_HOSTS or parts.username or parts.password or parts.query:
        raise ValueError('DISCOVERY_LOCAL_MODEL_URL must be a loopback http:// URL')
    return OpenAIChatModel(name, provider=OpenAIProvider(base_url=url, api_key='local-no-key'))


def _named_choice_fallback(model: Model) -> str | None:
    """What to send instead of a named tool choice, for providers that reject one; None: send it as is."""
    if model.system == 'deepseek':
        return 'auto'
    from urllib.parse import urlsplit

    base_url = getattr(model, 'base_url', None)
    if isinstance(base_url, str) and urlsplit(base_url).hostname in LOCAL_MODEL_HOSTS:
        return 'required'
    return None


def is_zero_cost(spec: str) -> bool:
    """Scripted and loopback-served models cost nothing per call; their cost is recorded as 0."""
    return spec in ('scripted', 'scripted:probe') or spec.startswith('local:')


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
    if value == 'required' and not params.function_tools and params.output_tools:
        # On the final delivery turn Browser Use can leave only structured output tools.
        # Pydantic AI's "required" selector specifically requires a function tool.
        return 'none'
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
    priced_requests: int = 0
    total_cost: Decimal = Decimal(0)

    @property
    def estimated_cost_usd(self) -> float | None:
        return float(self.total_cost) if self.requests > 0 and self.priced_requests == self.requests else None

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
            forced = _named_choice_fallback(self.model) if isinstance(choice, list) else None
            if forced is not None:
                # DeepSeek's thinking mode and loopback OpenAI-compatible servers (LM Studio) reject naming a tool.
                # Keep the same allowed subset on the wire; local servers still force a call among them.
                names = set(choice)
                params = replace(
                    params,
                    function_tools=[tool for tool in params.function_tools if tool.name in names],
                    output_tools=[tool for tool in params.output_tools if tool.name in names],
                )
                # Only structured output tools left: "required" needs a function tool and "none" becomes a named
                # choice again on the wire, so leave the output tools as the only option under "auto".
                choice = 'auto' if forced == 'required' and not params.function_tools and params.output_tools else forced
            settings['tool_choice'] = choice
        self.requests += 1
        response = await self.model.request(messages, settings, params)  # type: ignore[arg-type]
        self.usage['input'] += int(response.usage.input_tokens or 0)
        self.usage['output'] += int(response.usage.output_tokens or 0)
        try:
            estimate = calc_price(response.usage, self.model.model_name, provider_id=self.model.system)
        except LookupError:
            pass
        else:
            self.priced_requests += 1
            self.total_cost += estimate.total_price
        return RESPONSE.dump_python(response, mode='json')
