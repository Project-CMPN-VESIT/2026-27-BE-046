# JasmineGPT application

The complete setup and operating guide is in the repository
[README.md](../README.md).

This directory contains the three JasmineGPT runtime services and the copied
Official Agricultural Web Retrieval feature.

| Directory | Service | Default URL |
| --- | --- | --- |
| `frontend/` | React + Vite web client | `http://localhost:5173` |
| `backend/` | Express + TypeScript API | `http://localhost:4000` |
| `rag/` | FastAPI retrieval sidecar | `http://localhost:8000` |

For local development, configure `backend/.env`,
`features/official-agricultural/backend/.env`, and optionally
`frontend/.env.local`. Install the `backend`/`frontend` npm dependencies and
both Python environments, then start MongoDB and the three application
services.

## Official Agricultural Web Retrieval

The frontend includes an **Official Agricultural Web Retrieval** sidebar item.
It opens a full-page search view backed by the copied feature service:

```text
jasminegpt\features\official-agricultural
```

The official service runs on port `8100`, because port `8000` is already used
by this repository's research RAG sidecar. The browser does not need a
separate official-service URL; configure only the main API in
`frontend/.env.local`:

```dotenv
# The frontend uses the main JasmineGPT API for both features.
VITE_API_BASE_URL=http://localhost:4000
```

Set up the copied backend once, then start it in another PowerShell window:

```powershell
cd jasminegpt\features\official-agricultural\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install pytest
Copy-Item .env.example .env
.\start_official.ps1
```

Check that it is available at `http://127.0.0.1:8100/health`. The main
JasmineGPT backend proxies the feature through
`/api/official-agricultural/*`. Its MongoDB, ChromaDB, crawler, and data remain
separate from JasmineGPT. Enter credentials manually in the copied feature's
`.env`; never copy the source project's real `.env`.

See the parent [README.md](../README.md) for the complete setup sequence,
environment-variable reference, health checks, tests, and troubleshooting.
