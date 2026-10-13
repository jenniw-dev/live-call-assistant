import json

import httpx
import pytest

from app.llm.errors import from_http_error, from_network_error, timeout_error


def make_error(status: int, body: str = "") -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://api.deepseek.com/chat/completions")
    response = httpx.Response(status, request=request, text=body)
    return httpx.HTTPStatusError("request failed", request=request, response=response)


@pytest.mark.parametrize("status", [401, 403])
def test_maps_authentication_without_echoing_response_body(status: int):
    error = from_http_error(make_error(status, "secret-value-from-provider"))

    assert error.code == "invalid_api_key"
    assert error.user_message == "The DeepSeek key is invalid or has no access. Replace it in Settings."
    assert "secret-value-from-provider" not in str(error)


def test_maps_balance_and_rate_limit_errors():
    assert from_http_error(make_error(402)).code == "insufficient_balance"
    assert from_http_error(make_error(429)).code == "rate_limited"


def test_maps_unknown_server_errors():
    error = from_http_error(make_error(503, "provider-internal-detail"))

    assert error.code == "provider_unavailable"
    assert error.user_message == "DeepSeek is temporarily unavailable. Please try again shortly."
    assert "provider-internal-detail" not in str(error)


def test_maps_network_failures_without_echoing_exception_text():
    request = httpx.Request("POST", "https://api.deepseek.com/chat/completions")
    error = from_network_error(httpx.ConnectError("private-network-detail", request=request))

    assert error.code == "network_error"
    assert error.user_message == "Couldn’t reach DeepSeek. Check your internet connection and try again."
    assert "private-network-detail" not in str(error)


def test_maps_timeout_to_a_safe_stable_error():
    error = timeout_error()

    assert error.code == "timeout"
    assert error.user_message == "DeepSeek took too long to answer. Please try again."


@pytest.mark.asyncio
async def test_stream_wraps_request_errors_as_safe_service_errors(monkeypatch):
    from app.llm import answer_cache, client
    from app.llm.errors import LLMServiceError

    async def fail_stream(*args, **kwargs):
        if False:
            yield ""
        request = httpx.Request("POST", "https://api.deepseek.com/chat/completions")
        raise httpx.ConnectError("raw-network-detail", request=request)

    monkeypatch.setattr(answer_cache, "cache_lookup", lambda question: None)
    monkeypatch.setattr(client, "_stream_openai", fail_stream)
    monkeypatch.setattr(client.settings, "llm_base_url", "https://api.deepseek.com")

    with pytest.raises(LLMServiceError) as captured:
        await anext(client.ask_llm_stream("測試問題"))

    assert captured.value.code == "network_error"
    assert captured.value.user_message == "Couldn’t reach DeepSeek. Check your internet connection and try again."
    assert "raw-network-detail" not in str(captured.value)


@pytest.mark.asyncio
async def test_stream_sends_safe_error_after_existing_answer_text(monkeypatch):
    from app.api import routes
    from app.llm.errors import LLMServiceError

    async def fake_decision(question: str):
        return {
            "kb_hit": False,
            "source": "llm",
            "score": None,
            "file": None,
            "matched_question": None,
            "context": None,
        }

    async def fake_stream(question: str, context: str | None):
        yield "已辨識的問題文字"
        raise LLMServiceError("timeout", "DeepSeek took too long to answer. Please try again.")

    monkeypatch.setattr("app.rag.retriever.retrieve_decision", fake_decision)
    monkeypatch.setattr("app.llm.client.ask_llm_stream", fake_stream)

    response = await routes.chat_stream(routes.ChatRequest(question="測試問題"))
    events = [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in response.body_iterator]

    assert [event["type"] for event in events] == ["meta", "delta", "error"]
    assert events[1]["text"] == "已辨識的問題文字"
    assert events[2] == {
        "type": "error",
        "code": "timeout",
        "message": "DeepSeek took too long to answer. Please try again.",
    }
    assert "private-network-detail" not in json.dumps(events, ensure_ascii=False)


@pytest.mark.asyncio
async def test_stream_maps_retrieval_failure_to_safe_local_error(monkeypatch):
    from app.api import routes

    async def fail_decision(question: str):
        raise RuntimeError("private-retrieval-index-detail")

    monkeypatch.setattr("app.rag.retriever.retrieve_decision", fail_decision)

    response = await routes.chat_stream(routes.ChatRequest(question="測試問題"))
    events = [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in response.body_iterator]

    assert events == [{
        "type": "error",
        "code": "local_service_error",
        "message": "The local service couldn’t finish the answer. Please try again shortly.",
    }]
    assert "private-retrieval-index-detail" not in json.dumps(events, ensure_ascii=False)


@pytest.mark.asyncio
async def test_stream_maps_unexpected_generator_failure_after_partial_text(monkeypatch):
    from app.api import routes

    async def fake_decision(question: str):
        return {
            "kb_hit": False,
            "source": "llm",
            "score": None,
            "file": None,
            "matched_question": None,
            "context": None,
        }

    async def fail_stream(question: str, context: str | None):
        yield "已收到的安全文字"
        raise RuntimeError("private-generator-detail")

    monkeypatch.setattr("app.rag.retriever.retrieve_decision", fake_decision)
    monkeypatch.setattr("app.llm.answer_cache.cache_lookup", lambda question: None)
    monkeypatch.setattr("app.llm.client.ask_llm_stream", fail_stream)

    response = await routes.chat_stream(routes.ChatRequest(question="測試問題"))
    events = [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in response.body_iterator]

    assert [event["type"] for event in events] == ["meta", "delta", "error"]
    assert events[-1] == {
        "type": "error",
        "code": "local_service_error",
        "message": "The local service couldn’t finish the answer. Please try again shortly.",
    }
    assert "private-generator-detail" not in json.dumps(events, ensure_ascii=False)


@pytest.mark.asyncio
async def test_stream_reports_answer_cache_without_calling_provider(monkeypatch):
    from app.api import routes

    async def fake_decision(question: str):
        return {
            "kb_hit": False,
            "source": "llm",
            "score": None,
            "file": None,
            "matched_question": None,
            "context": None,
        }

    async def provider_must_not_run(*args, **kwargs):
        raise AssertionError("a cache hit must not invoke the provider stream")
        yield ""

    monkeypatch.setattr("app.rag.retriever.retrieve_decision", fake_decision)
    monkeypatch.setattr("app.llm.answer_cache.cache_lookup", lambda question: "cached provider answer")
    monkeypatch.setattr("app.llm.client.ask_llm_stream", provider_must_not_run)

    response = await routes.chat_stream(routes.ChatRequest(question="驗收專用未收錄問題"))
    events = [json.loads(chunk.removeprefix("data: ").strip()) async for chunk in response.body_iterator]

    assert events == [
        {"type": "meta", "source": "llm_cache", "score": None, "file": None, "matched_question": None},
        {"type": "delta", "text": "cached provider answer"},
        {"type": "done", "answer": "cached provider answer"},
    ]


@pytest.mark.asyncio
async def test_refine_failure_logs_no_raw_provider_exception(monkeypatch):
    from app.llm import client

    async def fail_call(*args, **kwargs):
        raise RuntimeError("provider-secret-detail")

    logs: list[str] = []
    sink_id = client.logger.add(logs.append, format="{message}")
    monkeypatch.setattr(client, "_call_openai", fail_call)
    monkeypatch.setattr(client.settings, "llm_base_url", "https://api.deepseek.com")
    try:
        assert await client.refine_question("原始問題") == "原始問題"
    finally:
        client.logger.remove(sink_id)

    assert "provider-secret-detail" not in "".join(logs)
