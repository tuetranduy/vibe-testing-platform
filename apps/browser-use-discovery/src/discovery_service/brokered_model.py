"""Container side of the model broker: a Pydantic AI ``Model`` with no credentials and no network.

Each model request is serialized into one ``model_request`` frame on the container's stdout and answered by the host
launcher (``broker.py``), which owns the real model (or the scripted test model) and its credential. The container
therefore never holds an API key, and its only way out is this narrow request/response channel, which the host
budgets (request count, frame size) and validates.
"""

from __future__ import annotations

import asyncio
import itertools
from typing import Any

from pydantic import TypeAdapter
from pydantic_ai.messages import ModelMessage, ModelMessagesTypeAdapter, ModelResponse
from pydantic_ai.models import Model, ModelRequestParameters
from pydantic_ai.settings import ModelSettings, ToolOrOutput

PARAMS = TypeAdapter(ModelRequestParameters)
RESPONSE = TypeAdapter(ModelResponse)
# The only model settings that cross the boundary; the host clamps them again.
SETTINGS_KEYS = ('max_tokens', 'temperature', 'request_timeout')


def encode_tool_choice(choice: Any) -> Any:
    if choice is None or isinstance(choice, (str, bool)):
        return choice
    if isinstance(choice, ToolOrOutput):
        return {'kind': 'tool_or_output', 'function_tools': list(choice.function_tools)}
    if isinstance(choice, (list, tuple)) and all(isinstance(x, str) for x in choice):
        return {'kind': 'tools', 'names': list(choice)}
    return None  # anything else is dropped (auto)


def encode_request(
    messages: list[ModelMessage], model_settings: ModelSettings | None, params: ModelRequestParameters
) -> dict[str, Any]:
    settings = dict(model_settings or {})
    out = {k: settings[k] for k in SETTINGS_KEYS if isinstance(settings.get(k), (int, float))}
    if 'tool_choice' in settings:
        out['tool_choice'] = encode_tool_choice(settings['tool_choice'])
    return {
        'messages': ModelMessagesTypeAdapter.dump_python(messages, mode='json'),
        'settings': out,
        'params': PARAMS.dump_python(params, mode='json'),
    }


class BrokerChannel:
    """Request/response multiplexing over the frame transport (set up by runner.py)."""

    def __init__(self, send) -> None:  # noqa: ANN001 - send(kind, **fields)
        self._send = send
        self._ids = itertools.count(1)
        self._waiting: dict[int, asyncio.Future] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.loop = asyncio.get_running_loop()
        rid = next(self._ids)
        fut = self.loop.create_future()
        self._waiting[rid] = fut
        try:
            self._send('model_request', id=rid, payload=payload)
            return await fut
        finally:
            self._waiting.pop(rid, None)

    def deliver(self, frame: dict[str, Any]) -> None:
        """From the reader thread."""
        fut = self._waiting.get(frame.get('id'))  # type: ignore[arg-type]
        if fut is None or self.loop is None:
            return

        def settle() -> None:
            if fut.done():
                return
            if frame.get('t') == 'model_response':
                fut.set_result(frame.get('payload') or {})
            else:
                fut.set_exception(RuntimeError(str(frame.get('message', 'model broker error'))[:300]))

        self.loop.call_soon_threadsafe(settle)

    def fail_all(self, message: str) -> None:
        for fut in list(self._waiting.values()):
            if self.loop is not None:
                self.loop.call_soon_threadsafe(lambda f=fut: f.done() or f.set_exception(RuntimeError(message)))


class BrokeredModel(Model):
    def __init__(self, channel: BrokerChannel) -> None:
        super().__init__()
        self._channel = channel

    @property
    def model_name(self) -> str:
        return 'brokered'

    @property
    def system(self) -> str:
        return 'brokered'

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        model_settings, model_request_parameters = self.prepare_request(model_settings, model_request_parameters)
        payload = await self._channel.call(encode_request(messages, model_settings, model_request_parameters))
        return RESPONSE.validate_python(payload)
