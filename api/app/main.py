"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.deps import DbSession
from app.core import redis as redis_store
from app.core.config import settings
from app.core.errors import AppError, ErrorCode
from app.core.logging import configure_logging, logger
from app.db.session import check_database_connection, dispose_engine
from app.modules.account.router import router as account_router
from app.modules.appointments.router import router as appointments_router
from app.modules.assistant.router import router as assistant_router
from app.modules.audit.router import router as audit_router
from app.modules.auth.router import router as auth_router
from app.modules.billing.router import router as billing_router
from app.modules.billing.verification import router as payment_verification_router
from app.modules.billing.withdrawals import router as withdrawals_router
from app.modules.dashboard.router import router as dashboard_router
from app.modules.departments.router import router as departments_router
from app.modules.doctor_applications.admin_router import router as doctor_applications_admin_router
from app.modules.doctor_applications.router import router as doctor_application_router
from app.modules.doctors.router import router as doctors_router
from app.modules.documents.ocr_router import router as ocr_router
from app.modules.documents.router import router as documents_router
from app.modules.emergency.router import router as emergency_router
from app.modules.notifications import dispatcher
from app.modules.notifications.router import router as notifications_router
from app.modules.patients.router import router as patients_router
from app.modules.prescriptions.reminders import router as medication_reminders_router
from app.modules.prescriptions.router import router as prescriptions_router
from app.modules.records.router import router as records_router
from app.modules.users.router import router as users_router
from app.modules.vitals import stream
from app.modules.vitals.alerts_router import router as alerts_router
from app.modules.vitals.router import router as vitals_router
from app.services import storage
from app.services.files import ALLOWED_MIME_TYPES

configure_logging()


async def _ensure_storage_buckets() -> None:
    """Make sure every bucket the application writes to exists, and is private.

    Called at boot so a fresh deployment does not depend on somebody having
    created them by hand — which is how `doctor-credentials` came to be
    configured everywhere and to exist nowhere, and every registration document
    upload failed with a message that could not say why.

    Never fatal. Storage being unreachable is a reason to refuse an upload, not
    a reason to refuse to start.
    """
    buckets = (
        settings.SUPABASE_DOCUMENTS_BUCKET,
        settings.SUPABASE_AVATARS_BUCKET,
        settings.SUPABASE_CREDENTIALS_BUCKET,
        settings.SUPABASE_PAYMENT_PROOFS_BUCKET,
    )
    for bucket in buckets:
        try:
            if await storage.ensure_bucket(
                bucket,
                allowed_mime_types=sorted(ALLOWED_MIME_TYPES),
                file_size_limit=settings.MAX_UPLOAD_BYTES,
            ):
                logger.info("storage_bucket_created", bucket=bucket)
        except Exception as exc:  # pragma: no cover — a boot-time network path
            logger.warning(
                "storage_bucket_unavailable", bucket=bucket, error=type(exc).__name__
            )


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    if not await check_database_connection():
        logger.error(
            "database_unreachable",
            hint="Check DATABASE_URL in .env, then run: alembic upgrade head",
        )
    if not settings.storage_configured:
        logger.warning("storage_not_configured", detail="document upload disabled")
    else:
        await _ensure_storage_buckets()
    if not settings.ai_configured:
        logger.warning("ai_not_configured", detail="chatbot and symptom analysis disabled")
    # An unsubscribe link is only as good as the address it points at. In
    # production a localhost one is a dead link in real mail — which is worse
    # than no link, because a reader who presses it and gets nothing reports
    # the message instead.
    if settings.is_production and "localhost" in settings.CLIENT_ORIGIN:
        logger.error(
            "client_origin_is_localhost",
            hint="set CLIENT_ORIGIN to the public URL; email links point at it",
        )
    if not settings.push_enabled:
        logger.info("push_not_configured", detail="medication reminders stay in the portal")
    if not settings.email_configured:
        logger.warning("email_not_configured", detail="notifications will be logged, not sent")
    else:
        # Which mailbox this process will send from, said once at startup.
        # Settings are read when the process starts, so a `.env` edited after
        # that changes nothing until a restart — and the readiness probe
        # cannot tell the difference, because "a user and a password are set"
        # is true of the old ones too. One line here turns an invisible stale
        # process into an obvious one.
        logger.info("email_ready", sender=settings.SMTP_USER, host=settings.SMTP_HOST)

    # Email delivery and appointment reminders run on a background loop rather
    # than inside requests, so a slow mail server delays a message instead of a
    # booking. Held so shutdown can cancel it: without that the process waits on
    # a sleeping task it will never need again.
    dispatcher_task = dispatcher.start() if dispatcher.should_run() else None

    # With several workers, a browser's live feed is attached to one of them
    # while the vital that raises an alert may be recorded on another. This
    # relays those across. It is a no-op — and starts nothing — when there is
    # no REDIS_URL, which is the correct configuration for a single worker.
    stream.start_relay()

    yield

    if dispatcher_task is not None:
        dispatcher_task.cancel()
        with suppress(asyncio.CancelledError):
            await dispatcher_task
    await stream.stop_relay()
    await redis_store.close()
    await dispose_engine()


