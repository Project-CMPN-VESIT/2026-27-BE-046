"""ChromaDB search for JasmineSathi knowledge base."""
from __future__ import annotations

from app.retrieval.embeddings import create_embedding
from app.retrieval.vector_store import get_collection


def search_knowledge_base(
    query: str,
    top_k: int = 8,
    category_filter: str | None = None,
) -> list[dict]:
    """
    Search the jasmine_india_knowledge_base ChromaDB collection.

    Args:
        query: farmer's question
        top_k: number of results to return
        category_filter: optional category name to restrict results
    """
    col = get_collection()  # Always get the live collection
    query_embedding = create_embedding(query)

    where_clause = None
    if category_filter:
        where_clause = {"category": {"$eq": category_filter}}

    results = col.query(
        query_embeddings=[query_embedding],
        n_results=top_k,
        include=["documents", "metadatas", "distances"],
        where=where_clause if where_clause else None,
    )

    documents = results.get("documents", [[]])[0]
    metadatas = results.get("metadatas", [[]])[0]
    distances = results.get("distances", [[]])[0]

    formatted = []
    for i in range(len(documents)):
        distance = float(distances[i])
        # ChromaDB default metric is squared L2 distance.
        # For unit-normalized embeddings, L2^2 = 2 - 2*cos(theta).
        # Therefore, cosine_similarity = max(0.0, 1.0 - (distance / 2.0)).
        if distance <= 2.0:
            score = round(max(0.0, 1.0 - (distance / 2.0)), 4)
        else:
            score = round(1.0 / (1.0 + distance), 4)

        formatted.append({
            "rank": i + 1,
            "text": documents[i],
            "metadata": metadatas[i],
            "distance": distance,
            "score": score,
        })

    return formatted
