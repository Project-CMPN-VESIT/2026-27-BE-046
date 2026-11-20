# Start the copied Official Agricultural Web Retrieval FastAPI service.
# Run from this directory after creating .venv and installing requirements.txt.

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Error "Virtual environment not found. Run: py -3.12 -m venv .venv"
    exit 1
}

Write-Host "Starting Official Agricultural Web Retrieval on http://127.0.0.1:8100 ..."
& $python -m uvicorn app.main:app --host 127.0.0.1 --port 8100
