"""
RAG pipeline for JasmineSathi.

Flow:
  1. Understand query → detect category + location
  2. Search ChromaDB with category filter
  3. Rerank results
  4. Enough high-quality chunks?
     → YES: send chunks + URLs to OpenRouter → return answer
     → NO:  check 24-hr gate
               → due: run deep search → retry
               → not due: return "not yet available" message
"""
from __future__ import annotations

import requests

from app.chatbot.openrouter_answer_generator import generate_openrouter_answer
from app.chatbot.query_understanding import understand_query
from app.ingestion.deep_search_controller import run_deep_search, should_run
from app.retrieval.rag_service import get_research_evidence
from app.retrieval.reranker import rerank_results
from app.retrieval.search import search_knowledge_base
from app.retrieval.vector_store import get_collection_count
from app.storage.mongo_repository import repository

# Minimum score to consider retrieval sufficient and show results (0.20 or 20%)
MIN_SCORE = 0.20
MIN_RESULTS = 1


def _has_enough_results(results: list[dict]) -> bool:
    """True if at least MIN_RESULTS chunks have rerank_score >= MIN_SCORE (0.20)."""
    good = [r for r in results if r.get("rerank_score", r.get("score", 0)) >= MIN_SCORE]
    return len(good) >= MIN_RESULTS


def _build_sources(results: list[dict]) -> list[dict]:
    """Extract unique source pages from top results for the UI, with relevance score."""
    seen = set()
    sources = []
    for result in results:
        meta = result.get("metadata", {})
        page_url = meta.get("page_url", "")
        score = result.get("rerank_score", result.get("score", 0.0))
        if page_url and page_url not in seen:
            seen.add(page_url)
            sources.append({
                "source_name": meta.get("source_name", ""),
                "page_title": meta.get("page_title", ""),
                "page_url": page_url,
                "section": meta.get("section", ""),
                "category": meta.get("category", ""),
                "is_deep_url": meta.get("is_deep_url", "True"),
                "score": round(score, 3),
                "score_percent": round(score * 100, 1),
            })
    return sources


def _safe_get_research_evidence(message: str, top_k: int = 4) -> list[dict]:
    """Retrieve research chunks safely; catches any unexpected exceptions."""
    try:
        return get_research_evidence(message, top_k=top_k)
    except Exception as exc:
        print(f"[RAG] Fallback - Research evidence unavailable: {exc}")
        return []


