# JasmineGPT

JasmineGPT is an evidence-grounded, multilingual (English/Kannada) RAG
assistant for jasmine farmers. It combines a React web client, an Express API
with MongoDB-backed conversation memory, and a Python retrieval sidecar that
returns research evidence to the API.

## Architecture

```text
Browser (Vite :5173)
        |
        v
Express API (:4000) ---- MongoDB (:27017)
        |
        +--> FastAPI RAG sidecar (:8000)
        |       +-- FAISS index and research metadata
        |       +-- sentence-transformer embedding models
        |
        +--> Official agricultural FastAPI feature (:8100)
                +-- MongoDB official pages
                +-- ChromaDB and crawler
```

The backend is the main API. It calls the configured JasmineGPT LLM provider
and proxies `/api/official-agricultural/*` to the copied official-source
FastAPI service. The two retrieval systems keep their code, data, and database
collections separate.

## Repository layout

```text
JasmineGpt/
├── README.md                         # This guide
├── JASMINE_SATHI_COMPLETE_TECHNICAL_AUDIT.md
├── JasmineGPT_Phase1_...ipynb        # Research/prototype notebook
└── jasminegpt/
    ├── frontend/                     # React + Vite + TypeScript
    ├── backend/                      # Express + TypeScript + MongoDB
    ├── rag/                          # FastAPI + Python retrieval service
    │   └── data/                     # JasmineGPT FAISS index and metadata
    ├── features/
    │   └── official-agricultural/    # Copied official-source feature
    │       ├── backend/              # FastAPI crawler and ChromaDB service
    │       └── README.md
    └── README.md
```

All commands below are run from `jasminegpt` unless a different directory is
shown. On Windows, use PowerShell.

## Prerequisites

Install the following before setup:

- Node.js 20 or newer and npm
- Python 3.12 recommended (the included Windows helper uses `py -3.12`)
- MongoDB running locally, or a reachable MongoDB deployment
- Git

The first RAG startup downloads the embedding models from Hugging Face, so the
machine needs internet access the first time the sidecar is started. The
checked-in files under `rag/data/` mean that the FAISS index does not normally
need to be rebuilt.

## Installation

### 1. Clone and enter the application

```powershell
git clone <repository-url>
cd JasmineGpt\jasminegpt
```

If the repository is already present, just change into its `jasminegpt`
directory.

### 2. Install frontend dependencies

```powershell
cd frontend
npm install
cd ..
```

### 3. Install backend dependencies

```powershell
cd backend
npm install
cd ..
```

### 4. Create the RAG Python environment

```powershell
cd rag
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
```

If `py -3.12` is unavailable, create the environment with an installed
compatible Python 3 version and use that environment's `python.exe` for the
remaining commands.

## Environment configuration

There are three runtime configuration locations. Do not commit any real
`.env` file; `.env*` files are ignored by Git.

| File | Used by | Required secrets |
| --- | --- | --- |
| `jasminegpt\backend\.env` | Main Node/Express API | Main LLM key, if answer synthesis is enabled |
| `jasminegpt\frontend\.env.local` | Browser frontend | No secrets; only the main API URL |
| `jasminegpt\features\official-agricultural\backend\.env` | Official FastAPI feature | Official LLM key and official MongoDB URI |

The two backend services may use the same provider account, but their
configuration files are separate. If you use one OpenRouter key for both,
enter that key separately in each `.env`; do not copy the source project's
`.env` file.

### Backend: `backend\.env`

Create `jasminegpt\backend\.env`:

```dotenv
# Server
NODE_ENV=development
PORT=4000
CORS_ORIGIN=http://localhost:5173

# MongoDB (MongoDB must be running before starting the backend)
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB_NAME=jasminesathi_gpt

# Python retrieval sidecar
RAG_SIDECAR_URL=http://localhost:8000
OFFICIAL_AGRICULTURAL_SERVICE_URL=http://127.0.0.1:8100

# LLM provider: openrouter (default) or gemini
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=replace_with_openrouter_key
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# Only set these when LLM_PROVIDER=gemini
# GEMINI_API_KEY=replace_with_google_ai_key
# GEMINI_MODEL=gemini-2.5-flash

# Optional operational limits
LOG_LEVEL=info
MAX_MESSAGE_LENGTH=4000
MAX_CONTEXT_TURNS=8
```

`backend/src/config/env.ts` loads this exact file (`backend/.env`) and supplies
defaults for all values except the provider-specific API keys. Set
`GEMINI_API_KEY` instead of `OPENROUTER_API_KEY` when using Gemini.

The API can start without an LLM key and will return raw evidence facts when
answer synthesis is unavailable. A key is required for normal generated
answers. MongoDB and the RAG sidecar are required for the complete chat flow.

Useful backend-only variables used by diagnostics/evaluation are:

| Variable | Purpose |
| --- | --- |
| `RAG_DEBUG_LLM=1` | Enable additional LLM diagnostic logging |
| `RAG_DEBUG_SYNTHESIS=1` | Enable synthesis diagnostics for general RAG |
| `EVAL_LOGGING=0` | Disable evaluation record logging (enabled by default) |

