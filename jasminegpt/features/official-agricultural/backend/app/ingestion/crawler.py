"""
Multi-seed, cross-domain, official-allowlist crawler for JasmineSathi.

Each seed is a source registry entry with category, topics, and priority.
The crawler discovers related pages within official Indian agricultural domains,
analyzes each page for jasmine/floriculture relevance, and returns enriched page dicts
ready for MongoDB storage.
"""
from __future__ import annotations

import re
from collections import deque
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse, urldefrag

import requests

from app.ingestion.page_analyzer import (
    SemanticPageAnalyzer,
    calculate_actionability,
    calculate_noise,
    calculate_statistics,
    calculate_usefulness,
    extract_page_content,
    is_india_relevant,
)
from app.ingestion.semantic_model import model
from app.storage.mongo_repository import (
    OFFICIAL_DOMAIN_SUFFIXES,
    REJECT_PATH_SEGMENTS,
    audit_url,
    canonicalize_url,
)


# ─────────────────────────────────────────────
# Request settings
# ─────────────────────────────────────────────
REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}

REQUEST_TIMEOUT = 25  # seconds
MINIMUM_USEFULNESS = 18
MAX_PAGES_PER_SEED = 8   # crawl up to 8 pages per seed URL
QUEUE_LIMIT = 60         # prevent runaway queue


def _normalize_url(url: str) -> str:
    url, _ = urldefrag(url)
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    domain = parsed.netloc.lower()
    path = parsed.path.rstrip("/") or "/"
    qs = f"?{parsed.query}" if parsed.query else ""
    return f"{scheme}://{domain}{path}{qs}"


def _is_allowed_domain(url: str) -> bool:
    """Must be an official Indian agricultural domain."""
    host = urlparse(url).netloc.lower()
    return any(host.endswith(suffix) for suffix in OFFICIAL_DOMAIN_SUFFIXES)


def _is_rejected_path(url: str) -> bool:
    path = urlparse(url).path.lower()
    return any(seg in path for seg in REJECT_PATH_SEGMENTS)


def _is_binary_or_feed(url: str) -> bool:
    lower = url.lower()
    skip_exts = (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt",
                 ".pptx", ".zip", ".rar", ".jpg", ".jpeg", ".png",
                 ".gif", ".mp4", ".mp3", ".rss", ".xml", ".json")
    return any(lower.endswith(ext) for ext in skip_exts)


def fetch_html(url: str) -> str | None:
    try:
        response = requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "").lower()
        if "text/html" not in content_type:
            return None
        # Reject if redirect went off-domain to a non-official domain
        final_url = response.url
        if not _is_allowed_domain(final_url):
            return None
        return response.text
    except requests.exceptions.SSLError:
        # Retry without SSL verification for sites with expired certs
        try:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            response = requests.get(url, headers=REQUEST_HEADERS, timeout=REQUEST_TIMEOUT,
                                    allow_redirects=True, verify=False)
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").lower()
            if "text/html" not in content_type:
                return None
            return response.text
        except Exception as exc2:
            print(f"  [FETCH ERROR SSL] {url} — {exc2}")
            return None
    except Exception as exc:
        print(f"  [FETCH ERROR] {url} — {exc}")
        return None



