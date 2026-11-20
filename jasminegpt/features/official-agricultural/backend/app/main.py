from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.chatbot.rag_pipeline import answer_question
from app.ingestion.deep_search_controller import run_deep_search, should_run
from app.retrieval.search import search_knowledge_base
from app.retrieval.vector_store import get_collection_count
from app.sources.source_registry import get_all_sources, get_categories, get_sources_by_category
from app.storage.mongo_repository import repository


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    vec_count = get_collection_count()
    stats = repository.get_stats()
    print(f"\n[JasmineSathi] ChromaDB vectors on startup: {vec_count}")
    print(f"[JasmineSathi] MongoDB pages: {stats.get('page_count', 0)}, chunks: {stats.get('chunk_count', 0)}")
    if vec_count == 0 and stats.get("chunk_count", 0) > 0:
        print("[JasmineSathi] WARNING: ChromaDB empty but MongoDB has chunks. Run /admin/reload-chroma.")
    yield
    # Shutdown (nothing to clean up)


app = FastAPI(
    title="JasmineSathi — India Flower Farmer Discovery Platform",
    description="Trusted official jasmine and floriculture information for Indian farmers.",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1):517[0-9]$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str = Field(min_length=3, max_length=500)
    top_k: int = Field(default=5, ge=1, le=10)
    category: str | None = None


class ChatRequest(BaseModel):
    message: str = Field(min_length=3, max_length=500)


# ─────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────

@app.get("/")
def home():
    return {
        "platform": "JasmineSathi",
        "description": "India Jasmine & Flower Farmer Discovery Platform",
        "version": "2.0.0",
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "knowledge_base_vectors": get_collection_count(),
        "deep_search": repository.deep_search_status(),
    }


@app.get("/db-status")
def db_status():
    """Return knowledge base stats: page count, chunk count, last verified date."""
    stats = repository.get_stats()
    stats["chroma_vectors"] = get_collection_count()
    return stats


@app.get("/sources")
def all_sources():
    return {"sources": get_all_sources(), "categories": get_categories()}


@app.get("/sources/category/{category}")
def sources_by_category(category: str):
    return {"category": category, "sources": get_sources_by_category(category)}


@app.post("/search")
def search(request: SearchRequest):
    try:
        results = search_knowledge_base(
            request.query, request.top_k, category_filter=request.category
        )
        return {"query": request.query, "results": results}
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Search unavailable: {error}") from error


@app.post("/chat")
def chat(request: ChatRequest):
    try:
        return answer_question(request.message)
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Chat unavailable: {error}") from error


@app.post("/deep-search")
def trigger_deep_search(background_tasks: BackgroundTasks):
    """
    Manually trigger a deep search (respects the 24-hr gate).
    The crawl runs in the background so the request returns immediately.
    """
    status = should_run()
    if not status.get("due"):
        return {
            "triggered": False,
            "reason": status.get("reason"),
            "next_allowed_run": status.get("next_allowed_run"),
        }
    background_tasks.add_task(run_deep_search, "manual_api_trigger")
    return {
        "triggered": True,
        "message": "Deep search started in the background. Check /db-status for progress.",
    }


@app.post("/admin/reload-chroma")
def reload_chroma():
    """
    Rebuild ChromaDB index from existing MongoDB chunks (no re-crawl needed).
    Use this after restarting the server if ChromaDB is empty but MongoDB has data.
    """
    from app.retrieval.vector_store import rebuild_from_mongo
    all_chunks = repository.get_all_chunks()
    if not all_chunks:
        return {"message": "No chunks found in MongoDB. Run /deep-search first.", "vectors": 0}
    count = rebuild_from_mongo(all_chunks)
    return {
        "message": f"ChromaDB rebuilt from MongoDB.",
        "vectors": count,
        "chunks_in_mongo": len(all_chunks),
    }


@app.post("/admin/drop-and-reset")
def drop_and_reset():
    """
    Drop all existing MongoDB documents and start fresh.
    Use this once to clear old schema data.
    """
    result = repository.drop_all()
    return {
        "message": "All data dropped. Run /deep-search to rebuild.",
        "deleted": result,
    }
