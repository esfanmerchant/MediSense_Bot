from __future__ import annotations

import os

# Must be set before app.core.config is imported anywhere.
os.environ["NODE_ENV"] = "test"
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-value-that-is-long-enough-32")
os.environ.setdefault("SESSION_SECRET", "test-session-secret-value-long-enough-32ch")
os.environ.setdefault("SESSION_IDLE_TIMEOUT_SECONDS", "120")
os.environ["EMAIL_ENABLED"] = "false"
#: Off by default so an ordinary test run costs nothing and sends nothing
#: outward. Tests that genuinely exercise the provider turn it on for their own
#: duration with the ``ai_enabled`` fixture below — leaving this true globally
#: would mean every unrelated test could make a paid network call.
os.environ["AI_ENABLED"] = "false"

from collections.abc import AsyncGenerator, Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import ratelimit
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

#: The demo accounts all share one password, which is fine because they are
#: fictional and their credentials are in the README.
DEMO_PASSWORD = "Demo@Pass123"

#: The administrator these tests sign in as, from the environment.
#:
#: There used to be a demo admin alongside the real one, and it was removed:
#: a hospital wants one administrator, not one plus a fixture. What is left is
#: somebody's actual account, so its password cannot live in this file or in
#: git — it is supplied by whoever runs the suite, and the admin tests skip
#: without it rather than failing with a password error that looks like a bug
#: in the code they were meant to be testing.
ADMIN_EMAIL = os.environ.get("TEST_ADMIN_EMAIL", "")
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD", "")

requires_admin = pytest.mark.skipif(
    not (ADMIN_EMAIL and ADMIN_PASSWORD),
    reason=(
        "set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD to run the tests that "
        "act as an administrator"
    ),
)


def password_for(email: str) -> str:
    """The password to sign this account in with.

    One function rather than a constant, because the administrator's is not the
    demo one any more and every test that signs somebody in needs to stop
    assuming they are interchangeable.
    """
    return ADMIN_PASSWORD if email and email == ADMIN_EMAIL else DEMO_PASSWORD


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


#: Set to skip tests that call the AI provider for real. They cost money and
#: need network, so a contributor without a key still gets a green suite.
HAS_AI_KEY = bool(settings.AI_API_KEY)

requires_ai = pytest.mark.skipif(
    not HAS_AI_KEY,
    reason="set AI_API_KEY in .env to run tests that call the AI provider",
)


@pytest.fixture
def ai_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """Turn the provider on for one test, and skip if it has nothing to give.

    AI is disabled suite-wide so no unrelated test can make a paid call. The
    handful of tests that verify the provider path enable it deliberately and
    only for themselves.

    The reachability probe matters as much as the switch. These tests assert
    that the *provider* answered — that vision OCR ran rather than local OCR,
    that the assistant produced a real reply rather than its fallback. When the
    account is out of quota those assertions fail, and a red suite that means
    "check your billing" is a red suite people learn to ignore. The application
    is behaving correctly in that situation: it degrades to the local engine and
    to deterministic triage, which is exactly what it is designed to do, and
    every test of *that* behaviour runs with AI off and still passes.

    So a provider that cannot answer skips these tests with the reason, rather
    than failing them. One cheap call per test decides it.
    """
    monkeypatch.setattr(settings, "AI_ENABLED", True)

    reachable, detail = _provider_reachable()
    if not reachable:
        pytest.skip(f"AI provider unavailable: {detail}")


def _provider_reachable() -> tuple[bool, str]:
    """One minimal call, to tell "provider is down" from "our code is wrong"."""
    import asyncio

    from app.core.errors import AppError, ErrorCode
    from app.services import ai

    async def probe() -> tuple[bool, str]:
        try:
            await ai.generate_json(
                prompt="Reply with ok.",
                schema={
                    "type": "object",
                    "properties": {"status": {"type": "string"}},
                    "required": ["status"],
                },
                # Generous: this model spends output tokens on reasoning before
                # it emits any JSON, so a tight budget truncates the reply and
                # looks like a provider fault.
                max_output_tokens=512,
            )
            return True, ""
        except AppError as exc:
            if exc.code == ErrorCode.RATE_LIMITED:
                return False, "quota exhausted or rate limited (HTTP 429)"
            return False, str(exc.message)
        except Exception as exc:  # network, DNS, TLS
            return False, type(exc).__name__

    return asyncio.run(probe())

#: The one module whose subject *is* the limiter. Named here rather than
#: inferred, so turning the limiter off for it would take deleting a line
#: somebody has to read first.
_LIMITER_OWN_TESTS = "test_ratelimit"


@pytest.fixture(autouse=True)
def _no_rate_limit(request: pytest.FixtureRequest) -> Generator[None, None, None]:
    """Stand the rate limiter down for every test but its own.

    This suite signs in several hundred times from one address within a few
    minutes. That is exactly the traffic the login limit exists to refuse, so
    with it on the run trips partway through and everything after fails on a
    429 that says nothing about the code under test — which is what the last
    full run did, across eleven files.

    ``test_ratelimit.py`` is exempt by name, so the limiter's own tests still
    run against a live limiter. The exemption is explicit because the previous
    version was not: it relied on that file resetting counters as a side effect,
    which also re-enabled the limiter for any *other* file that reset counters
    for the ordinary reason — and one of them does.
    """
    if request.node.module.__name__.endswith(_LIMITER_OWN_TESTS):
        ratelimit.enforce_for_tests()
        yield
        return

    ratelimit.bypass_for_tests()
    yield
    ratelimit.enforce_for_tests()
