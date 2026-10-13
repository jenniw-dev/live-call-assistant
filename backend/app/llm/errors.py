"""Safe, user-facing errors for LLM provider failures."""

from dataclasses import dataclass

import httpx


@dataclass
class LLMServiceError(Exception):
    """A provider failure that is safe to send to the user."""

    code: str
    user_message: str

    def __str__(self) -> str:
        return self.user_message


def from_http_error(error: httpx.HTTPStatusError) -> LLMServiceError:
    """Classify an HTTP failure without inspecting its potentially sensitive body."""
    status = error.response.status_code
    if status in (401, 403):
        return LLMServiceError(
            "invalid_api_key",
            "The DeepSeek key is invalid or has no access. Replace it in Settings.",
        )
    if status == 402:
        return LLMServiceError(
            "insufficient_balance",
            "Your DeepSeek balance is too low. Top up and try again.",
        )
    if status == 429:
        return LLMServiceError(
            "rate_limited",
            "Too many requests to DeepSeek. Wait a few seconds and try again.",
        )
    return provider_unavailable_error()


def timeout_error() -> LLMServiceError:
    return LLMServiceError("timeout", "DeepSeek took too long to answer. Please try again.")


def from_network_error(error: httpx.RequestError) -> LLMServiceError:
    """Map network failures without exposing hostnames, URLs, or exception text."""
    return LLMServiceError("network_error", "Couldn’t reach DeepSeek. Check your internet connection and try again.")


def provider_unavailable_error() -> LLMServiceError:
    return LLMServiceError(
        "provider_unavailable",
        "DeepSeek is temporarily unavailable. Please try again shortly.",
    )