### Frontend: `frontend\.env.local`

Create `jasminegpt\frontend\.env.local` when the main API is not at the
default URL:

```dotenv
VITE_API_BASE_URL=http://localhost:4000
```

`VITE_API_BASE_URL` defaults to `http://localhost:4000`. The browser uses the
main JasmineGPT API for both features; the Node backend proxies official
retrieval requests to its internal service on port `8100`. Vite exposes only
variables prefixed with `VITE_`; never put an API key in this file because
frontend values are shipped to the browser.

### RAG sidecar variables

The RAG service does not require an API key or a separate `.env` file. It reads
the checked-in files under `jasminegpt\rag\data\` and loads the
`BAAI/bge-small-en-v1.5` sentence-transformer model. The first startup needs
internet access to download that model; later startups reuse the local model
cache.

It reads these optional process variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RAG_PORT` | `8000` | FastAPI listening port |
| `BACKEND_ORIGIN` | `http://localhost:4000` | CORS origin for the backend |
| `GENERAL_FAISS_INDEX_PATH` | `rag/data/general_faiss.index` | General FAISS index |
| `GENERAL_CHUNKS_CSV_PATH` | `rag/data/general_chunks.csv` | General chunk data |
| `RAG_DEBUG_RETRIEVAL=1` | disabled | Additional retrieval diagnostics |

If `RAG_PORT` or `BACKEND_ORIGIN` is changed, update `RAG_SIDECAR_URL` or
`CORS_ORIGIN`/the corresponding service command as appropriate.

### Complete RAG setup

Run these commands from the repository root after installing the frontend and
backend dependencies:

```powershell
cd jasminegpt\rag
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

There is no RAG `.env` file to create. The optional settings above can be
provided as PowerShell environment variables for the current terminal:

```powershell
$env:RAG_PORT = "8000"
$env:BACKEND_ORIGIN = "http://localhost:4000"
```

The repository already includes the general RAG artifacts:

```text
jasminegpt\rag\data\general_faiss.index
jasminegpt\rag\data\general_chunks.csv
jasminegpt\rag\data\chunk_metadata.csv
jasminegpt\rag\data\metadata.csv
```

Do not delete these files unless you intend to rebuild the index. The sidecar
contains two retrieval pipelines:

- `GENERAL_RAG`: broad jasmine cultivation, irrigation, nutrition, pruning,
  pest, disease, and post-harvest research.
- `POSTHARVEST`: post-harvest research with additional evidence gating.

The Node backend calls this service internally using `RAG_SIDECAR_URL`; users
normally do not call port `8000` directly from the browser.

### Start and verify the RAG service

In the `jasminegpt\rag` directory, start it with the included Windows script:

```powershell
.\start_rag.ps1
```

The script uses `rag\.venv\Scripts\python.exe` and starts the service on port
`8000`. Keep this PowerShell window running. In another window, verify the
service:

```powershell
Invoke-RestMethod http://localhost:8000/health
```

Expected response fields include:

```text
status: ok
general_rag_ready: True
postharvest_rag_ready: True
```

You can also test retrieval directly:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:8000/rag/general `
  -ContentType "application/json" `
  -Body '{"query":"What is the recommended spacing for Jasminum sambac?","top_k":2}'
```

If `/health` reports a pipeline as not ready, inspect the RAG terminal for
missing data files, dependency errors, or the initial model download.

## Running the complete application

Start MongoDB first. Then open four PowerShell windows when using the official
retrieval feature.

### Terminal 1: RAG sidecar

```powershell
cd jasminegpt\rag
.\start_rag.ps1
```

Or start it directly:

