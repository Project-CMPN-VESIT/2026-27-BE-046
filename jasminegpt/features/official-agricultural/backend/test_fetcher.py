from app.sources.source_registry import get_all_sources
from app.ingestion.web_fetcher import fetch_and_extract


sources = get_all_sources()

for source in sources:

    print("=" * 60)
    print("SOURCE:", source["name"])
    print("CATEGORY:", source["category"])
    print("URL:", source["url"])

    try:
        text = fetch_and_extract(source["url"])

        print("Characters extracted:", len(text))
        print("Preview:")
        print(text[:500])

    except Exception as error:
        print("ERROR:", error)