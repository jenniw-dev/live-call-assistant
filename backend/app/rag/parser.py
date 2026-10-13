"""Markdown knowledge base parser — extracts Q&A chunks from multiple formats."""

import re
from pathlib import Path

from loguru import logger


# Dedup priority when the same question appears in several files:
# list (filename prefix, rank) pairs here; lower rank wins. Empty = first file wins.
_SOURCE_PRIORITY: tuple[tuple[str, int], ...] = ()


def _source_rank(source_file: str) -> int:
    for prefix, rank in _SOURCE_PRIORITY:
        if source_file.startswith(prefix):
            return rank
    return 3


def _norm_question(question: str) -> str:
    return re.sub(r"\s", "", (question or "").replace("？", "?").replace("：", ":"))


def _dedup_chunks(chunks: list[dict]) -> list[dict]:
    """问题文本相同的 chunk 只保留一条，优先保留更新打磨的来源。
    只对真正的问句（以 ?/？ 结尾）去重——同名小标题（如每个项目各有一节
    "1. 项目背景"）标题同但内容不同，不去重。"""
    best: dict[str, dict] = {}
    for chunk in chunks:
        q = _norm_question(chunk["question"])
        if not q.endswith(("?", "？")):
            continue
        cur = best.get(q)
        if cur is None or _source_rank(chunk["file"]) < _source_rank(cur["file"]):
            best[q] = chunk
    dedupable = [c for c in chunks
                 if _norm_question(c["question"]).endswith(("?", "？"))]
    if len(best) < len(dedupable):
        kept = set(id(c) for c in best.values())
        removed = [c for c in dedupable if id(c) not in kept]
        logger.info(f"🧹 Dedup: removed {len(removed)} duplicate-question chunks, "
                    f"kept higher-priority sources")
        for c in removed:
            logger.info(f"   - [{c['file']}] {c['question'][:30]}")
        non_dedupable = [c for c in chunks
                         if not _norm_question(c["question"]).endswith(("?", "？"))]
        return non_dedupable + list(best.values())
    return chunks


def parse_all_kb_files(kb_dir: Path) -> list[dict]:
    """Parse all .md files in kb_dir (recursively, incl. subdirs like
    agent/ project/ rag/) and return unified Q&A chunks."""
    all_chunks = []

    md_files = sorted(kb_dir.rglob("*.md"))
    if not md_files:
        logger.warning(f"No .md files found in {kb_dir}")
        return all_chunks

    for md_file in md_files:
        try:
            text = md_file.read_text(encoding="utf-8")
            if not text.strip():
                logger.info(f"  ⏭️  Skipping empty file: {md_file.name}")
                continue

            chunks = _parse_markdown(text, source_file=md_file.name)
            all_chunks.extend(chunks)
            logger.info(f"  📄 {md_file.name}: {len(chunks)} chunks")
        except Exception as e:
            logger.error(f"  ❌ Error parsing {md_file.name}: {e}")

    all_chunks = _dedup_chunks(all_chunks)
    logger.info(f"📊 Total: {len(all_chunks)} chunks from {len(md_files)} files")
    return all_chunks


def _parse_markdown(text: str, source_file: str) -> list[dict]:
    """Auto-detect format and parse markdown into Q&A chunks."""
    # Detect format based on patterns present in the file
    if _is_format_a(text):
        return _parse_format_a(text, source_file)
    return _parse_generic(text, source_file)


# ─── Format Detection ────────────────────────────────────────────────────────

def _is_format_a(text: str) -> bool:
    """Format A: ## B01：question (letter + two-digit ID), answer in a blockquote."""
    return bool(re.search(r"^## (?!Q\d)[A-Z]\d{2}[：:]", text, re.MULTILINE))


# ─── Format A Parser ─────────────────────────────────────────────────────────
# Pattern: ## A01：为什么选Agent架构而不是Pipeline？
#          > answer text
#          **追问：follow-up？**
#          > follow-up answer
#          ---

