"""
Chunker for JasmineSathi.

Splits crawled page text into overlapping chunks with full metadata.
Each chunk carries everything needed for ChromaDB storage and source attribution.
"""
from __future__ import annotations

import hashlib
import re


# ─────────────────────────────────────────────
# Section header detection
# ─────────────────────────────────────────────

SECTION_HEADERS = [
    # Generic
    "eligibility", "benefits", "objective", "objectives",
    "about the scheme", "how to apply", "application process",
    "application procedure", "documents required", "required documents",
    "who can apply", "implementation", "features", "guidelines",
    "procedure", "financial assistance", "subsidy", "coverage",
    "registration", "overview",
    # Jasmine / floriculture specific
    "pest management", "disease management", "varieties",
    "planting", "propagation", "pruning", "irrigation",
    "fertilizer", "manuring", "harvesting", "post harvest",
    "post-harvest", "market", "credit", "loan", "scheme details",
    "crop advisory", "protected cultivation", "drip irrigation",
    "area expansion", "planting material", "nursery",
]


def detect_section(line: str) -> str | None:
    cleaned = line.strip().lower()
    if not cleaned:
        return None
    for header in SECTION_HEADERS:
        if cleaned == header or cleaned.startswith(header + ":"):
            return header.title()
    return None


# ─────────────────────────────────────────────
# Single-page chunk creator
# ─────────────────────────────────────────────

def create_chunks(page: dict, max_words: int = 400, overlap_words: int = 60) -> list[dict]:
    """
    Split a single page dict into overlapping chunks.
    Each chunk includes full source metadata.
    """
    text = page.get("text", "")
    lines = text.splitlines()

    # Split text into named sections
    sections: list[tuple[str, str]] = []
    current_section = "General Information"
    current_lines: list[str] = []

    for line in lines:
        section = detect_section(line)
        if section:
            if current_lines:
                sections.append((current_section, "\n".join(current_lines)))
            current_section = section
            current_lines = []
        else:
            current_lines.append(line)

    if current_lines:
        sections.append((current_section, "\n".join(current_lines)))

    page_url = page.get("url") or page.get("page_url", "")
    chunks: list[dict] = []

    for section_name, section_text in sections:
        words = section_text.split()
        if not words:
            continue

        start = 0
        chunk_index = 0
        while start < len(words):
            end = start + max_words
            chunk_text = " ".join(words[start:end]).strip()
            if not chunk_text:
                start += max_words - overlap_words
                continue

            chunk_index += 1
            # Stable chunk ID derived from URL + section + position
            chunk_id = (
                "CHUNK-"
                + hashlib.sha256(
                    f"{page_url}::{section_name}::{chunk_index}".encode()
                ).hexdigest()[:16].upper()
            )

            metadata = {
                # Source attribution — shown in UI and sent to OpenRouter
                "source_name":  page.get("source_name", ""),
                "source_url":   page.get("source_url", ""),
                "page_title":   page.get("title", ""),
                "page_url":     page_url,
                "page_type":    page.get("page_type", "unknown"),
                "category":     page.get("source_category") or page.get("category", "unknown"),
                "topics":       ",".join(page.get("topics", [])),
                "section":      section_name,
                "country":      page.get("country", "India"),
                "language":     ",".join(page.get("language", ["English"])),
                "is_deep_url":  str(page.get("is_deep_url", True)),
                "fetched_at":   page.get("fetched_at", ""),
            }

            chunks.append({
                "chunk_id": chunk_id,
                "text": chunk_text,
                "metadata": metadata,
            })

            start += max_words - overlap_words

    return chunks


# ─────────────────────────────────────────────
# Batch wrapper used by deep_search_controller
# ─────────────────────────────────────────────

def chunk_pages(pages: list[dict]) -> list[dict]:
    """Chunk all pages and return a flat list of chunk dicts."""
    all_chunks: list[dict] = []
    for page in pages:
        chunks = create_chunks(page)
        if chunks:
            all_chunks.extend(chunks)
    return all_chunks
