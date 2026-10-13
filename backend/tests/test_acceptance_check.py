import importlib.util
import asyncio
import json
from pathlib import Path

import httpx
import numpy as np
import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "acceptance_check.py"
SPEC = importlib.util.spec_from_file_location("acceptance_check", SCRIPT)
acceptance_check = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(acceptance_check)


class Response:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class OfflineClient:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def get(self, url, timeout):
        self.calls.append((url, timeout))
        return Response(self.payload)


def test_offline_health_check_accepts_manual_deepseek_configuration():
    client = OfflineClient({
        "status": "ok",
        "llm_base_url": "https://api.deepseek.com",
        "auto_answer": False,
        "backend_capture": False,
    })

    acceptance_check.check_health(client, "http://127.0.0.1:8001/api")

    assert client.calls == [("http://127.0.0.1:8001/api/health", 2)]


def test_offline_health_check_rejects_automatic_cloud_submission():
    client = OfflineClient({
        "status": "ok",
        "llm_base_url": "https://api.deepseek.com",
        "auto_answer": True,
        "backend_capture": False,
    })

    with pytest.raises(AssertionError, match="auto_answer"):
        acceptance_check.check_health(client, "http://127.0.0.1:8001/api")


def test_main_default_runs_only_offline_health_validation(monkeypatch):
    monkeypatch.setattr(acceptance_check, "wait_for_health", lambda: {"index_size": 503})

    def live_stream_must_not_run():
        raise AssertionError("default acceptance mode must not invoke live streaming")

    monkeypatch.setattr(acceptance_check, "run_live_acceptance", live_stream_must_not_run)

    assert acceptance_check.main([]) == 0


def test_main_live_flag_is_the_only_path_to_live_acceptance(monkeypatch):
    monkeypatch.setattr(acceptance_check, "run_live_acceptance", lambda: 7)

    assert acceptance_check.main(["--live"]) == 7


def test_live_probe_requires_provider_then_answer_cache_source():
    question = "驗收專用未收錄問題：probe-123"
    calls = []
    provider_answer = "這是一段足夠長的受控回答，用來模擬首次由提供者產生的答案。" * 4

    def stream(question_from_runner):
        calls.append(question_from_runner)
        if len(calls) == 1:
            return {
                "source": "llm",
                "answer": provider_answer,
                "completed": True,
            }
        return {
            "source": "llm_cache",
            "answer": provider_answer,
            "completed": True,
        }

    first, cached = acceptance_check.verify_live_provider_and_cache(stream, question)

    assert calls == [question, question]
    assert first["source"] == "llm"
    assert cached["source"] == "llm_cache"


def test_live_probe_rejects_a_kb_answer_as_provider_evidence():
    def stream(_question):
        return {"source": "kb", "answer": "knowledge-base direct answer", "completed": True}

    with pytest.raises(acceptance_check.AcceptanceError, match="provider"):
        acceptance_check.verify_live_provider_and_cache(stream, "驗收專用未收錄問題：probe-123")


def test_live_probe_requires_its_random_identifier_in_the_provider_answer():
    identifier = "23a3f4709a3148bb9ed588fc2ba8c84c"
    question = f"請說明快取流程，並保留驗收識別碼 {identifier}。"

    def stream(_question):
        return {"source": "llm", "answer": "回答未保留識別碼", "completed": True}

    with pytest.raises(acceptance_check.AcceptanceError, match="identifier"):
        acceptance_check.verify_live_provider_and_cache(stream, question)


def test_live_probe_does_not_issue_second_request_for_an_uncacheable_short_answer():
    identifier = "23a3f4709a3148bb9ed588fc2ba8c84c"
    question = f"請說明快取流程，並保留驗收識別碼 {identifier}。"
    calls = []

    def stream(question_from_runner):
        calls.append(question_from_runner)
        return {
            "source": "llm",
            "answer": f"簡短回答 {identifier}",
            "completed": True,
        }

    with pytest.raises(acceptance_check.AcceptanceError, match="too short"):
        acceptance_check.verify_live_provider_and_cache(stream, question)

    assert calls == [question]


def test_live_probe_minimum_is_not_below_the_answer_cache_threshold():
    from app.llm import answer_cache

    assert acceptance_check.MIN_CACHEABLE_ANSWER_LENGTH >= answer_cache._MIN_ANSWER_LEN


@pytest.mark.parametrize(
    "first",
    [
        {"source": "llm", "answer": "", "completed": True},
        {"source": "llm", "answer": "provider answer", "completed": False},
        {"source": "", "answer": "provider answer", "completed": True},
    ],
)
def test_live_probe_requires_nonempty_completed_first_response(first):
    calls = iter([
        first,
        {"source": "llm_cache", "answer": "provider answer", "completed": True},
    ])

    with pytest.raises(acceptance_check.AcceptanceError):
        acceptance_check.verify_live_provider_and_cache(lambda _question: next(calls), "unique question")


