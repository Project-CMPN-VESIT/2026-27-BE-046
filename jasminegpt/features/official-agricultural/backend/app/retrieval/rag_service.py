"""
JasmineSathi — Scientific Research RAG Service Integration
=========================================================
Safely loads and interfaces with the GeneralRAG retriever from the `rag/` directory.
Ensures:
  1. The retriever is initialized once (singleton pattern).
  2. Errors are caught and logged without disrupting the main application.
  3. Structured evidence records are returned with standard metadata.
"""
from __future__ import annotations

import logging
import os
import re
import sys
from typing import Any

logger = logging.getLogger(__name__)

# Ensure the root project directory is on sys.path so `rag` package can be imported
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

_rag_instance = None
_rag_initialized = False
_rag_init_error = None


def get_rag_instance():
    """Return the singleton GeneralRAG instance, initializing it on first call."""
    global _rag_instance, _rag_initialized, _rag_init_error

    if _rag_initialized:
        return _rag_instance

    if _rag_init_error is not None:
        # Previously failed to initialize; don't re-crash on every query
        return None

    try:
        from rag.general_rag import GeneralRAG
        logger.info("[RAG Service] Initializing GeneralRAG singleton...")
        instance = GeneralRAG()
        instance.initialize()
        _rag_instance = instance
        _rag_initialized = True
        logger.info("[RAG Service] GeneralRAG singleton initialized successfully.")
        return _rag_instance
    except Exception as exc:
        _rag_init_error = exc
        logger.error(
            "[RAG Service] Failed to initialize GeneralRAG. Research evidence will be omitted: %s",
            exc,
            exc_info=True,
        )
        return None


def _clean_text(s: str) -> str:
    s = s.replace("\ufffd", " ").replace("\u200b", " ")
    s = re.sub(r'[\r\n\t]+', ' ', s).strip()
    s = re.sub(r'\s+', ' ', s)
    # Repair OCR that inserts spaces between every letter, such as "j a s m i n e".
    spaced_letters = re.compile(r'(?<![A-Za-z])(?:[A-Za-z]\s+){2,}[A-Za-z](?![A-Za-z])')
    while spaced_letters.search(s):
        s = spaced_letters.sub(lambda match: re.sub(r'\s+', '', match.group(0)), s)
    s = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', s)
    s = re.sub(r'(?<=[a-z])of(?=\s|[A-Z]|$)', ' of', s, flags=re.IGNORECASE)
    s = re.sub(r'\s+([,.;:!?%)])', r'\1', s)
    s = re.sub(r'([([])\s+', r'\1', s)
    return s



def extract_key_points(text: str, max_points: int = 3) -> list[str]:
    """Extract informative, clean scientific finding sentences in point-wise format."""
    if not text:
        return []

    raw_sentences = re.split(r'(?<=[.!?])\s+', text)
    cleaned = []
    for s in raw_sentences:
        s_clean = _clean_text(s)
        low = s_clean.lower()
        if any(skip in low for skip in [
            'department of', 'journal', 'issn', 'author', 'ph.d', 'm.sc',
            'email', 'correspond', 'vol.', 'pp.', 'http', 'abstract',
            'received:', 'accepted:', 'revised:', 'college of agriculture',
            'research article', 'original research', 'doi:'
        ]):
            continue
        # Skip sentences that look like names or author affiliations
        if '*' in s_clean or 'et al.' in low and len(s_clean.split()) < 7:
            continue
        s_clean = re.sub(r'^(table\s*\d*[\.\:\-]?|\d+[\.\)\-]?|\*+)\s*', '', s_clean, flags=re.IGNORECASE).strip()
        # Must have at least 5 words and reasonable length
        words = s_clean.split()
        if 5 <= len(words) and 35 <= len(s_clean) <= 220:
            cleaned.append(s_clean)

    findings = []
    priority_keywords = [
        'percent', '%', 'mortality', 'larva', 'damage', 'spray', 'treatment',
        'recorded', 'observed', 'effective', 'resulted', 'increase', 'infestation',
        'control', 'yield', 'dose', 'cultivar', 'fertilizer', 'spacing', 'pruning',
        'nitrogen', 'ppm', 'growth', 'flowering', 'flower'
    ]

    for s in cleaned:
        low = s.lower()
        if any(kw in low for kw in priority_keywords):
            if s not in findings:
                findings.append(s)
        if len(findings) >= max_points:
            break

    if len(findings) < max_points:
        for s in cleaned:
            if s not in findings:
                findings.append(s)
            if len(findings) >= max_points:
                break

    return findings



def get_research_evidence(
    question: str,
    top_k: int = 5,
    allow_cross_species: bool = True,
    min_score: float = 0.60,
) -> list[dict[str, Any]]:
    """
    Retrieve scientific research evidence chunks for the user question.

    Args:
        question: Original, untouched user question.
        top_k: Number of relevant chunks to retrieve.
        allow_cross_species: Whether to include cross-species comparative evidence if direct evidence is scarce.
        min_score: Minimum similarity score (default 0.60) to consider research relevant.

    Returns:
        List of structured research chunk dictionaries, or [] if RAG is unavailable.
    """
    if not question or len(question.strip()) < 3:
        return []

    try:
        rag = get_rag_instance()
        if rag is None:
            return []

        retrieval_output = rag.retrieve(
            query=question.strip(),
            top_k=top_k,
            allow_cross_species=allow_cross_species,
        )
        raw_chunks = retrieval_output.get("chunks", [])

        structured_chunks: list[dict[str, Any]] = []
        for chunk in raw_chunks:
            score = round(float(chunk.get("score", 0.0)), 4)
            if score < min_score:
                continue

            chunk_text = _clean_text(chunk.get("text", ""))
            structured_chunks.append({
                "chunk_id": chunk.get("chunk_id"),
                "score": score,
                "text": chunk_text,
                "key_points": extract_key_points(chunk_text, max_points=3),
                "title": chunk.get("title", ""),
                "species": chunk.get("species", "Jasminum sambac"),
                "category": chunk.get("category", "Cultivation"),
                "year": chunk.get("year"),
                "source": chunk.get("source", "KrishiKosh"),
                "filename": chunk.get("filename", ""),
                "page": chunk.get("page"),
                "is_cross_species": chunk.get("is_cross_species", False),
                "cross_species_note": chunk.get("cross_species_note"),
            })

        logger.info(
            "[RAG Service] Retrieved %d scientific research chunks (>= %.2f) for question.",
            len(structured_chunks),
            min_score,
        )
        return structured_chunks


    except Exception as exc:
        logger.error(
            "[RAG Service] Error retrieving research chunks for question '%s': %s",
            question,
            exc,
            exc_info=True,
        )
        # Fail safe: never crash the existing application
        return []
