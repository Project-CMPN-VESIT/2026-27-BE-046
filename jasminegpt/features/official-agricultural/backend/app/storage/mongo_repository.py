"""MongoDB persistence for verified India/Jasmine source pages, chunks, and crawl logs."""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from app.config.settings import (
    DEEP_SEARCH_INTERVAL_HOURS,
    MONGODB_DATABASE,
    MONGODB_LOGS_COLLECTION,
    MONGODB_SCHEMES_COLLECTION,
    MONGODB_URI,
)

# ─────────────────────────────────────────────
# Tracking params to strip from all URLs
# ─────────────────────────────────────────────
TRACKING_PARAMETERS = {
    "utm_source", "utm_medium", "utm_campaign",
    "utm_term", "utm_content", "gclid", "fbclid",
}

# ─────────────────────────────────────────────
# Official Indian government / agri domains
# ─────────────────────────────────────────────
OFFICIAL_DOMAIN_SUFFIXES = (
    ".gov.in", ".nic.in", ".res.in",
    "icar.org.in", "nabard.org", "nhb.gov.in",
    "midh.gov.in", "tnau.ac.in", "uasd.in",
    "kau.in", "pjtsau.edu.in", "gbpuat.ac.in",
    "bskkv.ac.in", "ouat.ac.in", "angrau.ac.in",
    "apau.ac.in", "skuast.org", "sfacindia.com",
    "farmer.gov.in", "agriinfra.dac.gov.in",
    "enam.gov.in", "apeda.gov.in",
    "myscheme.gov.in", "agriwelfare.gov.in",
    "pmksy.gov.in", "cibrc.nic.in",
    "ccari.res.in", "iihr.res.in",
)

# Pages that are definitely not useful deep content
REJECT_PATH_SEGMENTS = (
    "/tender", "/tenders", "/contact", "/login",
    "/signup", "/register", "/sitemap", "/privacy",
    "/disclaimer", "/terms", "/accessibility",
    "/gallery", "/photo", "/video", "/news-archive",
    "/admin", "/dashboard", "/404", "/error",
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def canonicalize_url(url: str) -> str:
    """Strip tracking params, fragments, trailing slashes; lowercase scheme+host."""
    if not url:
        return ""
    parsed = urlsplit(url.strip())
    query = urlencode(
        [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
         if k.lower() not in TRACKING_PARAMETERS]
    )
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, query, ""))


def is_official_domain(url: str) -> bool:
    """Return True if the URL belongs to a known official Indian agricultural domain."""
    host = urlsplit(url).netloc.lower()
    return any(host.endswith(suffix) for suffix in OFFICIAL_DOMAIN_SUFFIXES)


def is_deep_url(url: str) -> bool:
    """Return True if the URL points to a real content page, not a homepage."""
    parsed = urlsplit(url)
    path = parsed.path.rstrip("/")
    # A homepage has an empty path or just "/"
    return len(path) > 1


def audit_url(url: str) -> tuple[bool, str]:
    """
    Validate a URL before storing/fetching it.
    Returns (is_valid, rejection_reason).
    Homepages are allowed as starting seeds; deep-URL quality is scored separately.
    """
    if not url:
        return False, "empty URL"
    canonical = canonicalize_url(url)
    parsed = urlsplit(canonical)

    if parsed.scheme not in ("http", "https"):
        return False, f"non-http scheme: {parsed.scheme}"

    if not is_official_domain(canonical):
        return False, f"not an official Indian agricultural domain: {parsed.netloc}"

    path_lower = parsed.path.lower()
    for segment in REJECT_PATH_SEGMENTS:
        if segment in path_lower:
            return False, f"rejected path segment: {segment}"

    return True, ""