def _parse_format_a(text: str, source_file: str) -> list[dict]:
    chunks = []
    section = _detect_section(text)

    # Split by ## headers (H2 level)
    parts = re.split(r"(?=^## )", text, flags=re.MULTILINE)

    for part in parts:
        part = part.strip()
        if not part:
            continue

        # Match ## [ID]：question
        header_match = re.match(r"^## ([A-Z]\d{2})[：:]\s*(.+)", part)
        if not header_match:
            continue

        q_id = header_match.group(1)
        question = header_match.group(2).strip()
        body = part[header_match.end():].strip()

        if not question or not body:
            continue

        # Extract main answer (blockquote lines)
        answer = _extract_blockquote(body)
        if not answer:
            # Fallback: take first paragraph
            answer = _extract_first_paragraph(body)

        if answer:
            chunks.append(_make_chunk(question, answer, source_file, section, q_id))

        # Extract follow-up questions as separate chunks
        followups = _extract_followups_a(body)
        for fu_q, fu_a in followups:
            chunks.append(_make_chunk(
                fu_q, fu_a, source_file, section, f"{q_id}-followup"
            ))

    return chunks


# ─── Generic Fallback Parser ─────────────────────────────────────────────────

def _parse_generic(text: str, source_file: str) -> list[dict]:
    """Fallback: split by ## headers, treat each section as a chunk."""
    chunks = []
    section = _detect_section(text)

    parts = re.split(r"(?=^## )", text, flags=re.MULTILINE)

    for i, part in enumerate(parts):
        part = part.strip()
        if not part:
            continue

        header_match = re.match(r"^##\s+(.+)", part)
        if not header_match:
            continue

        question = header_match.group(1).strip()
        body = part[header_match.end():].strip()

        # Skip non-question sections
        if len(question) < 5 or _is_meta_section(question):
            continue

        # 架构图/流程图代码块不作为答案主体，取图后的文字段落
        body_no_code = re.sub(r"```[\s\S]*?```", "", body)
        answer = _extract_first_paragraph(body_no_code)
        if answer and len(answer) > 20:
            chunks.append(_make_chunk(
                question, answer, source_file, section, f"S{i}"
            ))

    return chunks


# ─── Utility Functions ───────────────────────────────────────────────────────

def _make_chunk(question: str, answer: str, source_file: str,
                section: str, q_id: str) -> dict:
    """Create a normalized chunk dict, cleaning up the answer text."""
    answer = _clean_answer(answer)
    return {
        "question": question.strip(),
        "answer": answer,
        "file": source_file,
        "section": section,
        "id": q_id,
    }


def _clean_answer(text: str) -> str:
    """Remove markdown artifacts, excess whitespace, code blocks."""
    # Remove code blocks entirely (including the ``` markers)
    text = re.sub(r"```[\s\S]*?```", "", text)
    # Strip heading markers but keep the heading text (答案内的小节标题)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)
    # Remove inline code backticks but keep the text
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # Remove bold/italic markers
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    # Remove blockquote markers
    text = re.sub(r"^>\s*", "", text, flags=re.MULTILINE)
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Remove markdown table separators (|---|---|) but keep content rows
    text = re.sub(r"^\|[-:| ]+\|$", "", text, flags=re.MULTILINE)
    # Collapse whitespace: multiple blank lines → double newline
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Remove lines that are just whitespace or pipe separators
    lines = [l for l in text.split("\n") if l.strip() and l.strip() != "|"]
    text = "\n".join(lines)
    text = text.strip()
    # Truncate to reasonable length
    if len(text) > 800:
        text = text[:800] + "..."
    return text


def _extract_blockquote(text: str) -> str:
    """Extract blockquote content (> prefixed lines)."""
    lines = text.split("\n")
    bq_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(">"):
            bq_lines.append(stripped.lstrip("> ").strip())
        elif bq_lines and stripped:
            # Stop at first non-blockquote non-empty line after blockquote
            break
    return "\n".join(bq_lines).strip()


