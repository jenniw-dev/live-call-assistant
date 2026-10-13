"""FAISS index management — build, save, load, search."""

import json
from pathlib import Path

import faiss
import numpy as np
from loguru import logger

# Module-level index state
_index: faiss.Index | None = None
_metadata: list[dict] = []


def build_and_save_index(vectors: np.ndarray, chunks: list[dict], save_dir: Path):
    """Build a FAISS index from vectors and save to disk with metadata.

    Args:
        vectors: (N, D) float32 array of normalized embeddings
        chunks: list of chunk dicts with question/answer/file/section/id
        save_dir: directory to save index.faiss + metadata.json
    """
    global _index, _metadata

    n_vectors, dimension = vectors.shape
    logger.info(f"Building FAISS index: {n_vectors} vectors, dim={dimension}")

    # Use IndexFlatIP (inner product) — with normalized vectors, IP == cosine similarity
    index = faiss.IndexFlatIP(dimension)
    index.add(vectors)

    # Save to disk
    save_dir.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(save_dir / "index.faiss"))

    # Save metadata as JSON
    meta = []
    for i, chunk in enumerate(chunks):
        meta.append({
            "idx": i,
            "question": chunk["question"],
            "answer": chunk["answer"],
            "file": chunk["file"],
            "section": chunk.get("section", ""),
            "id": chunk.get("id", ""),
        })

    with open(save_dir / "metadata.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    # Update module state
    _index = index
    _metadata = meta

    logger.info(f"Index saved: {save_dir} ({n_vectors} vectors)")


def load_index(save_dir: Path):
    """Load FAISS index and metadata from disk."""
    global _index, _metadata

    index_path = save_dir / "index.faiss"
    meta_path = save_dir / "metadata.json"

    if not index_path.exists():
        logger.warning(f"No index file at {index_path}")
        return

    _index = faiss.read_index(str(index_path))

    if meta_path.exists():
        with open(meta_path, "r", encoding="utf-8") as f:
            _metadata = json.load(f)
    else:
        logger.warning(f"No metadata at {meta_path}")
        _metadata = []

    logger.info(f"Index loaded: {_index.ntotal} vectors, {len(_metadata)} metadata entries")


def search(query_vector: np.ndarray, top_k: int = 3) -> list[dict]:
    """Search the FAISS index for nearest neighbors.

    Args:
        query_vector: (D,) float32 normalized query vector
        top_k: number of results to return

    Returns:
        list of dicts: {score, question, answer, file, section, id}
    """
    if _index is None or _index.ntotal == 0:
        return []

    # Reshape to (1, D) for FAISS
    query = query_vector.reshape(1, -1).astype(np.float32)

    # Search
    scores, indices = _index.search(query, min(top_k, _index.ntotal))

    results = []
    for score, idx in zip(scores[0], indices[0]):
        if idx < 0:
            continue  # FAISS returns -1 for empty slots

        if idx < len(_metadata):
            meta = _metadata[idx]
            results.append({
                "score": float(score),
                "question": meta["question"],
                "answer": meta["answer"],
                "file": meta.get("file", ""),
                "section": meta.get("section", ""),
                "id": meta.get("id", ""),
            })
        else:
            results.append({
                "score": float(score),
                "question": "",
                "answer": "",
                "file": "",
                "section": "",
                "id": "",
            })

    return results


def get_index_size() -> int:
    """Return the number of vectors in the index."""
    if _index is None:
        return 0
    return _index.ntotal


def is_loaded() -> bool:
    """Check if the index is loaded and has vectors."""
    return _index is not None and _index.ntotal > 0
