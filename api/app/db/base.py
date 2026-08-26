"""Declarative base and shared column helpers."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


def new_id() -> str:
    """Collision-resistant id in the same shape as the existing cuid rows.

    The format is not semantically meaningful anywhere — only uniqueness and
    unguessability matter, since ids appear in URLs.
    """
    return "c" + secrets.token_hex(12)


def utcnow() -> datetime:
    """Naive UTC, truncated to milliseconds.

    Two things are handled here rather than at every call site:

    * The schema uses ``timestamp`` (no time zone), as Prisma created it.
      Writing an aware datetime into those columns raises in asyncpg.
    * The columns are ``timestamp(3)``, so Postgres rounds microseconds away on
      write. The audit chain hashes the timestamp, so a value that changes
      between writing and reading it back would make every entry fail
      verification. Truncating up front makes the round trip exact.
    """
    now = datetime.now(UTC).replace(tzinfo=None)
    return now.replace(microsecond=(now.microsecond // 1000) * 1000)
