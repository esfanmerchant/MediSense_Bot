# API commands

Windows PowerShell, from the repo root. Substitute `python` for
`api/.venv/Scripts/python.exe` if the venv is activated.

```powershell
# Install (first time)
python -m venv api\.venv
api\.venv\Scripts\python.exe -m pip install -e "api[dev]"

# Optional: OCR support (~500 MB — PaddlePaddle and its dependencies)
api\.venv\Scripts\python.exe -m pip install -e "api[ocr]"

# Database
cd api; ..\api\.venv\Scripts\python.exe -m alembic upgrade head    # apply migrations
cd api; ..\api\.venv\Scripts\python.exe -m alembic check           # fail if models drift from the schema
cd api; ..\api\.venv\Scripts\python.exe -m alembic revision --autogenerate -m "describe change"

# Run
api\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 4000 --app-dir api

# Verify
cd api; ..\api\.venv\Scripts\python.exe -m pytest -q
cd api; ..\api\.venv\Scripts\python.exe -m ruff check .
cd api; ..\api\.venv\Scripts\python.exe -m ruff format .
```

`alembic check` is the drift gate: it exits non-zero if the SQLAlchemy models
and the live schema disagree, which catches a model edit that was never
migrated.
