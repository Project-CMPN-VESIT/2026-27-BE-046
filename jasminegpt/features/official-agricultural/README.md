# Official Agricultural Web Retrieval

This directory contains the copied, self-contained official-source retrieval
feature. The original source project remains unchanged at
`C:\Users\sailee\Documents\farmer-information-platform`.

## What is included

- FastAPI application under `backend/app/`
- Official-source crawler, page processing, ChromaDB retrieval, and source registry
- Separate `backend/data/` corpus and `backend/vector_db/` ChromaDB files
- Official feature tests and maintenance scripts
- Sanitized `backend/.env.example`

The existing JasmineGPT research RAG remains in `jasminegpt/rag/`. These two
retrieval systems use separate code, data, and database collections.

## Setup

```powershell
cd jasminegpt\features\official-agricultural\backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install pytest
Copy-Item .env.example .env
```

Edit `.env` with the official feature's own MongoDB and OpenRouter settings.
Use the placeholders in `.env.example` as a template, enter credentials
manually, and do not copy credentials from the source project's `.env`.

## Run

From `jasminegpt\features\official-agricultural\backend`:

```powershell
.\start_official.ps1
```

The service listens on `http://127.0.0.1:8100`. The main Node backend proxies
it through `/api/official-agricultural/*`, so the browser does not call this
service directly.

## Endpoints

The copied FastAPI service retains its original endpoints:

- `GET /health`
- `GET /db-status`
- `GET /sources`
- `POST /search`
- `POST /chat`
- `POST /deep-search`
- `POST /admin/reload-chroma`

The JasmineGPT Node backend exposes the same feature through:

- `/api/official-agricultural/health`
- `/api/official-agricultural/db-status`
- `/api/official-agricultural/sources`
- `/api/official-agricultural/search`
- `/api/official-agricultural/chat`
- `/api/official-agricultural/deep-search`
- `/api/official-agricultural/admin/reload-chroma`

## Tests

```powershell
cd jasminegpt\features\official-agricultural\backend
.\.venv\Scripts\python.exe -m pytest
```
