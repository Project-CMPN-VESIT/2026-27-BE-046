"""Jasmine/floriculture-aware page content analyzer."""
import re
from collections import Counter
from bs4 import BeautifulSoup


# ─────────────────────────────────────────────
# JASMINE / FLORICULTURE CONTENT CATEGORIES
# ─────────────────────────────────────────────

CONTENT_CATEGORIES = {
    "jasmine_crop_practice": """
    Jasmine cultivation, farming practices, varieties (mullai, gundumalli, pitchi,
    single jasmine, double jasmine), planting season, soil preparation, spacing,
    manuring, fertilizer, pruning, training, yield, ICAR, TNAU, crop advisory.
    """,

    "floriculture_subsidy": """
    Floriculture subsidy schemes, government financial assistance for flower farming,
    area expansion grants for jasmine or loose flowers, NHB subsidy, MIDH floriculture
    support, state horticulture department schemes, application procedure, eligibility.
    """,

    "horticulture_scheme": """
    Horticulture development schemes, MIDH mission for integrated development of
    horticulture, government programs for horticulture, national horticulture board,
    scheme benefits, protected cultivation assistance, cold storage support.
    """,

    "jasmine_planting_material": """
    Jasmine planting material, certified cuttings, nursery support, tissue culture
    planting material, rooted cuttings for jasmine, quality planting material scheme,
    propagation, mother plant maintenance, plant subsidy.
    """,

    "pest_management": """
    Pest and disease management in jasmine, bud worm control, mites in jasmine,
    leaf webworm, fungal diseases, approved pesticides for floriculture, insecticide
    spray schedule, integrated pest management, neem-based spray, CIB&RC.
    """,

    "irrigation": """
    Drip irrigation for jasmine, micro irrigation, sprinkler system, polyhouse
    protected cultivation, greenhouse horticulture, water management in floriculture,
    PMKSY drip subsidy, irrigation support scheme.
    """,

    "agricultural_credit": """
    Agricultural loans for flower farming, Kisan Credit Card for horticulture,
    NABARD loans, farmer finance, working capital loan, term loan for floriculture,
    bank loan for jasmine cultivation, interest subvention.
    """,

    "market_information": """
    Jasmine flower market, mandi prices for loose flowers, e-NAM platform for flowers,
    post-harvest handling of jasmine, grading, packing, export of flowers, APEDA
    floriculture export, value chain, price discovery.
    """,

    "state_scheme": """
    State government horticulture schemes, Tamil Nadu floriculture scheme, Karnataka
    horticulture department, Andhra Pradesh AP horticulture, Maharashtra floriculture
    support, Kerala horticulture, state subsidy for jasmine farmers.
    """,

    "government_portal": """
    Government horticulture board, national horticulture board NHB, ICAR research
    institute, ministry of agriculture, department of horticulture, government
    agricultural portal, official government website for farmers, farmer portal India,
    NABARD, MIDH, agricultural welfare department, government schemes for farmers,
    agriculture India, krishi, kisan, horticulture India.
    """,

    "irrelevant": """
    Privacy policy, terms and conditions, accessibility statement, login pages,
    website administration, contact only pages, copyright information, tender notices,
    administrative orders, career pages, 404 error, page not found, unrelated content.
    """,
}


# ─────────────────────────────────────────────
# JASMINE / FLORICULTURE ACTIONABILITY SIGNALS
# ─────────────────────────────────────────────

ACTIONABILITY_TERMS = [
    # Crop-specific
    "jasmine", "mullai", "gundumalli", "pitchi", "mogra",
    "floriculture", "loose flower", "planting material",
    # Action signals
    "eligibility", "eligible", "benefit", "benefits",
    "apply", "how to apply", "application", "documents required",
    "subsidy", "financial assistance", "procedure", "guidelines",
    "registration", "assistance", "who can apply", "criteria",
    "area expansion", "scheme", "loan", "credit",
    # Pest/disease
    "bud worm", "mites", "spray", "pesticide", "insecticide",
    "integrated pest management", "disease control",
    # Market
    "market price", "mandi", "export", "post-harvest",
    "grading", "packing", "cold storage",
]


# ─────────────────────────────────────────────
# NOISE / IRRELEVANT PAGE SIGNALS
# ─────────────────────────────────────────────

NOISE_TERMS = [
    "privacy policy", "terms and conditions", "disclaimer",
    "screen reader", "accessibility statement", "copyright",
    "sign in", "login", "register", "dashboard",
    "contact us", "tender", "e-tender", "bid document",
    "recruitment", "vacancy", "career", "job notification",
    "rtl", "right to information", "citizen charter",
    "annual report", "press release", "photo gallery",
    "video gallery", "sitemap",
]


# ─────────────────────────────────────────────
# INDIA RELEVANCE CHECK
# ─────────────────────────────────────────────

INDIA_SIGNALS = [
    "india", "indian", "tamil nadu", "karnataka", "andhra", "maharashtra",
    "kerala", "rajasthan", "west bengal", "odisha", "gujarat",
    "icar", "tnau", "nhb", "midh", "nabard", "nic.in", "gov.in",
    "rupee", "₹", "rs.", "lakh", "crore", "kisan", "kharif", "rabi",
]


def is_india_relevant(text: str) -> bool:
    text_lower = text.lower()
    return any(signal in text_lower for signal in INDIA_SIGNALS)


# ─────────────────────────────────────────────
# HTML CONTENT EXTRACTION
# ─────────────────────────────────────────────

