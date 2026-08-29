"""Application errors and the single response envelope.

Clients receive ``{"success": false, "error": {"code", "message"}}`` and never
a stack trace, a database message or a provider payload.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    BAD_REQUEST = "BAD_REQUEST"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    UNAUTHENTICATED = "UNAUTHENTICATED"
    SESSION_EXPIRED = "SESSION_EXPIRED"
    INVALID_CREDENTIALS = "INVALID_CREDENTIALS"
    ACCOUNT_LOCKED = "ACCOUNT_LOCKED"
    ACCOUNT_INACTIVE = "ACCOUNT_INACTIVE"
    #: Sign-up succeeded but the address has not been proved yet. Distinct from
    #: ACCOUNT_INACTIVE because the remedy is different and the client routes on
    #: it: "check your inbox", not "contact an administrator".
    EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED"
    INVALID_CODE = "INVALID_CODE"
    CODE_EXPIRED = "CODE_EXPIRED"
    #: The three states a doctor's registration can be in that are not "cleared
    #: to work". Separate codes rather than one refusal, because each has a
    #: different next step and the client shows a different screen for each.
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPLICATION_REJECTED = "APPLICATION_REJECTED"
    PROFILE_INCOMPLETE = "PROFILE_INCOMPLETE"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN_RESOURCE = "FORBIDDEN_RESOURCE"
    NOT_FOUND = "NOT_FOUND"
    CONFLICT = "CONFLICT"
    SLOT_UNAVAILABLE = "SLOT_UNAVAILABLE"
    DUPLICATE_INVOICE = "DUPLICATE_INVOICE"
    UNSUPPORTED_FILE = "UNSUPPORTED_FILE"
    FILE_TOO_LARGE = "FILE_TOO_LARGE"
    RATE_LIMITED = "RATE_LIMITED"
    CONSENT_REQUIRED = "CONSENT_REQUIRED"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class AppError(Exception):
    """An error that is safe to show a user. Anything else becomes INTERNAL_ERROR."""

    def __init__(
        self,
        status_code: int,
        code: ErrorCode,
        message: str,
        details: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def bad_request(message: str, details: list[dict[str, Any]] | None = None) -> AppError:
    return AppError(400, ErrorCode.BAD_REQUEST, message, details)


def unauthenticated(message: str = "Sign in to continue.") -> AppError:
    return AppError(401, ErrorCode.UNAUTHENTICATED, message)


def session_expired(
    message: str = "Your session expired after a period of inactivity. Sign in again to continue.",
) -> AppError:
    return AppError(401, ErrorCode.SESSION_EXPIRED, message)


def invalid_credentials() -> AppError:
    # Identical for an unknown email and a wrong password: distinguishing them
    # turns the login form into an account-enumeration oracle.
    return AppError(401, ErrorCode.INVALID_CREDENTIALS, "Email or password is incorrect.")


def forbidden(message: str = "You are not authorized to access this resource.") -> AppError:
    return AppError(403, ErrorCode.UNAUTHORIZED, message)


def forbidden_resource(
    message: str = "You do not have access to this patient's data.",
) -> AppError:
    return AppError(403, ErrorCode.FORBIDDEN_RESOURCE, message)


def not_found(what: str = "Resource") -> AppError:
    return AppError(404, ErrorCode.NOT_FOUND, f"{what} was not found.")


def conflict(message: str, code: ErrorCode = ErrorCode.CONFLICT) -> AppError:
    return AppError(409, code, message)


def service_unavailable(message: str) -> AppError:
    return AppError(503, ErrorCode.SERVICE_UNAVAILABLE, message)
