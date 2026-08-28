"""Create the private Supabase Storage buckets this application needs.

Replaces the ``server/scripts/init-storage.ts`` that went with the Express
backend. Idempotent: existing buckets are reported and left alone, so it is safe
to run against a live project.

    api\\.venv\\Scripts\\python.exe api\\scripts\\init_storage.py

Both buckets are private. Nothing here can make them public — see
``storage.ensure_bucket``.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import settings
from app.services import storage
from app.services.files import ALLOWED_MIME_TYPES


async def main() -> int:
    if not settings.storage_configured:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env")
        return 1

    mime_types = sorted(ALLOWED_MIME_TYPES)
    buckets = (settings.SUPABASE_DOCUMENTS_BUCKET, settings.SUPABASE_AVATARS_BUCKET)

    for bucket in buckets:
        created = await storage.ensure_bucket(
            bucket,
            allowed_mime_types=mime_types,
            file_size_limit=settings.MAX_UPLOAD_BYTES,
        )
        state = "created" if created else "already exists"
        print(f"  {bucket}: {state} (private)")

    print(f"\nAccepted types: {', '.join(mime_types)}")
    print(f"Size limit: {settings.MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
