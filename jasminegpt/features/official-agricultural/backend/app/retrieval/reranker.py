"""
Reranker for JasmineSathi.

Boosts chunks based on:
- Category match with detected query intent
- Location match (e.g. "Tamil Nadu" in query)
- is_deep_url flag (direct official deep page)
- source priority (priority 1 sources ranked higher)
- Jasmine/floriculture topic keyword presence in chunk text
"""
from __future__ import annotations

JASMINE_KEYWORDS = {
    "jasmine", "mullai", "gundumalli", "pitchi", "mogra",
    "floriculture", "loose flower", "flower farming",
}

INDIA_STATES = {
    "tamil nadu", "karnataka", "andhra pradesh", "telangana",
    "maharashtra", "kerala", "rajasthan", "west bengal",
    "odisha", "gujarat", "punjab", "haryana", "uttar pradesh",
    "madhya pradesh", "assam", "himachal pradesh",
}


def rerank_results(results: list[dict], query_info: dict) -> list[dict]:
    """
    Rerank ChromaDB results using semantic score + contextual boosts.
    Returns results sorted by rerank_score descending.
    """
    requested_category = query_info.get("category", "")
    requested_location = (query_info.get("location") or "").lower().strip()
    query_lower = query_info.get("query", "").lower()

    for result in results:
        meta = result.get("metadata", {})
        text_lower = result.get("text", "").lower()
        base_score = float(result.get("score", 0.0))
        boost = 0.0

        # +0.15 if category matches detected intent
        if requested_category and meta.get("category") == requested_category:
            boost += 0.15

        # +0.10 if location appears in chunk text
        if requested_location and requested_location in text_lower:
            boost += 0.10

        # +0.10 for deep URL (not a homepage)
        if str(meta.get("is_deep_url", "True")).lower() == "true":
            boost += 0.10

        # +0.08 for jasmine/floriculture keyword in chunk
        if any(kw in text_lower for kw in JASMINE_KEYWORDS):
            boost += 0.08

        # +0.05 for any India state mentioned in chunk matching query
        for state in INDIA_STATES:
            if state in query_lower and state in text_lower:
                boost += 0.05
                break

        result["rerank_score"] = round(min(base_score + boost, 1.0), 4)

    return sorted(results, key=lambda r: r["rerank_score"], reverse=True)
