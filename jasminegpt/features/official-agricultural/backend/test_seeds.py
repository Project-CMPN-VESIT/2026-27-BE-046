import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from app.sources.source_registry import get_all_sources
from app.ingestion.crawler import JasmineCrawler

seeds = get_all_sources()[:5]
for seed in seeds:
    print(f"\n--- Testing: {seed['name']} ---")
    print(f"URL: {seed['url']}")
    crawler = JasmineCrawler(seed, max_pages=2)
    pages = crawler.crawl()
    print(f"Pages accepted: {len(pages)}")
    for p in pages:
        title = p.get('title', '')[:60]
        score = p.get('usefulness_score', 0)
        print(f"  [{score:.1f}] {title}")
