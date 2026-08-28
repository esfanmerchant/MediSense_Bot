"""Supabase Storage, over the REST API.

Three rules hold everywhere in this module.

**The service role key never leaves the server.** It bypasses row-level security
entirely, so it lives in this module's request headers and nowhere else — not in
a response, not in a log line, not in an error message. ``_safe_detail`` exists
because Supabase's own error bodies are the most likely place for it to leak
back out.

**Buckets are private and delivery URLs are signed per request.** There is no
public URL for a medical document. A link is minted only after the caller has
passed the access check, expires in minutes, and is audited on the way out —
which is what stops "has the URL" from becoming "may read the chart"
(spec §26, conflict C8).

**Object paths are generated, never taken from the caller.** A path is
``{patientId}/{documentId}{ext}``, all three parts produced by us, so a crafted
filename cannot traverse out of its prefix or collide with another patient's
object.

httpx is used directly rather than the ``supabase`` SDK: the storage surface
here is four calls, the SDK's client is synchronous and would block the event
loop, and one less dependency in a healthcare service's tree is worth having.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import settings
from app.core.errors import AppError, ErrorCode, service_unavailable
from app.core.logging import logger


class StorageUnavailableError(AppError):
    def __init__(self, message: str = "Document storage is unavailable. Try again shortly.") -> None:
        super().__init__(503, ErrorCode.SERVICE_UNAVAILABLE, message)


@dataclass(frozen=True)
class StoredObject:
    bucket: str
    path: str


def object_path(patient_id: str, document_id: str, extension: str) -> str:
    """Where an object lives.

    Prefixed by patient so a bucket listing is grouped the way access is, and
    named by the document's own unguessable id so knowing a patient's id is not
    enough to guess an object.
    """
    return f"{patient_id}/{document_id}{extension}"


def _base_url() -> str:
    return settings.SUPABASE_URL.rstrip("/")


def _headers(content_type: str | None = None) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _safe_detail(response: httpx.Response) -> str:
    """A short, non-sensitive description of a storage failure.

    Supabase echoes request context in error bodies, so the body is summarised
    for the log and never returned to a caller or logged in full.
    """
    try:
        body: Any = response.json()
        message = body.get("message") or body.get("error") or ""
    except ValueError:
        message = ""
    return f"status={response.status_code} message={str(message)[:120]}"


def _require_configured() -> None:
    if not settings.storage_configured:
        raise service_unavailable(
            "Document storage is not configured on this server."
        )


async def upload(
    bucket: str, path: str, content: bytes, content_type: str, *, upsert: bool = False
) -> StoredObject:
    """Put an object into a private bucket."""
    _require_configured()
    headers = _headers(content_type)
    if upsert:
        headers["x-upsert"] = "true"

    try:
        async with httpx.AsyncClient(timeout=settings.STORAGE_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"{_base_url()}/storage/v1/object/{bucket}/{path}",
                headers=headers,
                content=content,
            )
    except httpx.HTTPError as exc:
        logger.error("storage_upload_failed", bucket=bucket, error=type(exc).__name__)
        raise StorageUnavailableError() from exc

    if response.status_code >= 400:
        logger.error("storage_upload_rejected", bucket=bucket, detail=_safe_detail(response))
        if response.status_code == 409:
            raise AppError(409, ErrorCode.CONFLICT, "That file has already been uploaded.")
        raise StorageUnavailableError("The file could not be stored. Try again.")

    return StoredObject(bucket=bucket, path=path)


async def signed_url(bucket: str, path: str, ttl_seconds: int | None = None) -> str:
    """Mint a short-lived delivery URL.

    Called only after the caller has passed the access check. The TTL is
    deliberately short: the link is for the redirect that follows, not something
    to keep.
    """
    _require_configured()
    ttl = ttl_seconds or settings.SUPABASE_SIGNED_URL_TTL_SECONDS

    try:
        async with httpx.AsyncClient(timeout=settings.STORAGE_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"{_base_url()}/storage/v1/object/sign/{bucket}/{path}",
                headers=_headers("application/json"),
                json={"expiresIn": ttl},
            )
    except httpx.HTTPError as exc:
        logger.error("storage_sign_failed", bucket=bucket, error=type(exc).__name__)
        raise StorageUnavailableError() from exc

    if response.status_code >= 400:
        logger.error("storage_sign_rejected", bucket=bucket, detail=_safe_detail(response))
        raise StorageUnavailableError("The document could not be opened. Try again.")

    signed = response.json().get("signedURL") or response.json().get("signedUrl")
    if not signed:
        logger.error("storage_sign_empty", bucket=bucket)
        raise StorageUnavailableError("The document could not be opened. Try again.")

    # Supabase returns a path relative to /storage/v1.
    return f"{_base_url()}/storage/v1{signed}" if signed.startswith("/") else signed


async def download(bucket: str, path: str) -> bytes:
    """Fetch an object's bytes server-side.

    Used by OCR in Phase 7, which must read a document without ever handing a
    URL to anyone.
    """
    _require_configured()
    try:
        async with httpx.AsyncClient(timeout=settings.STORAGE_TIMEOUT_SECONDS) as client:
            response = await client.get(
                f"{_base_url()}/storage/v1/object/{bucket}/{path}", headers=_headers()
            )
    except httpx.HTTPError as exc:
        logger.error("storage_download_failed", bucket=bucket, error=type(exc).__name__)
        raise StorageUnavailableError() from exc

    if response.status_code >= 400:
        logger.error("storage_download_rejected", bucket=bucket, detail=_safe_detail(response))
        raise StorageUnavailableError("The document could not be read.")

    return response.content


async def remove(bucket: str, path: str) -> bool:
    """Delete an object. Returns False if it was already gone.

    Note that the application soft-deletes document *rows*; this is used when an
    upload half-succeeded and the row was never written, so an orphaned object
    is not left behind.
    """
    _require_configured()
    try:
        async with httpx.AsyncClient(timeout=settings.STORAGE_TIMEOUT_SECONDS) as client:
            response = await client.delete(
                f"{_base_url()}/storage/v1/object/{bucket}/{path}", headers=_headers()
            )
    except httpx.HTTPError as exc:
        # Never fatal: a leftover object is a cleanup problem, not a request
        # failure, and raising here would mask the error that led to it.
        logger.error("storage_delete_failed", bucket=bucket, error=type(exc).__name__)
        return False

    if response.status_code >= 400:
        logger.warning("storage_delete_rejected", bucket=bucket, detail=_safe_detail(response))
        return False
    return True


async def ensure_bucket(
    bucket: str, *, allowed_mime_types: list[str], file_size_limit: int
) -> bool:
    """Create a private bucket if it does not exist. Returns True if created.

    ``public`` is hard-coded false and is not a parameter: there is no
    circumstance in this application where a bucket holding patient documents
    should be public, so it is not made configurable.
    """
    _require_configured()
    async with httpx.AsyncClient(timeout=settings.STORAGE_TIMEOUT_SECONDS) as client:
        existing = await client.get(
            f"{_base_url()}/storage/v1/bucket/{bucket}", headers=_headers()
        )
        if existing.status_code == 200:
            return False

        created = await client.post(
            f"{_base_url()}/storage/v1/bucket",
            headers=_headers("application/json"),
            json={
                "id": bucket,
                "name": bucket,
                "public": False,
                "file_size_limit": file_size_limit,
                "allowed_mime_types": allowed_mime_types,
            },
        )
        if created.status_code >= 400:
            raise StorageUnavailableError(
                f"Could not create the '{bucket}' bucket: {_safe_detail(created)}"
            )
        return True