def test_live_probe_uses_real_normal_route_and_cache_with_one_provider_call(monkeypatch):
    """Removing the privileged request bit must leave ordinary retrieval/cache behavior intact."""
    from app.api import routes
    from app.llm import answer_cache, client

    answer_cache._cache.clear()
    monkeypatch.setattr(answer_cache, "_embed", lambda _text: np.array([1.0], dtype=np.float32))
    monkeypatch.setattr(answer_cache.settings, "answer_cache_enabled", True)
    monkeypatch.setattr(answer_cache.settings, "answer_cache_similarity", 0.9)

    retrieval_calls = 0
    provider_calls = 0
    submitted_payloads = []
    identifier = "23a3f4709a3148bb9ed588fc2ba8c84c"
    provider_answer = f"由受控提供者產生的完整答案，驗收識別碼 {identifier}。" * 8

    async def retrieve_normal_decision(_question):
        nonlocal retrieval_calls
        retrieval_calls += 1
        return {
            "kb_hit": False,
            "source": "llm",
            "score": None,
            "file": None,
            "matched_question": None,
            "context": None,
        }

    async def provider_stream(_user_content, _max_tokens):
        nonlocal provider_calls
        provider_calls += 1
        yield provider_answer

    monkeypatch.setattr("app.rag.retriever.retrieve_decision", retrieve_normal_decision)
    monkeypatch.setattr(client, "_stream_openai", provider_stream)
    monkeypatch.setattr(client.settings, "llm_base_url", "https://api.deepseek.com")

    def stream_through_real_route(question, **privileged_options):
        submitted_payloads.append({"question": question, **privileged_options})

        async def collect():
            response = await routes.chat_stream(routes.ChatRequest(**submitted_payloads[-1]))
            events = [
                json.loads(chunk.removeprefix("data: ").strip())
                async for chunk in response.body_iterator
            ]
            meta = next((event for event in events if event.get("type") == "meta"), {})
            done = next((event for event in events if event.get("type") == "done"), None)
            return {
                "source": meta.get("source"),
                "answer": "" if done is None else done.get("answer", ""),
                "completed": done is not None,
            }

        return asyncio.run(collect())

    try:
        first, cached = acceptance_check.verify_live_provider_and_cache(
            stream_through_real_route,
            f"驗收唯一問題，並保留驗收識別碼 {identifier}。",
        )
    finally:
        answer_cache._cache.clear()

    assert submitted_payloads == [
        {"question": f"驗收唯一問題，並保留驗收識別碼 {identifier}。"},
        {"question": f"驗收唯一問題，並保留驗收識別碼 {identifier}。"},
    ]
    assert first["source"] == "llm"
    assert cached["source"] == "llm_cache"
    assert retrieval_calls == 2
    assert provider_calls == 1


def test_llm_source_cannot_be_replaced_by_a_second_client_cache_lookup(monkeypatch):
    """Once the route reports llm, only provider generation may supply its answer."""
    from app.api import routes
    from app.llm import answer_cache, client

    lookup_calls = 0
    provider_calls = 0

    async def retrieve_normal_decision(_question):
        return {
            "kb_hit": False,
            "source": "llm",
            "score": None,
            "file": None,
            "matched_question": None,
            "context": None,
        }

    def cache_filled_after_route_miss(_question):
        nonlocal lookup_calls
        lookup_calls += 1
        return None if lookup_calls == 1 else "concurrent cached answer"

    async def provider_stream(_user_content, _max_tokens):
        nonlocal provider_calls
        provider_calls += 1
        yield "provider answer"

    monkeypatch.setattr("app.rag.retriever.retrieve_decision", retrieve_normal_decision)
    monkeypatch.setattr(answer_cache, "cache_lookup", cache_filled_after_route_miss)
    monkeypatch.setattr(answer_cache, "cache_store", lambda *_args: None)
    monkeypatch.setattr(client, "_stream_openai", provider_stream)
    monkeypatch.setattr(client.settings, "llm_base_url", "https://api.deepseek.com")

    async def collect():
        response = await routes.chat_stream(routes.ChatRequest(question="unique route miss"))
        return [
            json.loads(chunk.removeprefix("data: ").strip())
            async for chunk in response.body_iterator
        ]

    events = asyncio.run(collect())

    assert events[0]["source"] == "llm"
    assert events[1] == {"type": "delta", "text": "provider answer"}
    assert lookup_calls == 1
    assert provider_calls == 1


def test_public_chat_request_rejects_cost_changing_acceptance_options():
    from pydantic import ValidationError

    from app.api.routes import ChatRequest

    with pytest.raises(ValidationError):
        ChatRequest(question="ordinary question", acceptance_provider_probe=True)


def test_stream_answer_hides_local_transport_details(monkeypatch):
    request = httpx.Request("POST", "http://127.0.0.1:8001/api/chat/stream")

    class FailingStream:
        def __enter__(self):
            raise httpx.ConnectError("private-network-detail", request=request)

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(acceptance_check.httpx, "stream", lambda *args, **kwargs: FailingStream())

    with pytest.raises(acceptance_check.AcceptanceError) as captured:
        acceptance_check.stream_answer("驗收專用未收錄問題")

    assert str(captured.value) == "Unable to reach the local stream endpoint."
    assert "private-network-detail" not in str(captured.value)


def test_stream_answer_reduces_unknown_sse_error_to_a_safe_code(monkeypatch):
    class ErrorStream:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def raise_for_status(self):
            return None

        def iter_lines(self):
            return iter(['data: {"type":"error","code":"provider-secret-code","message":"provider-secret-detail"}'])

    monkeypatch.setattr(acceptance_check.httpx, "stream", lambda *args, **kwargs: ErrorStream())

    with pytest.raises(acceptance_check.AcceptanceError) as captured:
        acceptance_check.stream_answer("驗收專用未收錄問題")

    assert str(captured.value) == "DeepSeek stream returned safe error: provider_unavailable"
    assert "provider-secret-detail" not in str(captured.value)
