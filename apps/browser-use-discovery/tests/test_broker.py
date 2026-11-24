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


def test_delivery_only_choice_uses_the_structured_output_tools():
    from pydantic_ai.models._tool_choice import resolve_tool_choice

    class DeliveryModel(FunctionModel):
        async def request(self, messages, settings, params):
            assert resolve_tool_choice(settings, params) == 'required'
            return ModelResponse(parts=[TextPart('typed result')])

    b = Broker(DeliveryModel(lambda m, i: None))
    p = ModelRequestParameters(
        output_tools=[ToolDefinition(name='finish', parameters_json_schema={'type': 'object'})],
        allow_text_output=False,
    )
    assert run(b.handle(payload(params=p, settings={'tool_choice': 'required'})))['parts'][0]['content'] == 'typed result'


def test_deepseek_delivery_disables_explicit_forcing_without_enabling_extra_tools():
    class DeepSeekDelivery(FunctionModel):
        @property
        def system(self):
            return 'deepseek'

        async def request(self, messages, settings, params):
            assert settings['tool_choice'] == 'auto'
            assert params.function_tools == []
            assert [tool.name for tool in params.output_tools] == ['finish']
            return ModelResponse(parts=[TextPart('typed result')])

    b = Broker(DeepSeekDelivery(lambda m, i: None))
    params = ModelRequestParameters(
        function_tools=[ToolDefinition(name='python', parameters_json_schema={'type': 'object'})],
        output_tools=[ToolDefinition(name='finish', parameters_json_schema={'type': 'object'})],
        allow_text_output=False,
    )
    assert run(b.handle(payload(params=params, settings={'tool_choice': ['finish']})))['parts'][0]['content'] == 'typed result'


def test_local_models_stay_on_loopback(monkeypatch):
    from discovery_service.broker import is_zero_cost, make_local_model

    monkeypatch.delenv('DISCOVERY_LOCAL_MODEL_URL', raising=False)
    model = make_model('local:openai/gpt-oss-20b')
    assert model.model_name == 'openai/gpt-oss-20b'
    assert is_zero_cost('local:openai/gpt-oss-20b') and is_zero_cost('scripted') and not is_zero_cost('deepseek:deepseek-flash')
    for url in ('https://api.openai.com/v1', 'http://10.0.0.5:1234/v1', 'http://user:pw@127.0.0.1:1234/v1', 'http://169.254.169.254/v1'):
        monkeypatch.setenv('DISCOVERY_LOCAL_MODEL_URL', url)
        with pytest.raises(ValueError):
            make_local_model('openai/gpt-oss-20b')
    monkeypatch.setenv('DISCOVERY_LOCAL_MODEL_URL', 'http://localhost:8080/v1')
    assert make_local_model('qwen/qwen3.5-9b').model_name == 'qwen/qwen3.5-9b'
    with pytest.raises(ValueError):
        make_local_model('bad name; rm')


def test_local_server_gets_the_named_subset_as_required():
    from discovery_service.broker import _named_choice_fallback

    assert _named_choice_fallback(make_model('local:openai/gpt-oss-20b')) == 'required'

    class Local(FunctionModel):
        base_url = 'http://127.0.0.1:1234/v1'

        async def request(self, messages, settings, params):
            # Only an output tool is named: the output tools are the only option under "auto".
            assert settings['tool_choice'] == 'auto'
            assert params.function_tools == []
            assert [tool.name for tool in params.output_tools] == ['finish']
            return ModelResponse(parts=[TextPart('typed result')])

    b = Broker(Local(lambda m, i: None))
    params = ModelRequestParameters(
        function_tools=[ToolDefinition(name='python', parameters_json_schema={'type': 'object'})],
        output_tools=[ToolDefinition(name='finish', parameters_json_schema={'type': 'object'})],
        allow_text_output=False,
    )
    assert run(b.handle(payload(params=params, settings={'tool_choice': ['finish']})))['parts'][0]['content'] == 'typed result'
