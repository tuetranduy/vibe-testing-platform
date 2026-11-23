import asyncio

import pytest
from pydantic_ai.messages import ImageUrl, ModelRequest, ModelResponse, TextPart, UserPromptPart, BinaryContent
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.tools import ToolDefinition

from discovery_service.broker import MAX_REQUESTS, Broker, BrokerRefused, make_model
from discovery_service.brokered_model import encode_request


def echo_model(seen):
    def fn(messages, info):
        seen.append(info)
        return ModelResponse(parts=[TextPart('ok')])
    return FunctionModel(fn)


def payload(content='hello', params=None, settings=None):
    msgs = [ModelRequest(parts=[UserPromptPart(content=content)])]
    p = params or ModelRequestParameters(function_tools=[ToolDefinition(name='python', parameters_json_schema={'type': 'object'})])
    return encode_request(msgs, settings or {}, p)


def run(coro):
    return asyncio.run(coro)


def test_roundtrip_and_budget_is_20():
    assert MAX_REQUESTS == 20
    seen = []
    b = Broker(echo_model(seen))
    for _ in range(20):
        out = run(b.handle(payload()))
        assert out['parts'][0]['content'] == 'ok'
    with pytest.raises(BrokerRefused):
        run(b.handle(payload()))
    assert len(seen) == 20


@pytest.mark.parametrize('content', [
    ['look', ImageUrl(url='https://attacker.example/x.png')],
    ['look', BinaryContent(data=b'\x89PNG', media_type='image/png')],
])
def test_media_is_refused(content):
    b = Broker(echo_model([]))
    with pytest.raises(BrokerRefused):
        run(b.handle(payload(content=content)))
    assert b.requests == 0


def test_native_tools_refused():
    from pydantic_ai.native_tools import WebSearchTool  # type: ignore[import-not-found]
    b = Broker(echo_model([]))
    with pytest.raises(BrokerRefused):
        run(b.handle(payload(params=ModelRequestParameters(native_tools=[WebSearchTool()]))))


def test_malformed_refused():
    b = Broker(echo_model([]))
    for bad in (None, [], {'messages': 'x', 'params': {}}, {'messages': [], 'params': {'function_tools': 3}}):
        with pytest.raises(BrokerRefused):
            run(b.handle(bad))


def test_settings_are_clamped():
    captured = {}

    class Spy(FunctionModel):
        async def request(self, messages, settings, params):
            captured.update(settings)
            return ModelResponse(parts=[TextPart('ok')])

    b = Broker(Spy(lambda m, i: None))
    run(b.handle(payload(settings={'max_tokens': 10**9, 'temperature': 9, 'request_timeout': 9999, 'extra_headers': {'x': 1}})))
    assert captured['max_tokens'] == 12_000 and captured['temperature'] == 1.0 and captured['timeout'] == 60.0
    assert 'extra_headers' not in captured


def test_make_model():
    assert make_model('scripted').model_name == 'scripted'
    for bad in ('', 'gpt', 'test', 'function:x'):
        with pytest.raises(ValueError):
            make_model(bad)
