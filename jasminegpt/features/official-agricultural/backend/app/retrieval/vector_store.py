"""
ChromaDB vector store for JasmineSathi.

Collection: jasmine_india_knowledge_base
Source of truth: MongoDB (jasminesathi.schemes)
This module is a local search index rebuilt from MongoDB chunks.

Key design: after rebuild_from_mongo(), all functions use the new collection
object via the module-level _active_collection variable accessed through
get_collection(). Direct imports of `collection` are avoided to prevent stale refs.
"""
from __future__ import annotations

import sys
from pathlib import Path

import chromadb

from app.config.settings import CHROMA_COLLECTION
from app.retrieval.embeddings import create_embedding


BASE_DIR = Path(__file__).resolve().parents[2]
VECTOR_DB_DIR = BASE_DIR / "vector_db"

client = chromadb.PersistentClient(path=str(VECTOR_DB_DIR))

# Single source of truth for the active collection
_active_collection = client.get_or_create_collection(name=CHROMA_COLLECTION)


def get_collection():
    """Always return the current live collection — safe after rebuild_from_mongo()."""
    return _active_collection


def get_collection_count() -> int:
    return _active_collection.count()


def rebuild_from_mongo(mongo_chunks: list[dict]) -> int:
    """
    Drop and rebuild the ChromaDB collection from MongoDB chunk records.
    Each mongo_chunk must have: chunk_id, text, metadata (dict of str values).
    Returns the number of vectors added.
    """
    global _active_collection

    # Drop old collection
    try:
        client.delete_collection(CHROMA_COLLECTION)
    except Exception:
        pass

    # Create fresh collection and update the global immediately
    _active_collection = client.get_or_create_collection(name=CHROMA_COLLECTION)

    if not mongo_chunks:
        return 0

    # ChromaDB metadata values must all be str/int/float/bool — no lists or None
    def _sanitize(meta: dict) -> dict:
        safe = {}
        for k, v in meta.items():
            if v is None:
                safe[k] = ""
            elif isinstance(v, list):
                safe[k] = ",".join(str(i) for i in v)
            elif isinstance(v, bool):
                safe[k] = str(v)
            else:
                safe[k] = v
        return safe

    ids, documents, embeddings, metadatas = [], [], [], []
    BATCH_SIZE = 50
    total = 0

    for i, chunk in enumerate(mongo_chunks):
        chunk_id = chunk.get("chunk_id") or chunk.get("id") or f"chunk-{i}"
        text = chunk.get("text", "").strip()
        if not text:
            continue

        ids.append(chunk_id)
        documents.append(text)
        embeddings.append(create_embedding(text))
        metadatas.append(_sanitize(chunk.get("metadata", {})))

        # Flush in batches to avoid memory spikes
        if len(ids) >= BATCH_SIZE:
            _active_collection.add(
                ids=ids, documents=documents,
                embeddings=embeddings, metadatas=metadatas,
            )
            total += len(ids)
            ids, documents, embeddings, metadatas = [], [], [], []

    # Flush remainder
    if ids:
        _active_collection.add(
            ids=ids, documents=documents,
            embeddings=embeddings, metadatas=metadatas,
        )
        total += len(ids)

    return total


# ── Legacy helpers ────────────────────────────────────────────

def add_documents(documents, embeddings, ids, metadatas):
    """Upsert document chunks into ChromaDB."""
    _active_collection.upsert(
        documents=documents, embeddings=embeddings,
        ids=ids, metadatas=metadatas,
    )


def replace_collection(documents, embeddings, ids, metadatas) -> int:
    """Legacy helper — kept for backward compatibility."""
    global _active_collection
    try:
        client.delete_collection(CHROMA_COLLECTION)
    except Exception:
        pass
    _active_collection = client.get_or_create_collection(name=CHROMA_COLLECTION)
    if documents:
        _active_collection.add(
            documents=documents, embeddings=embeddings,
            ids=ids, metadatas=metadatas,
        )
    return _active_collection.count()
