import json
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[2]

PAGE_DATA_DIR = (
    BASE_DIR
    / "data"
    / "processed_pages"
)


def save_pages(pages):

    PAGE_DATA_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    output_file = (
        PAGE_DATA_DIR
        / "pages.json"
    )

    with open(
        output_file,
        "w",
        encoding="utf-8"
    ) as file:

        json.dump(
            pages,
            file,
            indent=2,
            ensure_ascii=False
        )

    print(
        f"Saved {len(pages)} pages"
    )

    print(
        f"File: {output_file}"
    )

    return output_file


def load_pages():

    input_file = (
        PAGE_DATA_DIR
        / "pages.json"
    )

    if not input_file.exists():

        return []

    with open(
        input_file,
        "r",
        encoding="utf-8"
    ) as file:

        return json.load(file)