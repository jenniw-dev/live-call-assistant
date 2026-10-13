import pytest

from app.config import Settings, settings
from app.llm import client
from app.llm.prewarm import prewarm_cache


@pytest.fixture(autouse=True)
def clear_provider_environment(monkeypatch):
    for name in (
        "LLM_BASE_URL",
        "LLM_MODEL",
        "LLM_API_KEY",
        "LLM_ENABLE_THINKING",
        "PREWARM_ENABLED",
        "AUTO_ANSWER",
        "STREAMING_ENGINE",
        "DASHSCOPE_API_KEY",
        "BACKEND_CAPTURE_ENABLED",
    ):
        monkeypatch.delenv(name, raising=False)


def test_background_cloud_work_is_disabled():
    cfg = Settings(_env_file=None)

    assert cfg.prewarm_enabled is False
    assert cfg.auto_answer is False
    assert cfg.streaming_engine == "local"
    assert cfg.dashscope_api_key == ""


@pytest.mark.asyncio
async def test_disabled_prewarm_never_calls_cloud_boundary(monkeypatch):
    """Catch startup prewarm invoking a cloud request despite its disabled default."""
    cfg = Settings(_env_file=None)
    cloud_calls = 0

    async def fake_openai_call(*args, **kwargs):
        nonlocal cloud_calls
        cloud_calls += 1
        return {"choices": [{"message": {"content": "unused"}}]}

    monkeypatch.setattr(settings, "llm_base_url", cfg.llm_base_url)
    monkeypatch.setattr(settings, "prewarm_enabled", cfg.prewarm_enabled)
    monkeypatch.setattr(settings, "answer_cache_enabled", cfg.answer_cache_enabled)
    monkeypatch.setattr(client, "_call_openai", fake_openai_call)

    await prewarm_cache()

    assert cloud_calls == 0