def create_app() -> FastAPI:
    app = FastAPI(
        title="MediSense API",
        description="Smart Healthcare Management System",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.CLIENT_ORIGIN],
        allow_credentials=True,  # auth cookies
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "X-Request-Id", "X-Device-Class"],
        expose_headers=["X-Request-Id"],
        max_age=600,
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next: Any) -> Any:
        """Correlation id on every request, echoed back and carried into audit
        entries, so a security event traces to the exact request."""
        incoming = request.headers.get("x-request-id")
        request_id = incoming if incoming and len(incoming) <= 64 else str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        # The API serves JSON only; these are cheap and apply to every response.
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if settings.is_production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    _register_exception_handlers(app)

    for module_router in (
        auth_router,
        account_router,
        users_router,
        patients_router,
        doctors_router,
        doctor_application_router,
        doctor_applications_admin_router,
        departments_router,
        appointments_router,
        records_router,
        prescriptions_router,
        medication_reminders_router,
        documents_router,
        ocr_router,
        assistant_router,
        vitals_router,
        alerts_router,
        billing_router,
        payment_verification_router,
        withdrawals_router,
        emergency_router,
        audit_router,
        notifications_router,
        dashboard_router,
    ):
        app.include_router(module_router, prefix="/api")

    @app.get("/api/health", tags=["health"])
    async def health() -> dict[str, Any]:
        return {"success": True, "data": {"status": "ok", "environment": settings.NODE_ENV}}

    @app.get("/api/health/ready", tags=["health"])
    async def ready(db: DbSession) -> JSONResponse:
        from sqlalchemy import text

        try:
            await db.execute(text("SELECT 1"))
            database = True
        except Exception:
            database = False

        return JSONResponse(
            status_code=200 if database else 503,
            content={
                "success": database,
                "data": {
                    "database": database,
                    # Reports which integrations are configured, never the
                    # values that configure them.
                    "integrations": {
                        "storage": settings.storage_configured,
                        "ai": settings.ai_configured,
                        "email": settings.email_configured,
                        "ocr": settings.OCR_ENABLED,
                    },
                },
            },
        )

    return app


def _error_body(request: Request, code: str, message: str, details: Any = None) -> dict[str, Any]:
    body: dict[str, Any] = {"success": False, "error": {"code": code, "message": message}}
    if details:
        body["error"]["details"] = details
    body["requestId"] = getattr(request.state, "request_id", None)
    return body


def _register_exception_handlers(app: FastAPI) -> None:
    """Single exit point for every failure.

    Clients get a stable envelope and nothing else — no stack traces, no
    database messages, no provider payloads (spec §37). Detail goes to the log.
    """

    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        logger.warning(
            "request_rejected",
            path=request.url.path,
            method=request.method,
            code=str(exc.code),
            status=exc.status_code,
            request_id=getattr(request.state, "request_id", None),
        )
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body(request, str(exc.code), exc.message, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {
                # Drop the "body"/"query" prefix so the field name matches what
                # the client actually sent.
                "field": ".".join(str(p) for p in err["loc"][1:]) or None,
                "message": err["msg"],
            }
            for err in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content=_error_body(
                request, ErrorCode.VALIDATION_ERROR, "The submitted data is invalid.", details
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        """Framework-raised errors (unmatched route, 405) get the same envelope.

        Without this, a 404 would come back as FastAPI's ``{"detail": ...}`` and
        clients would need to parse two different error shapes.
        """
        code = {
            401: ErrorCode.UNAUTHENTICATED,
            403: ErrorCode.UNAUTHORIZED,
            404: ErrorCode.NOT_FOUND,
            405: ErrorCode.BAD_REQUEST,
            429: ErrorCode.RATE_LIMITED,
        }.get(exc.status_code, ErrorCode.BAD_REQUEST)

        message = (
            f"No route matches {request.method} {request.url.path}."
            if exc.status_code == 404
            else str(exc.detail)
        )
        return JSONResponse(status_code=exc.status_code, content=_error_body(request, code, message))

    @app.exception_handler(IntegrityError)
    async def handle_integrity(request: Request, exc: IntegrityError) -> JSONResponse:
        detail = str(getattr(exc, "orig", exc))
        # A unique-constraint hit on a slot or an invoice is the database
        # enforcing double-booking / duplicate-invoice prevention.
        if "slotKey" in detail:
            code, message, http = (
                ErrorCode.SLOT_UNAVAILABLE,
                "That time slot has just been taken. Choose another.",
                409,
            )
        elif "appointmentId" in detail:
            code, message, http = (
                ErrorCode.DUPLICATE_INVOICE,
                "An invoice already exists for this consultation.",
                409,
            )
        elif "duplicate key" in detail.lower():
            code, message, http = ErrorCode.CONFLICT, "That record already exists.", 409
        else:
            logger.error("integrity_error", path=request.url.path, error=detail)
            code, message, http = ErrorCode.BAD_REQUEST, "The request could not be completed.", 400
        return JSONResponse(status_code=http, content=_error_body(request, code, message))

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("request_failed", path=request.url.path, method=request.method)
        message = (
            "Something went wrong. The problem has been logged."
            if settings.is_production
            else f"Unhandled error: {exc}"
        )
        return JSONResponse(status_code=500, content=_error_body(request, ErrorCode.INTERNAL_ERROR, message))


app = create_app()
