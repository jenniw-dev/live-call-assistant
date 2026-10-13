"""Run the packaged backend offline and verify its local health contract."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


class SmokeError(RuntimeError):
    """A fixed, non-secret bundle smoke failure."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        return None


def _unused_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _read_health(port: int) -> dict:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/health")
    with opener.open(request, timeout=1) as response:
        if response.status != 200 or response.geturl() != request.full_url:
            raise SmokeError("packaged backend returned an invalid health response")
        return json.loads(response.read().decode("utf-8"))


def _wait_for_expected_health(
    process: subprocess.Popen,
    port: int,
    bge_model: Path,
    timeout: float,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SmokeError("packaged backend exited before health readiness")
        try:
            health = _read_health(port)
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
            time.sleep(0.2)
            continue
        if (
            health.get("status") == "ok"
            and isinstance(health.get("index_size"), int)
            and health["index_size"] > 0
            and health.get("llm_base_url") == "https://api.deepseek.com"
            and health.get("auto_answer") is False
            and health.get("backend_capture") is False
            and health.get("embedding_model") == str(bge_model)
        ):
            return
        raise SmokeError("packaged backend health settings are not offline-safe")
    raise SmokeError("packaged backend health check timed out")


def _stop_owned_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        process.kill()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired as error:
        raise SmokeError("spawned packaged backend could not be stopped") from error


def smoke(app: Path, timeout: float = 180) -> None:
    resources = app / "Contents" / "Resources"
    backend = resources / "backend" / "call-assistant-backend"
    bge_model = resources / "models" / "bge-small-en-v1.5"
    whisper_model = resources / "models" / "faster-whisper-small"
    bundled_index = resources / "data" / "faiss_index"
    knowledge = resources / "data" / "knowledge"
    port = _unused_loopback_port()

    with tempfile.TemporaryDirectory(prefix="aic-bundle-smoke-") as temporary:
        writable_index = Path(temporary) / "faiss_index"
        shutil.copytree(bundled_index, writable_index)
        child_env = os.environ.copy()
        child_env.update({
            "LLM_API_KEY": "offline-verifier-placeholder",
            "LLM_BASE_URL": "https://api.deepseek.com",
            "LLM_MODEL": "deepseek-v4-flash",
            "PREWARM_ENABLED": "false",
            "AUTO_ANSWER": "false",
            "STREAMING_ENGINE": "local",
            "DASHSCOPE_API_KEY": "",
            "BACKEND_CAPTURE_ENABLED": "false",
            "AUDIO_SOURCE": "system",
            "AUDIO_MICROPHONE": "false",
            "BACKEND_HOST": "127.0.0.1",
            "BACKEND_PORT": str(port),
            "KB_DIR": str(knowledge),
            "FAISS_INDEX_PATH": str(writable_index),
            "EMBEDDING_MODEL": str(bge_model),
            "ASR_MODEL": str(whisper_model),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
            "NO_PROXY": "127.0.0.1,localhost",
        })
        process = subprocess.Popen(
            [str(backend)],
            cwd=temporary,
            env=child_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            _wait_for_expected_health(process, port, bge_model, timeout)
        finally:
            _stop_owned_process(process)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args(argv)
    try:
        smoke(args.app.resolve(), args.timeout)
    except (OSError, SmokeError, subprocess.SubprocessError):
        print("Packaged backend offline health smoke failed.", file=os.sys.stderr)
        return 1
    print("Packaged backend offline health smoke passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
