"""Jasmine/Floriculture India source registry loader."""
from __future__ import annotations

import json
from pathlib import Path


_SOURCES_FILE = Path(__file__).parent / "sources.json"


def _load() -> list[dict]:
    with open(_SOURCES_FILE, encoding="utf-8") as f:
        return json.load(f)


def get_all_sources() -> list[dict]:
    """Return all sources sorted by priority (1 = highest)."""
    return sorted(_load(), key=lambda s: s.get("priority", 99))


def get_sources_by_category(category: str) -> list[dict]:
    return [s for s in get_all_sources() if s.get("category") == category]


def get_sources_by_topic(topic: str) -> list[dict]:
    topic_lower = topic.lower()
    return [
        s for s in get_all_sources()
        if any(topic_lower in t.lower() for t in s.get("topics", []))
    ]


def get_sources_by_priority(max_priority: int = 1) -> list[dict]:
    return [s for s in get_all_sources() if s.get("priority", 99) <= max_priority]


def get_categories() -> list[str]:
    return sorted({s.get("category", "unknown") for s in _load()})