def extract_links(html: str, current_url: str) -> list[str]:
    """Extract all same-or-sister-domain official links from a page."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    links = set()
    for tag in soup.find_all("a", href=True):
        href = tag.get("href", "").strip()
        if not href or href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        absolute = urljoin(current_url, href)
        normalized = _normalize_url(absolute)
        if not _is_allowed_domain(normalized):
            continue
        if _is_rejected_path(normalized):
            continue
        if _is_binary_or_feed(normalized):
            continue
        links.add(normalized)
    return list(links)


class JasmineCrawler:
    """
    Crawl a single seed entry from the source registry.
    Returns a list of enriched page dicts for MongoDB.
    """

    def __init__(self, seed: dict, max_pages: int = MAX_PAGES_PER_SEED):
        self.seed = seed
        self.max_pages = max_pages
        self.analyzer = SemanticPageAnalyzer(model)
        self.visited: set[str] = set()

    def _analyze(self, html: str, url: str) -> dict:
        page = extract_page_content(html, url)
        stats = calculate_statistics(page)
        actionability_score, actionability_terms = calculate_actionability(page["text"])
        noise_score, noise_terms = calculate_noise(page["text"])
        semantic_result = self.analyzer.classify(page["text"])
        india_relevant = is_india_relevant(page["text"])
        usefulness_score = calculate_usefulness(
            semantic_result["semantic_score"],
            actionability_score,
            noise_score,
            stats,
            india_relevant,
        )
        return {
            # Identity
            "url": url,
            "page_url": url,
            "title": page["title"],
            "headings": page["headings"],
            "text": page["text"],
            # Source registry passthrough
            "source_name": self.seed.get("name", ""),
            "source_url": self.seed.get("source_url", ""),
            "source_category": self.seed.get("category", "unknown"),
            "topics": self.seed.get("topics", []),
            "country": self.seed.get("country", "India"),
            "language": self.seed.get("language", ["English"]),
            "is_deep_url": len(urlparse(url).path.rstrip("/")) > 1,
            "official_domain": True,
            # Analyzer output
            "page_type": semantic_result["page_type"],
            "semantic_score": semantic_result["semantic_score"],
            "category_scores": semantic_result["category_scores"],
            "actionability_score": actionability_score,
            "actionability_terms": actionability_terms,
            "noise_score": noise_score,
            "noise_terms": noise_terms,
            "usefulness_score": usefulness_score,
            "india_relevant": india_relevant,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }

    def crawl(self) -> list[dict]:
        seed_url = _normalize_url(self.seed["url"])
        print(f"\n{'='*60}")
        print(f"SEED: {self.seed['name']}")
        print(f"URL:  {seed_url}")
        print(f"CAT:  {self.seed.get('category')}")

        queue: deque[str] = deque([seed_url])
        pages: list[dict] = []

        while queue and len(pages) < self.max_pages:
            current_url = queue.popleft()
            if current_url in self.visited:
                continue
            self.visited.add(current_url)

            # Audit before fetching
            valid, reason = audit_url(current_url)
            if not valid:
                print(f"  [SKIP-AUDIT] {current_url} — {reason}")
                continue

            print(f"\n  [{len(pages)+1}/{self.max_pages}] Fetching {current_url}")
            html = fetch_html(current_url)
            if not html:
                continue

            # Quick pre-check: skip JavaScript-rendered / empty pages
            from app.ingestion.page_analyzer import extract_page_content
            _pre = extract_page_content(html, current_url)
            if len(_pre.get("text", "").split()) < 50:
                print(f"  [SKIP] Too few words — likely JS-rendered page")
                continue

            result = self._analyze(html, current_url)
            print(f"  TITLE:      {result['title'][:60]}")
            print(f"  TYPE:       {result['page_type']}")
            print(f"  USEFULNESS: {result['usefulness_score']:.1f}")
            print(f"  INDIA:      {result['india_relevant']}")

            # Accept page only if useful enough
            if result["usefulness_score"] >= MINIMUM_USEFULNESS:
                pages.append(result)
                print(f"  [OK] ACCEPTED")
            else:
                print(f"  [SKIP] REJECTED (usefulness < {MINIMUM_USEFULNESS})")

            # Discover child links
            child_links = extract_links(html, current_url)
            scored_links: list[tuple[str, float]] = []
            for link in child_links:
                if link in self.visited:
                    continue
                # Quick score based on URL signals (not a full page fetch)
                url_score = _url_relevance_score(link)
                if url_score > 0:
                    scored_links.append((link, url_score))

            # Queue top-scoring unvisited links
            scored_links.sort(key=lambda x: x[1], reverse=True)
            for link, _ in scored_links[:10]:
                if len(queue) < QUEUE_LIMIT:
                    queue.append(link)

        print(f"\n  Seed done. Accepted {len(pages)} pages.")
        return pages


def _url_relevance_score(url: str) -> float:
    """
    Quick URL-text signal for prioritizing which discovered links to queue.
    NOT a replacement for semantic analysis — just a weak pre-filter.
    """
    url_lower = url.lower()
    positive = [
        "jasmine", "floriculture", "horticulture", "flower",
        "scheme", "subsidy", "midh", "nhb", "icar",
        "pest", "irrigation", "drip", "planting", "nursery",
        "credit", "loan", "kisan", "market", "crop",
    ]
    negative = [
        "tender", "login", "privacy", "contact", "gallery",
        "photo", "video", "sitemap", "press", "recruitment",
        "career", "vacancy", "404", "error",
    ]
    score = 0.0
    for term in positive:
        if term in url_lower:
            score += 1.0
    for term in negative:
        if term in url_lower:
            score -= 2.0
    return score


def run_all_seeds(seeds: list[dict], max_pages_per_seed: int = MAX_PAGES_PER_SEED) -> list[dict]:
    """Run JasmineCrawler for every seed and return combined list of all accepted pages."""
    all_pages: list[dict] = []
    seen_urls: set[str] = set()
    for seed in seeds:
        crawler = JasmineCrawler(seed, max_pages=max_pages_per_seed)
        pages = crawler.crawl()
        for page in pages:
            canonical = canonicalize_url(page["url"])
            if canonical not in seen_urls:
                seen_urls.add(canonical)
                all_pages.append(page)
    return all_pages
