"""ASR 后处理层：技术词纠错（term_correct）+ 文本稳定器（stabilizer）。

管线位置（不改动 faster-whisper 主接口，只在转写结果上做后处理）：

    faster-whisper 转写 → 【term_correct 纠错】→ endpoint 决策/会话合并
                          → 【stabilizer 稳定】→ 前端实时显示（防文字跳动）
"""
