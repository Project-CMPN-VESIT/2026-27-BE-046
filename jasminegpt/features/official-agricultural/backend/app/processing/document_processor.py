from pathlib import Path
import json
import re


BASE_DIR = Path(__file__).resolve().parents[2]

RAW_DATA_DIR = BASE_DIR / "data" / "raw"
PROCESSED_DATA_DIR = BASE_DIR / "data" / "processed"


def clean_document_text(text):
    """
    Clean raw extracted text.
    """

    # Replace multiple whitespace characters
    text = re.sub(r"\s+", " ", text)

    # Remove unnecessary spaces
    text = text.strip()

    return text


def create_chunks(text, chunk_size=800, overlap=100):
    """
    Split text into overlapping chunks.
    """

    words = text.split()

    chunks = []

    start = 0

    while start < len(words):

        end = start + chunk_size

        chunk_words = words[start:end]

        chunk = " ".join(chunk_words)

        if chunk:
            chunks.append(chunk)

        start += chunk_size - overlap

    return chunks


def get_category(file_path):
    """
    Determine category from directory structure.
    """

    relative_path = file_path.relative_to(RAW_DATA_DIR)

    return relative_path.parts[0]


def create_metadata(file_path, category):
    """
    Create metadata for the source document.
    """

    filename = file_path.stem

    return {
        "source_name": filename,
        "category": category,
        "file_name": file_path.name
    }


def process_document(file_path):

    print(f"Processing: {file_path}")

    with open(
        file_path,
        "r",
        encoding="utf-8"
    ) as file:

        text = file.read()

    text = clean_document_text(text)

    category = get_category(file_path)

    metadata = create_metadata(
        file_path,
        category
    )

    chunks = create_chunks(text)

    processed_chunks = []

    for index, chunk in enumerate(
        chunks,
        start=1
    ):

        chunk_data = {
            "chunk_id": f"{file_path.stem}_{index}",
            "text": chunk,
            "metadata": metadata
        }

        processed_chunks.append(
            chunk_data
        )

    return processed_chunks


def save_processed_document(
    file_path,
    chunks
):

    category = get_category(file_path)

    output_directory = (
        PROCESSED_DATA_DIR / category
    )

    output_directory.mkdir(
        parents=True,
        exist_ok=True
    )

    output_file = (
        output_directory /
        f"{file_path.stem}.json"
    )

    with open(
        output_file,
        "w",
        encoding="utf-8"
    ) as file:

        json.dump(
            chunks,
            file,
            indent=2,
            ensure_ascii=False
        )

    return output_file


def process_all_documents():

    files = list(
        RAW_DATA_DIR.rglob("*.txt")
    )

    print(
        f"Documents found: {len(files)}"
    )

    for file_path in files:

        try:

            chunks = process_document(
                file_path
            )

            output_file = (
                save_processed_document(
                    file_path,
                    chunks
                )
            )

            print(
                f"Chunks created: {len(chunks)}"
            )

            print(
                f"Saved: {output_file}"
            )

        except Exception as error:

            print(
                f"ERROR processing "
                f"{file_path}: {error}"
            )


if __name__ == "__main__":
    process_all_documents()