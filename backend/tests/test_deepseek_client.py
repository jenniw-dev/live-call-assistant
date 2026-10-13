import pytest

from app.config import Settings, settings
from app.llm.client import _openai_payload


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


def test_defaults_select_current_deepseek_fast_model():
    cfg = Settings(_env_file=None)

    assert cfg.llm_base_url == "https://api.deepseek.com"
    assert cfg.llm_model == "deepseek-v4-flash"
    assert cfg.llm_enable_thinking is False
    assert cfg.prewarm_enabled is False
    assert cfg.auto_answer is False


def test_fast_mode_uses_deepseek_thinking_object(monkeypatch):
    monkeypatch.setattr(settings, "llm_base_url", "https://api.deepseek.com")
    monkeypatch.setattr(settings, "llm_model", "deepseek-v4-flash")
    monkeypatch.setattr(settings, "llm_enable_thinking", False)

    payload = _openai_payload("question", stream=True)

    assert payload["thinking"] == {"type": "disabled"}
    assert payload["stream"] is True
    assert "enable_thinking" not in payload


def test_deep_mode_enables_deepseek_thinking(monkeypatch):
    monkeypatch.setattr(settings, "llm_base_url", "https://api.deepseek.com")
    monkeypatch.setattr(settings, "llm_model", "deepseek-v4-flash")
    monkeypatch.setattr(settings, "llm_enable_thinking", True)

    payload = _openai_payload("question")

    assert payload["thinking"] == {"type": "enabled"}
