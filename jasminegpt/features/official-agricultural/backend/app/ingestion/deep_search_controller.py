"""
Deep-search controller for JasmineSathi.

Rules:
  - No successful run on record        -> deep search allowed (run it)
  - Last successful run >= 24 h ago    -> deep search allowed (run it)
  - Last successful run < 24 h ago     -> do NOT crawl again; return cached status

The controller:
  1. Checks the 24-hr gate via MongoDB
  2. Crawls all seeds from the source registry
  3. Saves pages + chunks to MongoDB (source of truth)
  4. Rebuilds ChromaDB from MongoDB chunks (search index)
  5. Marks the run as success or failure
"""
from __future__ import annotations

import sys
import io

# Ensure stdout/stderr use UTF-8 on Windows to avoid charmap encoding errors
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from typing import Any

from app.sources.source_registry import get_all_sources
from app.ingestion.crawler import run_all_seeds
from app.processing.chunker import chunk_pages
from app.retrieval.vector_store import rebuild_from_mongo
from app.storage.mongo_repository import repository


def should_run() -> dict[str, Any]:
    """Return the deep-search status dict from MongoDB."""
    return repository.deep_search_status()


def run_deep_search(trigger: str = "manual") -> dict[str, Any]:
    """
    Execute a full deep-search cycle if the 24-hr gate allows it.
    Returns a summary dict.
    """
    status = should_run()

    if not status.get("due", True):
        return {
            "ran": False,
            "reason": status.get("reason", "Daily interval has not elapsed."),
            "last_successful_run": status.get("last_successful_run"),
            "next_allowed_run": status.get("next_allowed_run"),
        }

    run_id = repository.start_run(trigger)
    print(f"\n[DEEP SEARCH] Starting run {run_id} (trigger: {trigger})")

    try:
        # 1. Get seed URLs from registry
        seeds = get_all_sources()
        print(f"[DEEP SEARCH] {len(seeds)} seeds loaded from registry")

        # 2. Crawl all seeds
        pages = run_all_seeds(seeds, max_pages_per_seed=8)
        print(f"[DEEP SEARCH] {len(pages)} pages accepted by crawler")

        if not pages:
            repository.finish_run(run_id, status="failed", error="No pages returned by crawler")
            return {"ran": True, "success": False, "error": "No pages returned by crawler"}

        # 3. Save pages to MongoDB
        pages_saved = repository.save_pages(pages, run_id)
        print(f"[DEEP SEARCH] {pages_saved} pages saved to MongoDB")

        # 4. Chunk pages and save chunks to MongoDB
        chunks = chunk_pages(pages)
        print(f"[DEEP SEARCH] {len(chunks)} chunks created")
        repository.save_chunks(chunks)
        print(f"[DEEP SEARCH] Chunks saved to MongoDB")

        # 5. Rebuild ChromaDB from MongoDB chunks
        all_chunks = repository.get_all_chunks()
        chroma_count = rebuild_from_mongo(all_chunks)
        print(f"[DEEP SEARCH] ChromaDB rebuilt with {chroma_count} vectors")

        # 6. Mark run successful
        repository.finish_run(run_id, status="success", pages_saved=pages_saved)
        print(f"[DEEP SEARCH] Run {run_id} completed successfully")

        return {
            "ran": True,
            "success": True,
            "run_id": run_id,
            "pages_crawled": len(pages),
            "pages_saved": pages_saved,
            "chunks_created": len(chunks),
            "chroma_vectors": chroma_count,
        }

    except Exception as exc:
        error_msg = str(exc)
        print(f"[DEEP SEARCH] ERROR: {error_msg}")
        repository.finish_run(run_id, status="failed", error=error_msg)
        return {"ran": True, "success": False, "run_id": run_id, "error": error_msg}