```powershell
cd jasminegpt\rag
.\.venv\Scripts\python.exe -m uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

Verify it at <http://localhost:8000/health>. The response should show
`"status": "ok"` and both RAG pipelines ready.

### Terminal 2: Official Agricultural Web Retrieval service (optional)

This is the copied FastAPI service under
`jasminegpt\features\official-agricultural\backend`. It uses its own
MongoDB/ChromaDB data and must not be started on port 8000, which is already
used by JasmineGPT's RAG sidecar.

Set up the copied feature once:

```powershell
cd jasminegpt\features\official-agricultural\backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install pytest
Copy-Item .env.example .env
```

Open `jasminegpt\features\official-agricultural\backend\.env` and replace the
placeholders manually:

```dotenv
OPENROUTER_API_KEY=your_official_openrouter_key
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_TIMEOUT_SECONDS=45
MONGODB_URI=your_official_mongodb_connection_string
MONGODB_DATABASE=jasminesathi
MONGODB_SCHEMES_COLLECTION=schemes
MONGODB_LOGS_COLLECTION=verification_logs
DEEP_SEARCH_INTERVAL_HOURS=24
```

The official service uses `MONGODB_DATABASE=jasminesathi`, while the main
JasmineGPT backend uses `MONGODB_DB_NAME=jasminesathi_gpt`. They are logically
separate even if both use the same local MongoDB server or Atlas account.
The copied feature's `.env.example` contains placeholders only. Never copy
the original source project's real `.env` or its credential values.

Start it:

```powershell
.\start_official.ps1
```

Verify it directly at <http://127.0.0.1:8100/health>, or through the main API
at <http://localhost:4000/api/official-agricultural/health>. The browser calls
the main API proxy, not the feature service directly.

### Terminal 3: backend

```powershell
cd jasminegpt\backend
npm run dev
```

Verify it at <http://localhost:4000/health>. The backend connects to MongoDB
during startup, so a failed MongoDB connection prevents the server from
starting.

### Terminal 4: frontend

```powershell
cd jasminegpt\frontend
npm run dev
```

Open the URL printed by Vite, normally <http://localhost:5173>.

The **Official Agricultural Web Retrieval** item in the sidebar opens the
copied feature's full-page search interface. The normal JasmineGPT chat
continues to use the JasmineGPT backend and research RAG sidecar.

## Production-style commands

Build and run the backend:

```powershell
cd jasminegpt\backend
npm run build
npm start
```

Build and preview the frontend:

```powershell
cd jasminegpt\frontend
npm run build
npm run preview
```

The Python sidecar can be run without reload for a production-style process:

```powershell
cd jasminegpt\rag
.\.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000
```

## Testing and validation

Backend unit tests and type checking:

```powershell
cd jasminegpt\backend
npm test
npm run typecheck
```

Frontend lint and production build:

```powershell
cd jasminegpt\frontend
npm run lint
npm run build
```

RAG checks:

```powershell
cd jasminegpt\rag
.\.venv\Scripts\python.exe -m pytest
```

Official Agricultural feature checks:

```powershell
cd jasminegpt\features\official-agricultural\backend
.\.venv\Scripts\python.exe -m pytest
```

The repository also includes `test_app_startup.py`,
`verify_all_requirements.py`, and focused RAG tests that can be run directly
with the same Python executable.

## Evaluation reports

The backend records one JSON evaluation record per handled query by default.
When commands are run from `jasminegpt/backend`, the default output directory
is `../../evaluation` relative to that working directory (with `logs/` and
`reports/` beneath it). Set `EVAL_DIR` to keep evaluation output in a specific
location. These runtime directories are ignored by Git.

Run the canonical evaluation queries while MongoDB, the RAG sidecar, and the
configured LLM are available:

```powershell
cd jasminegpt\backend
npm run eval:canonical
npm run eval:report
```

Set `EVAL_DIR` if evaluation output should be stored elsewhere.

## Rebuilding the general RAG index

Only rebuild the general index when the source corpus or chunking logic
changes. The builder expects the source PDF corpus described in
`rag/build_general_corpus.py` and writes the generated FAISS/CSV files to
`rag/data/`. The source PDFs are not included in the repository. Place the
PDFs listed in `build_general_corpus.py` in `jasminegpt\rag\source_pdfs\`
before rebuilding.

```powershell
cd jasminegpt\rag
.\.venv\Scripts\python.exe build_general_corpus.py
```

For PDFs stored elsewhere, set `RAG_SOURCE_PDF_DIR` before running the builder:

```powershell
$env:RAG_SOURCE_PDF_DIR = "C:\path\to\jasmine-papers"
.\.venv\Scripts\python.exe build_general_corpus.py
```

Rebuilding requires the PDF parser and embedding dependencies included in
`requirements.txt`. It replaces the existing files in `rag\data\`, so back up
the current artifacts first if you need to preserve them.

## Troubleshooting

- **Backend exits with a MongoDB error:** start MongoDB and check
  `MONGODB_URI`/`MONGODB_DB_NAME` in `backend\.env`.
- **Chat reports that the RAG sidecar is unavailable:** start the sidecar and
  confirm `RAG_SIDECAR_URL` matches its port.
- **Official retrieval reports that its service is unavailable:** start
  `features\official-agricultural\backend\start_official.ps1`, confirm
  `OFFICIAL_AGRICULTURAL_SERVICE_URL=http://127.0.0.1:8100`, and check
  `/api/official-agricultural/health` through the main backend.
- **Official retrieval has no answer or sources:** check the official
  feature's own `.env`, MongoDB database (`MONGODB_DATABASE=jasminesathi`),
  and ChromaDB count at `/api/official-agricultural/db-status`.
- **RAG startup fails while loading a model:** allow the initial Hugging Face
  model download and confirm the Python dependencies were installed in
  `rag\.venv`.
- **Browser shows network/CORS errors:** confirm the frontend URL matches
  `CORS_ORIGIN` and that `VITE_API_BASE_URL` points to the backend.
- **Answers contain evidence but no generated synthesis:** configure the key
  for the selected `LLM_PROVIDER`; the no-key mode is intentional.

## Evidence policy

The system is designed to answer from retrieved research evidence. It
distinguishes direct, related, and insufficient evidence and preserves source
citations rather than presenting unsupported agricultural recommendations as
facts.

## Author

**Akansha Zambare** — Final Year B.E. project.
