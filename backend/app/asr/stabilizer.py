"""Transcript Stabilizer（需求第八条）—— 解决实时识别文字跳动。

维护每个会话的两层文本：
  stable_text  —— 已稳定文本：连续 confirm_rounds 次 partial 保持一致的前缀，
                  一旦固化不再回退（用户看到的文字不跳动）；
  partial_text —— 最新原始 partial（含未稳定尾部）。

规则：
  - 每次 feed(partial)：取最近 confirm_rounds 次 partial 的最长公共前缀，
    与已固化文本比较 —— 只允许向后增长，不允许缩短（ASR 修正已稳定段的情况
    极少，且代价是界面跳动，宁可保留稳定文本）；
  - finalize(text)：语句结束，整段固化（完整问题不需要稳定窗口）；
  - reset()：新会话/新一轮问题时清空。
"""

from __future__ import annotations

import time


def _common_prefix(a: str, b: str) -> str:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return a[:i]


class TranscriptStabilizer:
    """单会话文本稳定器。"""

    def __init__(self, confirm_rounds: int = 2):
        self.confirm_rounds = max(2, confirm_rounds)
        self.stable_text: str = ""          # 已固化（不回退）
        self._recent: list[str] = []        # 最近 N 次 partial 原文

    def feed(self, partial: str) -> str:
        """输入新的 partial，返回当前可展示的 stable_text。"""
        partial = (partial or "").strip()
        if not partial:
            return self.stable_text

        self._recent.append(partial)
        if len(self._recent) > self.confirm_rounds:
            self._recent.pop(0)

        if len(self._recent) < self.confirm_rounds:
            # 样本不足：保持既有稳定文本
            return self.stable_text

        # 最近 N 次 partial 的最长公共前缀 = 候选稳定文本
        candidate = self._recent[0]
        for p in self._recent[1:]:
            candidate = _common_prefix(candidate, p)

        # 只增长不缩短（防跳动）；候选必须覆盖已固化文本才接受
        if len(candidate) > len(self.stable_text) and candidate.startswith(self.stable_text):
            self.stable_text = candidate
        return self.stable_text

    def finalize(self, text: str) -> str:
        """语句结束：整段固化为稳定文本。"""
        text = (text or "").strip()
        if text:
            self.stable_text = text
            self._recent.clear()
        return self.stable_text

    def reset(self) -> None:
        self.stable_text = ""
        self._recent.clear()


class StabilizerManager:
    """会话级稳定器管理：session_id → TranscriptStabilizer，带 TTL 清理。"""

    def __init__(self, ttl_s: int = 300):
        self._map: dict[str, tuple[TranscriptStabilizer, float]] = {}
        self._ttl_s = ttl_s

    def get(self, session_id: str) -> TranscriptStabilizer:
        self._cleanup()
        key = session_id or "default"
        if key not in self._map:
            self._map[key] = (TranscriptStabilizer(), time.time())
        st, _ = self._map[key]
        self._map[key] = (st, time.time())
        return st

    def drop(self, session_id: str) -> None:
        self._map.pop(session_id or "default", None)

    def _cleanup(self) -> None:
        now = time.time()
        stale = [k for k, (_, ts) in self._map.items() if now - ts > self._ttl_s]
        for k in stale:
            del self._map[k]


_manager = StabilizerManager()


def get_stabilizer_manager() -> StabilizerManager:
    return _manager