def extract_page_content(html: str, url: str = "") -> dict:
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup.find_all(
        ["script", "style", "noscript", "svg", "iframe",
         "canvas", "form", "button", "input", "select", "textarea"]
    ):
        tag.decompose()

    # Title
    title = ""
    if soup.title:
        title = soup.title.get_text(" ", strip=True)

    # Headings
    headings = [
        tag.get_text(" ", strip=True)
        for tag in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"])
        if tag.get_text(" ", strip=True)
    ]

    # Paragraphs
    paragraphs = [
        tag.get_text(" ", strip=True)
        for tag in soup.find_all("p")
        if len(tag.get_text(" ", strip=True)) > 20
    ]

    # List items
    list_items = [
        tag.get_text(" ", strip=True)
        for tag in soup.find_all("li")
        if len(tag.get_text(" ", strip=True)) > 10
    ]

    # Table rows
    table_rows = []
    for row in soup.find_all("tr"):
        cells = [
            cell.get_text(" ", strip=True)
            for cell in row.find_all(["td", "th"])
            if cell.get_text(" ", strip=True)
        ]
        if cells:
            table_rows.append(" | ".join(cells))

    # Combine
    content_parts = headings + paragraphs + list_items + table_rows
    text = "\n".join(content_parts)

    # Clean
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n+", "\n", text)

    lines = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("//") or line.startswith("/*"):
            continue
        if "javascript:" in line.lower() or "<script" in line.lower():
            continue
        lines.append(line)

    text = "\n".join(lines)

    return {
        "url": url,
        "title": title,
        "headings": headings,
        "paragraphs": paragraphs,
        "list_items": list_items,
        "table_rows": table_rows,
        "text": text.strip(),
    }


# ─────────────────────────────────────────────
# STATISTICS
# ─────────────────────────────────────────────

def calculate_statistics(page: dict) -> dict:
    text = page["text"]
    words = text.split()
    return {
        "title": page.get("title", ""),
        "character_count": len(text),
        "word_count": len(words),
        "heading_count": len(page["headings"]),
        "paragraph_count": len(page["paragraphs"]),
        "list_item_count": len(page["list_items"]),
        "table_row_count": len(page["table_rows"]),
    }


# ─────────────────────────────────────────────
# ACTIONABILITY SCORE
# ─────────────────────────────────────────────

def calculate_actionability(text: str) -> tuple[float, list[str]]:
    lower = text.lower()
    matched = [term for term in ACTIONABILITY_TERMS if term in lower]
    score = min(len(matched) * 4, 35)
    return score, matched


# ─────────────────────────────────────────────
# NOISE SCORE
# ─────────────────────────────────────────────

def calculate_noise(text: str) -> tuple[float, list[str]]:
    lower = text.lower()
    matched = [term for term in NOISE_TERMS if term in lower]
    score = min(len(matched) * 6, 30)
    return score, matched


# ─────────────────────────────────────────────
# SEMANTIC CLASSIFICATION
# ─────────────────────────────────────────────

class SemanticPageAnalyzer:

    def __init__(self, embedding_model):
        self.embedding_model = embedding_model
        self.category_names = list(CONTENT_CATEGORIES.keys())
        self.category_descriptions = list(CONTENT_CATEGORIES.values())
        self.category_embeddings = self.embedding_model.encode(
            self.category_descriptions, normalize_embeddings=True
        )

    def classify(self, text: str) -> dict:
        if not text.strip():
            return {"page_type": "irrelevant", "semantic_score": 0.0, "category_scores": {}}

        page_embedding = self.embedding_model.encode(
            text[:6000], normalize_embeddings=True
        )
        similarities = self.category_embeddings @ page_embedding

        category_scores = {
            cat: float(similarities[i])
            for i, cat in enumerate(self.category_names)
        }

        best_index = int(similarities.argmax())
        return {
            "page_type": self.category_names[best_index],
            "semantic_score": float(similarities[best_index]),
            "category_scores": category_scores,
        }


# ─────────────────────────────────────────────
# USEFULNESS SCORE
# ─────────────────────────────────────────────

GENERIC_TITLE_TERMS = {
    "home", "about", "about us", "faq", "contact", "contact us",
    "privacy policy", "terms and conditions", "disclaimer", "dashboard",
    "tender", "news", "gallery", "sitemap", "login",
}


def calculate_usefulness(
    semantic_score: float,
    actionability_score: float,
    noise_score: float,
    statistics: dict,
    india_relevant: bool = True,
) -> float:
    # Semantic component (0–50)
    semantic_component = max(0.0, min(semantic_score, 1.0)) * 50

    # Content size
    wc = statistics["word_count"]
    if wc >= 1000:
        info_component = 15
    elif wc >= 500:
        info_component = 10
    elif wc >= 200:
        info_component = 6
    elif wc >= 100:
        info_component = 3
    else:
        info_component = 0

    # Structure
    structure_component = min(statistics["heading_count"] * 2, 10)

    # Generic page penalty
    title = str(statistics.get("title", "")).strip().lower()
    generic_penalty = 20 if title in GENERIC_TITLE_TERMS else 0

    # India relevance bonus
    india_bonus = 0 if india_relevant else -15

    score = (
        semantic_component
        + actionability_score
        + info_component
        + structure_component
        + india_bonus
        - noise_score
        - generic_penalty
    )
    return max(0.0, min(round(score, 2), 100))