class MongoRepository:
    def __init__(self) -> None:
        self._client = None
        self._database = None

    @property
    def configured(self) -> bool:
        return bool(MONGODB_URI and not MONGODB_URI.startswith("your_"))

    def _db(self):
        if not self.configured:
            return None
        if self._database is None:
            from pymongo import MongoClient

            self._client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000)
            self._database = self._client[MONGODB_DATABASE]
            # Indexes
            schemes = self._database[MONGODB_SCHEMES_COLLECTION]
            schemes.create_index("canonical_url", unique=True)
            schemes.create_index([("topics", 1), ("category", 1)])
            schemes.create_index([("verification_status", 1)])
            schemes.create_index([("fetched_at", -1)])
            logs = self._database[MONGODB_LOGS_COLLECTION]
            logs.create_index([("event", 1), ("finished_at", -1)])
        return self._database

    # ─────────────────────────────────────────────
    # Start fresh — drop all existing documents
    # ─────────────────────────────────────────────
    def drop_all(self) -> dict[str, int]:
        """Delete every document from schemes and verification_logs. Start fresh."""
        db = self._db()
        if db is None:
            return {"schemes_deleted": 0, "logs_deleted": 0}
        s = db[MONGODB_SCHEMES_COLLECTION].delete_many({})
        l = db[MONGODB_LOGS_COLLECTION].delete_many({})
        return {"schemes_deleted": s.deleted_count, "logs_deleted": l.deleted_count}

    # ─────────────────────────────────────────────
    # Crawl run lifecycle
    # ─────────────────────────────────────────────
    def start_run(self, trigger: str) -> str:
        run_id = str(uuid4())
        db = self._db()
        if db is not None:
            db[MONGODB_LOGS_COLLECTION].insert_one({
                "run_id": run_id,
                "event": "deep_search",
                "trigger": trigger,
                "status": "running",
                "started_at": datetime.now(timezone.utc),
            })
        return run_id

    def finish_run(self, run_id: str, status: str, pages_saved: int = 0, error: str | None = None) -> None:
        db = self._db()
        if db is not None:
            db[MONGODB_LOGS_COLLECTION].update_one(
                {"run_id": run_id},
                {"$set": {
                    "status": status,
                    "pages_saved": pages_saved,
                    "finished_at": datetime.now(timezone.utc),
                    "error": error,
                }},
            )

    def last_successful_run(self) -> dict[str, Any] | None:
        db = self._db()
        if db is None:
            return None
        return db[MONGODB_LOGS_COLLECTION].find_one(
            {"event": "deep_search", "status": "success"},
            sort=[("finished_at", -1)],
        )

    def deep_search_status(self) -> dict[str, Any]:
        if not self.configured:
            return {"configured": False, "due": True, "reason": "MongoDB is not configured."}
        latest = self.last_successful_run()
        if latest is None:
            return {"configured": True, "due": True, "reason": "No successful deep search recorded yet."}

        finished_at = latest["finished_at"]
        # MongoDB may return naive datetimes — normalise to UTC-aware
        if finished_at.tzinfo is None:
            finished_at = finished_at.replace(tzinfo=timezone.utc)

        now = datetime.now(timezone.utc)
        due_at = finished_at + timedelta(hours=DEEP_SEARCH_INTERVAL_HOURS)
        is_due = now >= due_at
        return {
            "configured": True,
            "due": is_due,
            "last_successful_run": finished_at.isoformat(),
            "next_allowed_run": due_at.isoformat(),
            "pages_saved": latest.get("pages_saved", 0),
            "reason": "Daily interval reached." if is_due else "Daily interval has not elapsed yet.",
        }

    # ─────────────────────────────────────────────
    # URL rejection log
    # ─────────────────────────────────────────────
    def log_url_rejection(self, url: str, reason: str, run_id: str = "") -> None:
        db = self._db()
        if db is not None:
            db[MONGODB_LOGS_COLLECTION].insert_one({
                "event": "url_rejected",
                "url": url,
                "reason": reason,
                "run_id": run_id,
                "logged_at": utc_now(),
            })

    # ─────────────────────────────────────────────
    # Save crawled pages
    # ─────────────────────────────────────────────
    def save_pages(self, pages: list[dict[str, Any]], run_id: str) -> int:
        db = self._db()
        if db is None:
            return 0
        saved = 0
        collection = db[MONGODB_SCHEMES_COLLECTION]
        for page in pages:
            raw_url = page.get("url", "") or page.get("page_url", "")
            page_url = canonicalize_url(raw_url)
            if not page_url:
                continue
            text = page.get("text", "") or page.get("content", "")
            document = {
                "scheme_id": (
                    page.get("scheme_id")
                    or f"PAGE-{hashlib.sha256(page_url.encode()).hexdigest()[:12].upper()}"
                ),
                # Source registry metadata
                "source_name": page.get("source_name", ""),
                "source_url": canonicalize_url(page.get("source_url", "")),
                "country": page.get("country", "India"),
                "category": page.get("source_category") or page.get("category", "unknown"),
                "topics": page.get("topics", []),
                "language": page.get("language", ["English"]),
                # Page identity
                "page_title": page.get("title", ""),
                "page_url": page_url,
                "canonical_url": page_url,
                "page_type": page.get("page_type", "unknown"),
                # Quality flags
                "is_deep_url": page.get("is_deep_url", True),
                "official_domain": page.get("official_domain", True),
                "verification_status": "verified",
                # Content
                "content": text,
                "content_hash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "headings": page.get("headings", []),
                # Scores
                "usefulness_score": page.get("usefulness_score", 0),
                "semantic_score": page.get("semantic_score", 0),
                # Timestamps
                "fetched_at": page.get("fetched_at") or utc_now().isoformat(),
                "last_verified_at": utc_now().isoformat(),
                "last_run_id": run_id,
            }
            collection.update_one(
                {"canonical_url": page_url},
                {
                    "$set": document,
                    "$setOnInsert": {"created_at": utc_now()},
                },
                upsert=True,
            )
            saved += 1
        return saved

    # ─────────────────────────────────────────────
    # Save chunks (sub-documents inside page record)
    # ─────────────────────────────────────────────
    def save_chunks(self, chunks: list[dict[str, Any]]) -> int:
        """
        Each chunk must have metadata.page_url.
        Chunks are stored as an array inside the parent page document.
        """
        db = self._db()
        if db is None:
            return 0
        updated = 0
        # Group chunks by parent page URL
        grouped: dict[str, list[dict[str, Any]]] = {}
        for chunk in chunks:
            url = canonicalize_url(chunk.get("metadata", {}).get("page_url", ""))
            if url:
                grouped.setdefault(url, []).append(chunk)

        for url, page_chunks in grouped.items():
            result = db[MONGODB_SCHEMES_COLLECTION].update_one(
                {"canonical_url": url},
                {"$set": {
                    "chunks": page_chunks,
                    "chunk_count": len(page_chunks),
                    "chunks_updated_at": utc_now().isoformat(),
                }},
            )
            updated += result.modified_count
        return updated

    # ─────────────────────────────────────────────
    # Get stored chunks → used to rebuild ChromaDB
    # ─────────────────────────────────────────────
    def get_all_chunks(self) -> list[dict[str, Any]]:
        """
        Return every chunk stored across all verified pages.
        Each returned item has: chunk_id, text, metadata (page_url, source_name, etc.)
        """
        db = self._db()
        if db is None:
            return []
        all_chunks = []
        cursor = db[MONGODB_SCHEMES_COLLECTION].find(
            {"verification_status": "verified", "chunks": {"$exists": True}},
            {"chunks": 1, "_id": 0},
        )
        for doc in cursor:
            all_chunks.extend(doc.get("chunks", []))
        return all_chunks

    # ─────────────────────────────────────────────
    # Stats for the /db-status endpoint
    # ─────────────────────────────────────────────
    def get_stats(self) -> dict[str, Any]:
        db = self._db()
        if db is None:
            return {"configured": False}
        page_count = db[MONGODB_SCHEMES_COLLECTION].count_documents(
            {"verification_status": "verified"}
        )
        # Total chunks = sum of chunk_count across all pages
        pipeline = [
            {"$match": {"verification_status": "verified"}},
            {"$group": {"_id": None, "total_chunks": {"$sum": "$chunk_count"}}},
        ]
        result = list(db[MONGODB_SCHEMES_COLLECTION].aggregate(pipeline))
        chunk_count = result[0]["total_chunks"] if result else 0
        ds = self.deep_search_status()
        return {
            "configured": True,
            "page_count": page_count,
            "chunk_count": chunk_count,
            "last_successful_run": ds.get("last_successful_run"),
            "next_allowed_run": ds.get("next_allowed_run"),
            "deep_search_due": ds.get("due"),
        }


repository = MongoRepository()
