"""
Query understanding for JasmineSathi.
Detects jasmine/floriculture category and Indian state location from farmer questions.
"""
from __future__ import annotations

import re

# Maps to the category names used in sources.json and ChromaDB metadata
CATEGORY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "jasmine_crop_practice": (
        "jasmine", "mullai", "gundumalli", "pitchi", "mogra",
        "cultivation", "planting", "varieties", "pruning", "manure",
        "fertilizer", "crop advisory", "farming", "organic jasmine",
    ),
    "floriculture_subsidy": (
        "subsidy", "subsidies", "financial assistance", "grant",
        "area expansion", "nhb scheme", "floriculture scheme",
    ),
    "horticulture_scheme": (
        "midh", "horticulture scheme", "national horticulture",
        "scheme", "government program", "mission horticulture",
    ),
    "jasmine_planting_material": (
        "planting material", "cuttings", "nursery", "tissue culture",
        "certified plant", "rooted cutting", "plant subsidy",
    ),
    "pest_management": (
        "pest", "disease", "bud worm", "mites", "insecticide",
        "pesticide", "spray", "fungal", "leaf webworm", "ipm",
    ),
    "irrigation": (
        "drip", "irrigation", "sprinkler", "polyhouse",
        "greenhouse", "protected cultivation", "water",
    ),
    "agricultural_credit": (
        "loan", "credit", "kisan credit card", "kcc",
        "nabard", "bank", "finance", "working capital",
    ),
    "market_information": (
        "market", "mandi", "price", "export", "post-harvest",
        "post harvest", "grading", "packing", "cold storage", "enam",
    ),
    "state_scheme": (
        "state scheme", "state government", "tnhorticulture",
        "karnataka horticulture", "ap horticulture", "maharashtra horticulture",
    ),
}

INDIA_STATES = (
    "tamil nadu", "karnataka", "andhra pradesh", "telangana",
    "maharashtra", "kerala", "rajasthan", "west bengal",
    "odisha", "gujarat", "punjab", "haryana", "uttar pradesh",
    "madhya pradesh", "assam", "himachal pradesh", "goa",
    "india",
)


def understand_query(query: str) -> dict:
    normalized = query.lower()

    # Detect category (first match wins, ordered by specificity)
    detected_category = None
    for category, terms in CATEGORY_KEYWORDS.items():
        if any(term in normalized for term in terms):
            detected_category = category
            break

    # Detect Indian state / location
    detected_location = None
    for state in INDIA_STATES:
        if state in normalized:
            detected_location = state.title()
            break

    # Detect what farmer specifically needs
    info_needed = [
        term for term in (
            "eligibility", "benefits", "apply", "documents",
            "subsidy", "procedure", "how to", "where to",
        )
        if term in normalized
    ]

    return {
        "intent": "jasmine_information_discovery",
        "category": detected_category,
        "location": detected_location,
        "information_needed": info_needed,
        "query": query,
    }
