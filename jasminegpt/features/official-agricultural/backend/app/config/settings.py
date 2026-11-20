import os
from pathlib import Path

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[2]
load_dotenv(BACKEND_DIR / ".env")

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")
OPENROUTER_TIMEOUT_SECONDS = int(os.getenv("OPENROUTER_TIMEOUT_SECONDS", "45"))

MONGODB_URI = os.getenv("MONGODB_URI", "")
MONGODB_DATABASE = os.getenv("MONGODB_DATABASE", "jasminesathi")
MONGODB_SCHEMES_COLLECTION = os.getenv("MONGODB_SCHEMES_COLLECTION", "schemes")
MONGODB_LOGS_COLLECTION = os.getenv("MONGODB_LOGS_COLLECTION", "verification_logs")
DEEP_SEARCH_INTERVAL_HOURS = int(os.getenv("DEEP_SEARCH_INTERVAL_HOURS", "24"))

CHROMA_COLLECTION = os.getenv("CHROMA_COLLECTION", "jasmine_india_knowledge_base")
