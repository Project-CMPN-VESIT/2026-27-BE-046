"""Run one focused crawl, guarded by the MongoDB daily deep-search record."""
import argparse

from app.ingestion.crawler import ControlledCrawler
from app.ingestion.page_store import save_pages
from app.sources.source_registry import get_all_sources
from app.storage.mongo_repository import repository

MAX_PAGES_PER_SOURCE = 15


def enrich_page(page, source):
    page.update({
        "source_name": source["name"],
        "source_url": source["url"],
        "source_category": source["category"],
        "source_type": source["type"],
        "language": source["language"],
        "topics": source.get("topics", []),
        "country": source.get("country", "India"),
        "is_deep_url": source.get("is_deep_url", False),
    })


def run_ingestion(force=False, trigger="scheduled"):
    status = repository.deep_search_status()
    if not force and not status["due"]:
        print(f"Deep search skipped: {status['reason']}")
        print(f"Next allowed run: {status.get('next_allowed_run')}")
        return []

    run_id = repository.start_run(trigger)
    all_pages = []
    sources = get_all_sources()
    print("=" * 80)
    print("FARMER KNOWLEDGE BASE INGESTION")
    print("=" * 80)
    print(f"Sources: {len(sources)}")
    print(f"MongoDB configured: {status['configured']}")

    try:
        for index, source in enumerate(sources, start=1):
            print("\n" + "=" * 80)
            print(f"SOURCE {index}/{len(sources)}")
            print(source["name"])
            print(source["url"])
            try:
                crawler = ControlledCrawler(start_url=source["url"], max_pages=MAX_PAGES_PER_SOURCE, minimum_usefulness=35)
                pages = crawler.crawl()
                for page in pages:
                    enrich_page(page, source)
                all_pages.extend(pages)
                print(f"Useful pages: {len(pages)}")
            except Exception as error:
                print(f"ERROR: {error}")

        save_pages(all_pages)
        mongo_saved = repository.save_pages(all_pages, run_id)
        repository.finish_run(run_id, "success", pages_saved=mongo_saved)
        print("\n" + "=" * 80)
        print("INGESTION COMPLETE")
        print("=" * 80)
        print(f"Total useful pages: {len(all_pages)}")
        print(f"MongoDB pages saved: {mongo_saved}")
        return all_pages
    except Exception as error:
        repository.finish_run(run_id, "failed", error=str(error))
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="Run despite the daily deep-search interval.")
    args = parser.parse_args()
    run_ingestion(force=args.force, trigger="manual")
