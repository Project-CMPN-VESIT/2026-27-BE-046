import json
from pathlib import Path

from app.ingestion.page_store import (
    load_pages
)

from app.processing.chunker import (
    create_chunks
)
from app.storage.mongo_repository import repository


BASE_DIR = Path(
    __file__
).resolve().parent

OUTPUT_DIR = (
    BASE_DIR
    / "data"
    / "processed"
)

OUTPUT_DIR.mkdir(
    parents=True,
    exist_ok=True
)


pages = load_pages()


print("=" * 80)
print("DOCUMENT PROCESSING")
print("=" * 80)

print(
    f"Pages loaded: {len(pages)}"
)


all_chunks = []


for index, page in enumerate(
    pages,
    start=1
):

    chunks = create_chunks(
        page
    )

    for chunk_index, chunk in enumerate(
        chunks,
        start=1
    ):

        chunk["id"] = (
            f"page_{index}_"
            f"chunk_{chunk_index}"
        )

        all_chunks.append(
            chunk
        )


output_file = (
    OUTPUT_DIR
    / "chunks.json"
)


with open(
    output_file,
    "w",
    encoding="utf-8"
) as file:

    json.dump(
        all_chunks,
        file,
        indent=2,
        ensure_ascii=False
    )


print(
    f"Total chunks: "
    f"{len(all_chunks)}"
)

print(
    f"Saved: {output_file}"
)

mongo_pages_updated = repository.save_chunks(all_chunks)
print(f"MongoDB pages updated with chunks: {mongo_pages_updated}")
