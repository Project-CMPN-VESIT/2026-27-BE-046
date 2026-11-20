from app.ingestion.crawler import ControlledCrawler


URL = "https://www.myscheme.gov.in/"


crawler = ControlledCrawler(
    start_url=URL,
    max_pages=10,
    minimum_usefulness=35
)


pages = crawler.crawl()


print("\n")
print("=" * 80)
print("SEMANTIC CRAWL COMPLETE")
print("=" * 80)

print(
    f"Pages collected: {len(pages)}"
)


# Sort pages by usefulness

pages.sort(
    key=lambda x: x["usefulness_score"],
    reverse=True
)


for index, page in enumerate(
    pages,
    start=1
):

    print("\n" + "=" * 80)

    print(
        f"RANK #{index}"
    )

    print(
        "URL:",
        page["url"]
    )

    print(
        "TITLE:",
        page["title"]
    )

    print(
        "PAGE TYPE:",
        page["page_type"]
    )

    print(
        "SEMANTIC SCORE:",
        round(
            page["semantic_score"],
            3
        )
    )

    print(
        "USEFULNESS SCORE:",
        page["usefulness_score"]
    )

    print(
        "ACTIONABILITY:",
        page["actionability_score"]
    )

    print(
        "NOISE:",
        page["noise_score"]
    )

    print(
        "WORD COUNT:",
        page["statistics"]["word_count"]
    )

    print(
        "ACTIONABILITY TERMS:",
        page["actionability_terms"]
    )

    print("\nTEXT PREVIEW:")

    print(
        page["text"][:500]
    )