from app.retrieval.search import (
    search_knowledge_base
)


queries = [

    "What government schemes are available for farmers?",

    "What subsidies are available?",

    "How can a farmer apply for financial assistance?",

    "What agricultural services are available in Maharashtra?",

    "What documents are required for government schemes?"
]


for query in queries:

    print("\n")
    print("=" * 80)

    print(
        "QUERY:",
        query
    )

    results = search_knowledge_base(
        query,
        top_k=5
    )

    for result in results:

        metadata = (
            result["metadata"]
        )

        print("\n--- RESULT ---")

        print(
            "Rank:",
            result["rank"]
        )

        print(
            "Source:",
            metadata.get(
                "source_name"
            )
        )

        print(
            "Page:",
            metadata.get(
                "page_title"
            )
        )

        print(
            "Type:",
            metadata.get(
                "page_type"
            )
        )

        print(
            "Section:",
            metadata.get(
                "section"
            )
        )

        print(
            "URL:",
            metadata.get(
                "page_url"
            )
        )

        print(
            "Distance:",
            result["distance"]
        )

        print(
            "Text:",
            result["text"][:400]
        )