from pathlib import Path
import json

from app.sources.source_registry import get_all_sources
from app.ingestion.web_fetcher import fetch_and_extract
from app.processing.cleaner import clean_text


BASE_DIR = Path(__file__).resolve().parents[2]

RAW_DATA_DIR = BASE_DIR / "data" / "raw"


def create_safe_filename(name):
    """
    Convert source name into a safe filename.
    """

    filename = name.lower()

    filename = filename.replace(" ", "_")
    filename = filename.replace("/", "_")
    filename = filename.replace("\\", "_")

    return filename


def save_source_data(source, text):
    """
    Save fetched text according to its category.
    """

    category = source["category"]

    category_dir = RAW_DATA_DIR / category

    category_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    filename = create_safe_filename(
        source["name"]
    )

    file_path = category_dir / f"{filename}.txt"

    with open(
        file_path,
        "w",
        encoding="utf-8"
    ) as file:

        file.write(text)

    return file_path


def run_ingestion():

    sources = get_all_sources()

    print(f"Total sources: {len(sources)}")

    for index, source in enumerate(sources, start=1):

        print("\n" + "=" * 70)

        print(
            f"[{index}/{len(sources)}] "
            f"{source['name']}"
        )

        print(
            f"Category: {source['category']}"
        )

        print(
            f"URL: {source['url']}"
        )

        try:

            text = fetch_and_extract(
                source["url"]
            )

            text = clean_text(text)

            if not text:

                print("No text extracted.")

                continue

            file_path = save_source_data(
                source,
                text
            )

            print(
                f"Saved: {file_path}"
            )

            print(
                f"Characters: {len(text)}"
            )

        except Exception as error:

            print(
                f"ERROR: {error}"
            )


if __name__ == "__main__":
    run_ingestion()