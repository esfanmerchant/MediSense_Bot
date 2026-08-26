"""Structured logging with central redaction.

Spec §35: never log passwords, tokens, API keys, App Passwords, medical
documents or full AI conversations. Redaction lives here so a careless
``log.info(body=...)`` at a call site cannot leak them.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog

from app.core.config import settings

REDACTED_KEYS = frozenset(
    {
        "password",
        "new_password",
        "newPassword",
        "current_password",
        "currentPassword",
        "password_hash",
        "passwordHash",
        "token",
        "access_token",
        "accessToken",
        "refresh_token",
        "refreshToken",
        "token_hash",
        "tokenHash",
        "authorization",
        "cookie",
        "set-cookie",
        "api_key",
        "apiKey",
        "service_role_key",
        "extracted_text",
        "extractedText",
        "secret",
    }
)

_CENSOR = "[redacted]"


def _redact(_logger: Any, _name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    def scrub(value: Any, depth: int = 0) -> Any:
        if depth > 4:
            return value
        if isinstance(value, dict):
            return {
                k: (_CENSOR if k.lower() in {r.lower() for r in REDACTED_KEYS} else scrub(v, depth + 1))
                for k, v in value.items()
            }
        if isinstance(value, list):
            return [scrub(v, depth + 1) for v in value[:50]]
        return value

    return scrub(event_dict)  # type: ignore[return-value]


def configure_logging() -> None:
    level = (
        logging.CRITICAL if settings.is_test else (logging.INFO if settings.is_production else logging.DEBUG)
    )
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _redact,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer()
            if settings.is_production
            else structlog.dev.ConsoleRenderer(colors=False),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


logger = structlog.get_logger("medisense")
