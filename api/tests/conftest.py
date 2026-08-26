from __future__ import annotations

import os

# Must be set before app.core.config is imported anywhere.
os.environ["NODE_ENV"] = "test"
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-value-that-is-long-enough-32")
os.environ.setdefault("SESSION_SECRET", "test-session-secret-value-long-enough-32ch")
os.environ.setdefault("SESSION_IDLE_TIMEOUT_SECONDS", "120")
os.environ["EMAIL_ENABLED"] = "false"
os.environ["AI_ENABLED"] = "false"

from collections.abc import AsyncGenerator, Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import SessionFactory
from app.main import app as fastapi_app

#: Integration tests need a real Postgres. They are skipped rather than failed
#: when DATABASE_URL is unset, so a fresh clone can still run the unit suite.
HAS_DATABASE = bool(settings.DATABASE_URL)

requires_db = pytest.mark.skipif(
    not HAS_DATABASE,
    reason="set DATABASE_URL in .env and run `alembic upgrade head` to enable database tests",
)


@pytest.fixture(scope="session")
def client() -> Generator[TestClient, None, None]:
    with TestClient(fastapi_app, raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture
async def db() -> AsyncGenerator[AsyncSession, None]:
    """Direct database session for assertions the API does not expose."""
    async with SessionFactory() as session:
        yield session
        await session.rollback()
