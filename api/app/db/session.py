"""Async engine and session factory.

**The pooling strategy is decided by the port, because the port is what decides
it.** Supabase offers the same database on two:

*Transaction mode, 6543.* pgbouncer hands each statement whichever server
connection is free, so a prepared statement can be prepared on one connection
and executed on another. asyncpg prepares by default, so the cache is disabled
and statement names are randomised — and a client-side pool must not be layered
on top. Measured against this project: a pool of five here failed 18 requests in
30 with ``prepared statement "__asyncpg_…" does not exist``.

*Session mode, 5432.* One server connection is pinned to a client connection for
its whole life. That is the shape a client pool needs, and it is what removes
the largest single cost in this system — opening a connection takes about a
second from outside the database's region, and with ``NullPool`` every request
pays it before running a query. Measured: **1,660 ms → 421 ms, with no
failures.**

**And session mode has a hard ceiling.** Supabase caps concurrent *clients* on
this pooler — 15 on this project — and every pooled connection is one of them,
held for as long as the pool holds it. Exceed it and the database refuses with
``(EMAXCONNSESSION) max clients reached in session mode``, which arrives as a
500 on an ordinary request and looks nothing like a configuration problem. It is
not hypothetical: a dev server and a test run, each holding ten, found it
immediately.

So the pool is small by default, and the arithmetic that has to hold is
``processes * (POOL_SIZE + POOL_OVERFLOW) <= 15``. Four uvicorn workers at five
each is twenty, and that deployment fails under load rather than at boot — which
is the worst time to discover it.

Reading the port rather than taking a setting is the point. The two decisions
are not independent — a pool on 6543 fails intermittently, and ``NullPool`` on
5432 leaves the speed on the table — so making them one decision means a
deployment changes a port and gets the right engine, instead of changing a port
and quietly getting neither benefit or an intermittent fault.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings

#: Supabase's transaction-mode pooler. Everything about the engine below turns
#: on whether the URL points here.
TRANSACTION_POOLER_PORT = 6543

#: What Supabase allows on the session-mode pooler for this project, in total,
#: across every process that connects to it.
SESSION_MODE_CLIENT_CEILING = 15

#: Deliberately well inside that ceiling. Three plus two is five per process, so
#: two API processes, a migration and a psql session all fit at once.
POOL_SIZE = 3
POOL_OVERFLOW = 2


def _port_of(url: str) -> int | None:
    try:
        # The scheme is `postgresql+asyncpg`, which urlsplit will not parse a
        # port out of; swapping it for a plain one costs nothing and is more
        # honest than a regex over a connection string.
        return urlsplit(url.replace("postgresql+asyncpg://", "postgresql://")).port
    except ValueError:
        return None


#: True when runtime traffic goes through the transaction pooler.
#:
#: Defaults to True for an unparseable URL: assuming the pooler is the safe
#: mistake — it costs latency. Assuming session mode when it is not costs
#: intermittent, hard-to-read failures under load.
through_transaction_pooler = _port_of(settings.async_database_url) != 5432

_connect_args: dict[str, Any] = {"server_settings": {"application_name": "medisense-api"}}

if through_transaction_pooler:
    # Prepared statements cannot survive a connection they did not start on.
    _connect_args |= {
        "statement_cache_size": 0,
        "prepared_statement_name_func": lambda: f"__asyncpg_{uuid4()}__",
    }
    _pool: dict[str, Any] = {"poolclass": NullPool}
else:
    # Session mode pins the connection, so the statement cache is both safe and
    # useful — it is what removes the second round trip from every parameterised
    # query.
    _pool = {
        # Five per process, against a ceiling of fifteen for the whole project.
        # Room for one API process, a migration, and somebody with a psql open —
        # rather than one process that happens to work alone and fails the
        # moment anything else connects.
        "pool_size": POOL_SIZE,
        "max_overflow": POOL_OVERFLOW,
        # Supabase closes idle server connections; recycling below that keeps a
        # pooled connection from being handed out after the far end has gone.
        "pool_recycle": 280,
        # One wasted round trip on checkout, against a request that fails on a
        # connection the database closed while it sat idle.
        "pool_pre_ping": True,
    }

engine = create_async_engine(
    settings.async_database_url,
    echo=False,
    connect_args=_connect_args,
    **_pool,
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