def _extract_first_paragraph(text: str, max_lines: int = 15) -> str:
    """Extract the first meaningful paragraph block."""
    lines = text.split("\n")
    result = []
    for line in lines[:max_lines]:
        stripped = line.strip()
        # Skip headings and separators
        if stripped.startswith("#") or stripped == "---":
            if result:
                break
            continue
        # Skip known markers
        if stripped.startswith("回答应该覆盖") or stripped.startswith("考察点"):
            continue
        if stripped:
            result.append(stripped)
    return "\n".join(result).strip()


def _extract_followups_a(text: str) -> list[tuple[str, str]]:
    """Extract **Follow-up: question?** (or **追问：**) > answer pairs from Format A."""
    followups = []
    pattern = re.compile(
        r"\*\*(?:追问|Follow-up)[：:](.+?)\*\*\s*\n((?:>.*\n?)+)",
        re.MULTILINE,
    )
    for match in pattern.finditer(text):
        raw_q = match.group(1).strip().rstrip("？?")
        q = raw_q + ("?" if raw_q.isascii() else "？")
        a_lines = match.group(2).strip().split("\n")
        a = "\n".join(l.lstrip("> ").strip() for l in a_lines if l.strip())
        if q and a:
            followups.append((q, a))
    return followups


def _extract_section_content(text: str, section_name: str) -> str:
    """Extract content under ### 【section_name】 heading."""
    pattern = re.compile(
        rf"###\s*【{section_name}】\s*\n([\s\S]*?)(?=^###\s|^\*\*\[|^---|\Z)",
        re.MULTILINE,
    )
    match = pattern.search(text)
    if match:
        return match.group(1).strip()
    return ""


def _extract_section_content_simple(text: str, section_name: str) -> str:
    """Extract content after #### section_name：marker."""
    pattern = re.compile(
        rf"####?\s*{section_name}[：:]\s*\n([\s\S]*?)(?=^#{2,4}\s|^---|\Z)",
        re.MULTILINE,
    )
    match = pattern.search(text)
    if match:
        return match.group(1).strip()
    return ""


def _extract_text_after_pattern(text: str, escaped_pattern: str) -> str:
    """Extract a block of text after a given pattern match."""
    match = re.search(escaped_pattern, text)
    if not match:
        return ""
    after = text[match.end():].strip()
    lines = after.split("\n")
    result = []
    for line in lines[:10]:
        stripped = line.strip()
        if stripped.startswith("#") or stripped == "---":
            break
        if stripped:
            result.append(stripped)
    return "\n".join(result).strip()


def _body_after_h3(body: str, name: str) -> str:
    """Extract content under a ### name heading (标题可带后缀，如「推荐回答（话术模板)」），
    until the next ### heading or end of body."""
    pattern = re.compile(
        rf"^###\s*{re.escape(name)}[^\n]*\n([\s\S]*?)(?=^###\s|\Z)",
        re.MULTILINE,
    )
    match = pattern.search(body)
    return match.group(1).strip() if match else ""


def _strip_number_prefix(title: str) -> str:
    """Strip leading numbering from a section title: '1.1 xxx' / '案例 1：xxx'."""
    t = re.sub(r"^\d+(\.\d+)*\s*", "", title)
    t = re.sub(r"^案例\s*\d+[：:]\s*", "", t)
    return t.strip() or title


def _detect_section(text: str) -> str:
    """Extract the top-level section name from the beginning of the file."""
    match = re.search(r"^#\s+(.+)", text, re.MULTILINE)
    if match:
        return match.group(1).strip()[:50]
    return ""


def _is_toc_title(title: str) -> bool:
    """仅跳过纯目录小节（## 目录），避免误伤「项目目录结构」这类正题。"""
    t = title.strip()
    return t == "目录" or (t.startswith("目录") and len(t) <= 6)


def _is_meta_section(title: str) -> bool:
    """Check if a heading is a meta/structural section, not a Q&A."""
    skip_keywords = [
        "目录", "附录", "核心数字", "回答原则", "文档结构",
        "推荐回答关键词", "容易踩坑", "项目概览",
        "使用到的核心技术", "个人能力", "业务场景", "技术架构",
    ]
    return any(kw in title for kw in skip_keywords)
