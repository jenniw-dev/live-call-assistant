"""acceptance_check.py — Mac 成品驗收。

預設只驗證本機 health 設定，不會呼叫 DeepSeek。使用者在成品 app 內
輸入自己的 Key 後，才可明確傳入 ``--live`` 執行串流驗收。

``--live`` 會送出一個帶隨機識別碼的普通問題。第一次回應必須明確來自
DeepSeek 生成路徑，第二次相同的普通請求必須命中本機回答快取。兩次請求都
必須完整結束且回答內容一致；驗收不依賴網路延遲門檻。
"""
import argparse
import json
import re
import time
import uuid

import httpx

BASE = "http://127.0.0.1:8001/api"
SAFE_STREAM_ERROR_CODES = {
    "invalid_api_key", "insufficient_balance", "rate_limited", "timeout",
    "network_error", "provider_unavailable",
}
MIN_CACHEABLE_ANSWER_LENGTH = 80


class AcceptanceError(RuntimeError):
    """A non-secret failure suitable for local acceptance output."""


def check_health(client, base: str = BASE) -> dict:
    """Assert the local, manual-only configuration without making a cloud call."""
    response = client.get(f"{base}/health", timeout=2)
    response.raise_for_status()
    health = response.json()
    assert health["status"] == "ok", health
    assert health["llm_base_url"] == "https://api.deepseek.com", health
    assert health["auto_answer"] is False, health
    assert health["backend_capture"] is False, health
    return health


def wait_for_health(client=httpx, base: str = BASE, attempts: int = 60) -> dict | None:
    for _ in range(attempts):
        try:
            return check_health(client, base)
        except (httpx.HTTPError, AssertionError, KeyError, ValueError):
            time.sleep(1)
    return None


def stream_answer(question: str, base: str = BASE) -> dict:
    """调用流式端点，返回 {ttft, total, answer, source, score}。"""
    t0 = time.time()
    ttft = None
    parts = []
    meta = {}
    completed = False
    try:
        with httpx.stream(
            "POST",
            f"{base}/chat/stream",
            json={"question": question},
            timeout=120,
        ) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    ev = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "meta":
                    meta = ev
                elif ev.get("type") == "delta":
                    if ttft is None and ev.get("text", "").strip():
                        ttft = time.time() - t0
                    parts.append(ev.get("text", ""))
                elif ev.get("type") == "error":
                    code = str(ev.get("code", "provider_unavailable"))
                    safe_code = code if code in SAFE_STREAM_ERROR_CODES else "provider_unavailable"
                    raise AcceptanceError(f"DeepSeek stream returned safe error: {safe_code}")
                elif ev.get("type") == "done":
                    completed = True
    except httpx.HTTPError:
        raise AcceptanceError("Unable to reach the local stream endpoint.") from None
    return {"ttft": ttft, "total": time.time() - t0,
            "answer": "".join(parts), "source": meta.get("source"),
            "score": meta.get("score"), "completed": completed}


def make_live_acceptance_question() -> str:
    """Create a unique ordinary question for the normal retrieval/generation path."""
    return (
        "請用繁體中文說明軟體專案中如何設計可重複驗證的回答快取流程，"
        f"並在回答結尾原樣保留本次驗收識別碼 {uuid.uuid4().hex}。"
    )


def verify_live_provider_and_cache(streamer, question: str) -> tuple[dict, dict]:
    """Use two normal requests: provider-backed completion, then answer-cache hit."""
    first = streamer(question)
    if (
        first.get("source") not in {"llm", "llm_refine"}
        or not str(first.get("answer", "")).strip()
        or first.get("completed") is not True
    ):
        raise AcceptanceError("First acceptance request did not receive a completed provider answer.")
    identifier = re.search(r"(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])", question)
    if identifier and identifier.group(0) not in str(first.get("answer", "")):
        raise AcceptanceError("Provider answer did not retain the randomized acceptance identifier.")
    if len(str(first.get("answer", ""))) < MIN_CACHEABLE_ANSWER_LENGTH:
        raise AcceptanceError(
            "Provider answer is too short for the local answer cache; refusing a second live request."
        )

    cached = streamer(question)
    if (
        cached.get("source") != "llm_cache"
        or not str(cached.get("answer", "")).strip()
        or cached.get("completed") is not True
    ):
        raise AcceptanceError("Repeated acceptance request did not report an answer-cache source.")
    if cached.get("answer") != first.get("answer"):
        raise AcceptanceError("Answer-cache result did not match the provider answer.")
    return first, cached


def run_live_acceptance(
    streamer=stream_answer,
    health_waiter=wait_for_health,
    probe_question_factory=make_live_acceptance_question,
):
    print("=" * 70)
    print("等待服务就绪...")
    health = health_waiter()
    if health is None:
        print("服務未就緒或 health 設定不符合手動 DeepSeek 模式，退出")
        return 1
    print(f"健康檢查通過：index_size={health.get('index_size', 'unknown')}")

    try:
        first, cached = verify_live_provider_and_cache(streamer, probe_question_factory())
    except AcceptanceError as error:
        print(f"Live provider verification failed: {error}")
        return 1

    print("Live provider verification passed: first source=llm; repeated source=llm_cache.")
    print(f"Provider first-token latency={first['ttft']!r}s; cache first-token latency={cached['ttft']!r}s")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="驗收本機 Live Call Assistant 後端")
    parser.add_argument(
        "--live",
        action="store_true",
        help="在使用者已於 app 內輸入自己的 Key 後，執行會產生 DeepSeek 用量的串流驗收",
    )
    args = parser.parse_args(argv)
    if args.live:
        return run_live_acceptance()

    health = wait_for_health()
    if health is None:
        print("離線 health 驗收失敗：服務未就緒或設定不符")
        return 1
    print("離線 health 驗收通過：未呼叫 DeepSeek。若要驗證串流，請在 app 內輸入自己的 Key 後執行 --live。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
