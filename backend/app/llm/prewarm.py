"""缓存预热 — 服务启动后在后台预生成 KB 高频题答案，写入 answer_cache。

原理：通话问题高度集中在有限集合（KB 中的常见问题）。预热后，
通话中大部分问题直接命中缓存（~0ms），不再现场调用 LLM。

策略（与真实管线对齐，避免答案质量下降）：
- KB 直接命中题（score>=0.75）→ 不预热（运行时走 0.1s 直出路径，不经 LLM）
- 部分命中/未命中题 → 用 retrieve_decision 取到与运行时一致的 KB context，
  再 ask_llm(question, context) 预生成，保证缓存答案与实时答案同质量
"""

import asyncio

from loguru import logger

from app.config import settings


def _pick_questions(count: int) -> list[str]:
    """从索引元数据均匀取题，覆盖各知识文件。"""
    from app.rag.index import _metadata

    questions = [m["question"] for m in _metadata if m.get("question")]
    if len(questions) <= count:
        return questions
    step = len(questions) / count
    return [questions[int(i * step)] for i in range(count)]


async def prewarm_cache() -> None:
    """预热入口：在 main.py lifespan 中以 asyncio.create_task 调度，不阻塞启动。"""
    if not (settings.prewarm_enabled and settings.answer_cache_enabled):
        logger.info("⏭️  [Prewarm] 跳过（预热或答案缓存未启用）")
        return

    # 吸收 LLM 服务端前缀缓存构建成本（首请求 ~11s）。仅在显式启用预热时
    # 执行，避免默认启动进行任何云端 LLM 请求。
    from app.llm.client import warmup_llm
    await warmup_llm()

    try:
        questions = _pick_questions(settings.prewarm_count)
    except Exception as e:
        logger.warning(f"⚠️  [Prewarm] 加载题目失败，跳过: {e}")
        return
    if not questions:
        return

    from app.llm.client import ask_llm
    from app.rag.retriever import retrieve_decision

    sem = asyncio.Semaphore(settings.prewarm_concurrency)
    done = skipped = failed = 0

    async def warm_one(q: str) -> None:
        nonlocal done, skipped, failed
        async with sem:
            try:
                decision = await retrieve_decision(q)
                if decision.get("kb_hit"):
                    skipped += 1
                    return  # 直出题运行时不走 LLM，无需预热
                await ask_llm(q, decision.get("context"))
                done += 1
            except Exception as e:
                failed += 1
                logger.warning(f"⚠️  [Prewarm] '{q[:30]}' 失败: {e}")

    logger.info(f"🔥 [Prewarm] 开始: {len(questions)} 题, "
                f"并发={settings.prewarm_concurrency}")
    await asyncio.gather(*(warm_one(q) for q in questions))
    logger.info(f"✅ [Prewarm] 完成: 缓存={done}, KB直出跳过={skipped}, 失败={failed}")