def answer_question(message: str) -> dict:
    # ── 1. Understand query ──────────────────────────────────
    query_info = understand_query(message)
    category = query_info.get("category")

    # ── 2. Search ChromaDB ───────────────────────────────────
    # If knowledge base is empty, skip search
    kb_count = get_collection_count()
    results: list[dict] = []
    if kb_count > 0:
        results = search_knowledge_base(message, top_k=8, category_filter=category)
        results = rerank_results(results, query_info)
        # If category filter returned nothing meeting threshold, fall back to unfiltered search
        if not _has_enough_results(results) and category:
            unfiltered = search_knowledge_base(message, top_k=8, category_filter=None)
            unfiltered = rerank_results(unfiltered, query_info)
            if _has_enough_results(unfiltered):
                results = unfiltered

    # ── 3. Check if retrieval is sufficient (>= 0.20 threshold) ──
    if _has_enough_results(results):
        # Strictly keep results that meet or exceed the 0.20 threshold
        top_results = [r for r in results if r.get("rerank_score", r.get("score", 0)) >= MIN_SCORE][:5]

        # Retrieve scientific RAG research chunks using the ORIGINAL user question
        rag_chunks = _safe_get_research_evidence(message, top_k=4)

        try:
            answer = generate_openrouter_answer(message, top_results, query_info, rag_chunks=rag_chunks)
            answer_mode = "openrouter" if answer else "insufficient_context"
        except requests.RequestException:
            answer = None
            answer_mode = "openrouter_error"

        if not answer:
            answer = _fallback_answer(top_results, rag_chunks=rag_chunks)
            answer_mode = "local_extractive"

        return {
            "message": message,
            "query_understanding": query_info,
            "answer": answer,
            "answer_mode": answer_mode,
            "sources": _build_sources(top_results),
            "rag_evidence": rag_chunks,
            "retrieval_count": len(top_results),
            "rag_count": len(rag_chunks),
            "knowledge_base_size": kb_count,
            "from_cache": True,
        }

    # ── 4. Not enough results — check 24-hr gate ─────────────
    ds_status = should_run()

    if ds_status.get("due"):
        print("[RAG] Insufficient results. Running deep search...")
        deep_result = run_deep_search(trigger="low_confidence_query")

        if deep_result.get("success"):
            # Retry search after deep search
            results = search_knowledge_base(message, top_k=8, category_filter=category)
            results = rerank_results(results, query_info)
            if not _has_enough_results(results) and category:
                unfiltered = search_knowledge_base(message, top_k=8, category_filter=None)
                unfiltered = rerank_results(unfiltered, query_info)
                if _has_enough_results(unfiltered):
                    results = unfiltered

            top_results = [r for r in results if r.get("rerank_score", r.get("score", 0)) >= MIN_SCORE][:5]

            # Retrieve scientific RAG research chunks using the ORIGINAL user question
            rag_chunks = _safe_get_research_evidence(message, top_k=4)

            if not top_results and not rag_chunks:
                return _no_info_response(message, query_info, reason="No results above the 20% relevance threshold found.")

            try:
                answer = generate_openrouter_answer(message, top_results, query_info, rag_chunks=rag_chunks)
                answer_mode = "openrouter_after_deep_search"
            except requests.RequestException:
                answer = _fallback_answer(top_results, rag_chunks=rag_chunks)
                answer_mode = "local_extractive_after_deep_search"

            return {
                "message": message,
                "query_understanding": query_info,
                "answer": answer or _fallback_answer(top_results, rag_chunks=rag_chunks),
                "answer_mode": answer_mode,
                "sources": _build_sources(top_results),
                "rag_evidence": rag_chunks,
                "retrieval_count": len(top_results),
                "rag_count": len(rag_chunks),
                "knowledge_base_size": get_collection_count(),
                "from_cache": False,
                "deep_search": deep_result,
            }
        else:
            # Deep search failed - check if RAG research evidence is available
            rag_chunks = _safe_get_research_evidence(message, top_k=4)
            if rag_chunks:
                try:
                    answer = generate_openrouter_answer(message, [], query_info, rag_chunks=rag_chunks)
                    answer_mode = "openrouter_scientific_rag"
                except requests.RequestException:
                    answer = _fallback_answer([], rag_chunks=rag_chunks)
                    answer_mode = "local_extractive"
                return {
                    "message": message,
                    "query_understanding": query_info,
                    "answer": answer,
                    "answer_mode": answer_mode,
                    "sources": [],
                    "rag_evidence": rag_chunks,
                    "retrieval_count": 0,
                    "rag_count": len(rag_chunks),
                    "knowledge_base_size": get_collection_count(),
                    "from_cache": False,
                }
            return _no_info_response(message, query_info, reason="Deep search failed: " + deep_result.get("error", "unknown"))
    else:
        # 24-hr gate prevents crawling — check if RAG research evidence has relevant answer
        rag_chunks = _safe_get_research_evidence(message, top_k=4)
        if rag_chunks:
            try:
                answer = generate_openrouter_answer(message, [], query_info, rag_chunks=rag_chunks)
                answer_mode = "openrouter_scientific_rag"
            except requests.RequestException:
                answer = _fallback_answer([], rag_chunks=rag_chunks)
                answer_mode = "local_extractive"
            return {
                "message": message,
                "query_understanding": query_info,
                "answer": answer,
                "answer_mode": answer_mode,
                "sources": [],
                "rag_evidence": rag_chunks,
                "retrieval_count": 0,
                "rag_count": len(rag_chunks),
                "knowledge_base_size": get_collection_count(),
                "from_cache": False,
            }


        return _no_info_response(
            message,
            query_info,
            reason=(
                f"Knowledge base was last updated on "
                f"{ds_status.get('last_successful_run', 'unknown')}. "
                f"Next update allowed at {ds_status.get('next_allowed_run', 'unknown')}."
            ),
        )


def _fallback_answer(results: list[dict], rag_chunks: list[dict] | None = None) -> str:
    parts = []
    if results:
        parts.append("Official Information:")
        for i, r in enumerate(results[:3], 1):
            meta = r.get("metadata", {})
            text = r.get("text", "")[:300]
            parts.append(f"[{i}] {meta.get('source_name', '')}: {text}...")
    if rag_chunks:
        parts.append("\nScientific Research Evidence:")
        for i, c in enumerate(rag_chunks[:2], 1):
            title = c.get("title", "Study")
            text = c.get("text", "")[:300]
            parts.append(f"[{i}] {title}: {text}...")
    if not parts:
        return "No relevant jasmine/floriculture information was found in the verified knowledge base."
    return "\n\n".join(parts)


def _no_info_response(message: str, query_info: dict, reason: str) -> dict:
    return {
        "message": message,
        "query_understanding": query_info,
        "answer": (
            "The verified jasmine/floriculture knowledge base does not yet have "
            "enough information to answer this question. "
            f"({reason})"
        ),
        "answer_mode": "no_data",
        "sources": [],
        "rag_evidence": [],
        "retrieval_count": 0,
        "rag_count": 0,
        "knowledge_base_size": get_collection_count(),
        "from_cache": False,
    }

