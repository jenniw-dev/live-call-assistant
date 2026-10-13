# -*- coding: utf-8 -*-
"""离线重建 FAISS 索引（不需要启动后端服务）。

逻辑与 POST /api/rebuild 完全一致：
    parse_all_kb_files → embed(question + answer[:200]) → build_and_save_index

用法（必须从 backend/ 目录运行，保证 .env 的相对路径 FAISS_INDEX_PATH=./data/faiss_index 解析正确）：
    cd backend
    python ../scripts/rebuild_index_offline.py
"""
import io
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# 保证能 import app.*（backend/ 目录）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'backend'))

from app.config import settings                      # noqa: E402
from app.rag.parser import parse_all_kb_files         # noqa: E402
from app.rag.embedder import embed_texts              # noqa: E402
from app.rag.index import build_and_save_index        # noqa: E402

kb_dir = settings.kb_path
if not kb_dir.exists():
    sys.exit(f'KB directory not found: {kb_dir}')

print(f'📂 Parsing knowledge base from {kb_dir} ...')
chunks = parse_all_kb_files(kb_dir)
if not chunks:
    sys.exit('No Q&A chunks found in KB files')

print(f'📦 Embedding {len(chunks)} chunks ...')
texts_to_embed = [f"{c['question']} {c['answer'][:200]}" for c in chunks]
vectors = embed_texts(texts_to_embed)

print('🔨 Building FAISS index ...')
index_dir = Path(settings.faiss_index_path)
if not index_dir.is_absolute():
    # .env 中是相对路径（./data/faiss_index），相对 backend/ 目录解析
    index_dir = Path(__file__).resolve().parent.parent / 'backend' / settings.faiss_index_path
build_and_save_index(vectors, chunks, index_dir)

from collections import Counter                      # noqa: E402
per_file = Counter(c['file'] for c in chunks)
print(f'✅ Done: {len(chunks)} chunks from {len(per_file)} files -> {index_dir}')
