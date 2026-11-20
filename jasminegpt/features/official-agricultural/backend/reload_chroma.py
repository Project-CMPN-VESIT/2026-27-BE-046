"""
Reload chunks from MongoDB into ChromaDB.
Run this once after fixing the stale collection bug.
"""
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from app.storage.mongo_repository import repository
from app.retrieval.vector_store import rebuild_from_mongo, get_collection_count

print("Loading all chunks from MongoDB...")
chunks = repository.get_all_chunks()
print(f"Found {len(chunks)} chunks in MongoDB")

if not chunks:
    print("ERROR: No chunks found. Run deep search first.")
    sys.exit(1)

print("Rebuilding ChromaDB from MongoDB chunks...")
count = rebuild_from_mongo(chunks)
print(f"ChromaDB rebuilt with {count} vectors")
print(f"Collection count: {get_collection_count()}")
print("DONE - ChromaDB is ready for search")
