"""Async engine and session factory.

Runtime traffic goes through Supabase's transaction-mode pooler, which does not
support prepared statements. asyncpg uses them by default, so the cache is
disabled and statement names are randomised — without this, queries fail
intermittently with "prepared statement already exists" once the pooler starts
reusing server connections.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings

_connect_args: dict[str, Any] = {
    "statement_cache_size": 0,
    "prepared_statement_name_func": lambda: f"__asyncpg_{uuid4()}__",
    # Supabase terminates idle server-side connections; keep client-side
    # connections short-lived rather than holding a pool against the pooler.
    "server_settings": {"application_name": "medisense-api"},
}

engine = create_async_engine(
    settings.async_database_url,
    echo=False,
    # NullPool: the pooler is the pool. A second pool on top of pgbouncer
    # multiplies idle connections against Supabase's connection limit.
    poolclass=NullPool,
    connect_args=_connect_args,
)

SessionFactory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency. Commits on success, rolls back on any exception."""
    async with SessionFactory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def check_database_connection() -> bool:
    from sqlalchemy import text

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:
        from app.core.logging import logger

        logger.exception("database_connection_failed")
        return False


async def dispose_engine() -> None:
    await engine.dispose()
