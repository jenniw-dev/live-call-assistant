"""流式 ASR 四项加固的回归测试（不需要外网，用本地假 DashScope 服务器）。

覆盖：
  T1 task-failed 不再静默吞错：start() 必须抛异常（旧代码会把僵死连接当就绪）
  T2 启动重试+降级：连续连接失败 → 重试 N 次 → 降级本地、_fell_back=True
  T3 resume 恢复云端：降级后网络恢复，_restart_engine 重新拉起 dashscope
  T4 push() 发送失败兜底：ws.send 抛异常不炸会话，转走 _on_error

用法: python scripts/test_stream_hardening.py
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.config import settings                       # noqa: E402
from app.asr.streaming import (                       # noqa: E402
    DashScopeStreamEngine, StreamingSession,
)

PASS, FAIL = 0, 0


def check(name: str, ok: bool, detail: str = ""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [PASS] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}  {detail}")


class FakeFrontendWS:
    """模拟前端 WebSocket（只需 send_json 供 session.emit 使用）。"""

    def __init__(self):
        self.sent: list[dict] = []

    async def send_json(self, obj: dict):
        self.sent.append(obj)

    def types(self) -> list[str]:
        return [m.get("type") for m in self.sent]


async def start_fake_dashscope(event: str):
    """本地假 DashScope：收到 run-task 后回 task-started 或 task-failed。"""
    import websockets

    async def handler(ws):
        try:
            await ws.recv()                       # run-task
            await ws.send(json.dumps({
                "header": {
                    "action": "run-task", "task_id": "fake", "streaming": "duplex",
                    "event": event,
                    "error_code": "InvalidApiKey",
                    "error_message": "Invalid API-key provided.",
                },
                "payload": {},
            }))
            if event == "task-started":
                await asyncio.sleep(30)           # 保持连接直到客户端关闭
        except Exception:
            pass

    server = await websockets.serve(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, f"ws://127.0.0.1:{port}/"


def make_session() -> StreamingSession:
    return StreamingSession(FakeFrontendWS())


async def _noop_error(_e: Exception):
    pass


async def t1_task_failed_raises():
    print("T1 task-failed 时 start() 必须抛异常（不再静默就绪）")
    server, url = await start_fake_dashscope("task-failed")
    settings.dashscope_ws_url = url
    settings.dashscope_open_timeout = 5
    raised = None
    try:
        eng = DashScopeStreamEngine("fake-key", None, None, _noop_error)
        await eng.start()
    except Exception as e:
        raised = e
    finally:
        server.close()
        await server.wait_closed()
    check("start() 抛出异常", raised is not None,
          "旧 bug：task-failed 被 _started.set() 掩盖，引擎僵死且显示 ready")
    check("异常信息含 task-failed 错误码",
          raised is not None and "InvalidApiKey" in str(raised), str(raised))


async def t2_boot_retry_then_fallback():
    print("T2 连接持续失败 → 启动重试 N 次 → 降级本地并标记 _fell_back")
    settings.dashscope_ws_url = "ws://127.0.0.1:1/"   # 立即拒绝连接
    settings.dashscope_open_timeout = 2
    settings.stream_boot_retries = 3
    session = make_session()
    await session._boot_engine(attempts=3)
    check("重试耗尽后降级本地", session._engine_kind == "local",
          f"engine_kind={session._engine_kind}")
    check("_fell_back=True（供 resume 重试）", session._fell_back is True)
    check("下发 fallback 事件", "fallback" in session._ws.types(),
          str(session._ws.types()))
    await session.aclose()


async def t3_resume_recovers_cloud():
    print("T3 降级后 resume：网络恢复 → 重新拉起云端引擎")
    # 先制造降级
    settings.dashscope_ws_url = "ws://127.0.0.1:1/"
    settings.dashscope_open_timeout = 2
    session = make_session()
    await session._boot_engine(attempts=2)
    assert session._fell_back and session._engine_kind == "local"
    # 网络恢复（指向可用的假服务器）后 resume 重建
    server, url = await start_fake_dashscope("task-started")
    settings.dashscope_ws_url = url
    await session._restart_engine()
    check("resume 后恢复云端引擎", session._engine_kind == "dashscope",
          f"engine_kind={session._engine_kind}")
    check("_fell_back 复位", session._fell_back is False)
    check("下发 ready(paraformer)",
          any(m.get("type") == "ready" and m.get("engine") == "paraformer"
              for m in session._ws.sent))
    if session._engine:
        await session._engine.close()
    server.close()
    await server.wait_closed()
    await session.aclose()


async def t4_push_failure_no_crash():
    print("T4 push() 发送失败：不抛异常、触发 _on_error")
    errors: list[Exception] = []

    async def on_error(e: Exception):
        errors.append(e)

    async def boom(_payload):
        raise ConnectionError("模拟连接已断")

    eng = DashScopeStreamEngine("fake-key", None, None, on_error)
    eng._ws = type("StubWS", (), {"send": staticmethod(boom),
                                  "close": lambda self: asyncio.sleep(0)})()
    crashed = False
    try:
        await eng.push(b"\x00" * 3200)     # 攒满一帧触发 send
    except Exception:
        crashed = True
    check("push 不上抛异常", not crashed, "旧行为：异常穿透杀死整个会话")
    check("已转交 _on_error（走重连/降级）", len(errors) == 1)


async def main():
    settings.streaming_asr_enabled = True
    await t1_task_failed_raises()
    await t2_boot_retry_then_fallback()
    await t3_resume_recovers_cloud()
    await t4_push_failure_no_crash()
    print(f"\n结果: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


asyncio.run(main())
