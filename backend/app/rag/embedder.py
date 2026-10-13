"""BGE Embedding model wrapper — load once, encode many."""

import numpy as np
from loguru import logger

from app.config import settings

# Module-level model cache (loaded once at startup)
_model = None


def load_embedder():
    """Load the sentence-transformer model into memory."""
    global _model
    if _model is not None:
        return _model

    from sentence_transformers import SentenceTransformer

    logger.info(f"Loading embedding model: {settings.embedding_model} ...")
    _model = SentenceTransformer(settings.embedding_model)
    logger.info(f"Model loaded. Dimension: {settings.embedding_dimension}")
    return _model


def embed_texts(texts: list[str]) -> np.ndarray:
    """Encode a batch of texts into normalized vectors.

    Returns:
        numpy array of shape (len(texts), embedding_dimension), float32.
        Vectors are L2-normalized so dot product == cosine similarity.
    """
    model = load_embedder()
    embeddings = model.encode(
        texts,
        normalize_embeddings=True,  # L2 normalize → dot product = cosine
        show_progress_bar=False,
        batch_size=64,
    )
    return np.array(embeddings, dtype=np.float32)


def embed_query(text: str) -> np.ndarray:
    """Encode a single query text into a normalized vector.

    Returns:
        numpy array of shape (embedding_dimension,), float32.
    """
    model = load_embedder()
    embedding = model.encode(
        [text],
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return np.array(embedding[0], dtype=np.float32)
