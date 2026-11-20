from datetime import datetime


def create_metadata(source, file_path, character_count):

    return {
        "source_name": source["name"],
        "source_url": source["url"],
        "category": source["category"],
        "source_type": source["type"],
        "language": source["language"],
        "priority": source["priority"],
        "file_path": str(file_path),
        "character_count": character_count,
        "fetched_at": datetime.now().isoformat()
    }