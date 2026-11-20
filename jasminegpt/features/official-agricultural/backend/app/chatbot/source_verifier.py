from urllib.parse import urlparse
from app.sources.source_registry import get_all_sources


def verify_source(metadata: dict) -> bool:
    page_url, source_url = metadata.get("page_url", ""), metadata.get("source_url", "")
    if not page_url or source_url not in {item["url"] for item in get_all_sources()}:
        return False
    return urlparse(page_url).netloc == urlparse(source_url).netloc


def verified_sources(results: list[dict]) -> list[dict]:
    unique, seen = [], set()
    for result in results:
        metadata = result.get("metadata", {})
        url = metadata.get("page_url")
        if url and url not in seen and verify_source(metadata):
            seen.add(url)
            unique.append({"source_name": metadata.get("source_name"), "page_title": metadata.get("page_title"), "page_url": url, "section": metadata.get("section")})
    return unique
