import json
from pathlib import Path

from app.retrieval.embeddings import (
    create_embeddings
)

from app.retrieval.vector_store import replace_collection


BASE_DIR = Path(
    __file__
).resolve().parent

CHUNKS_FILE = (
    BASE_DIR
    / "data"
    / "processed"
    / "chunks.json"
)


with open(
    CHUNKS_FILE,
    "r",
    encoding="utf-8"
) as file:

    chunks = json.load(file)


print("=" * 80)
print("BUILDING VECTOR DATABASE")
print("=" * 80)

print(
    f"Chunks: {len(chunks)}"
)


documents = [
    chunk["text"]
    for chunk in chunks
]


ids = [
    chunk["id"]
    for chunk in chunks
]


metadatas = [
    chunk["metadata"]
    for chunk in chunks
]


print("Creating embeddings...")


embeddings = create_embeddings(
    documents
)


print("Adding documents to ChromaDB...")


count = replace_collection(documents, embeddings, ids, metadatas)


print(
    "Vector database ready."
)

print(
    "Collection count:",
    count
)
