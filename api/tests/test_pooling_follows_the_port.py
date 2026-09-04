"""The engine's pooling strategy is decided by the port, not by a setting.

Two decisions that look separate are one decision, and getting the pair wrong is
invisible until it is expensive:

* a client pool against Supabase's **transaction** pooler (6543) fails
  intermittently — measured at 18 requests in 30 with ``prepared statement
  "__asyncpg_…" does not exist`` — because pgbouncer hands each statement
  whichever server connection is free;
* ``NullPool`` against **session** mode (5432) works perfectly and quietly pays
  a full second per request opening a connection that could have been kept.

So the port picks both. These tests pin that, because the failure mode of
getting it wrong is a deployment that changes one line of `.env` and gets either
no benefit or a fault nobody can reproduce.
"""

from __future__ import annotations

from app.db import session as db_session


class TestItReadsThePort:
    def test_the_transaction_pooler_port_is_recognised(self) -> None:
        assert db_session._port_of("postgresql+asyncpg://u:p@host:6543/postgres") == 6543

    def test_session_mode_is_recognised(self) -> None:
        assert db_session._port_of("postgresql+asyncpg://u:p@host:5432/postgres") == 5432

    def test_a_password_with_punctuation_does_not_confuse_it(self) -> None:
        """Supabase passwords are generated and contain almost anything.

        A regex over the string would find the wrong colon here; this parses.
        """
        url = "postgresql+asyncpg://user:p%40ss-w0rd.x@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
        assert db_session._port_of(url) == 5432

    def test_an_unparseable_url_reads_as_no_port(self) -> None:
        assert db_session._port_of("not a url at all") is None


class TestThePairIsNeverMismatched:
    """Whatever the configured URL is, the engine is coherent with it."""

    def test_the_transaction_pooler_gets_no_client_pool(self) -> None:
        from sqlalchemy.pool import NullPool

        if not db_session.through_transaction_pooler:
            import pytest

            pytest.skip("this deployment is configured for session mode")
        assert isinstance(db_session.engine.pool, NullPool)

    def test_the_transaction_pooler_gets_no_statement_cache(self) -> None:
        if not db_session.through_transaction_pooler:
            import pytest

            pytest.skip("this deployment is configured for session mode")
        # Prepared statements cannot survive a connection they did not start on.
        assert db_session._connect_args["statement_cache_size"] == 0
        assert callable(db_session._connect_args["prepared_statement_name_func"])

    def test_session_mode_gets_a_pool_and_keeps_the_cache(self) -> None:
        if db_session.through_transaction_pooler:
            import pytest

            pytest.skip("this deployment is configured for the transaction pooler")
        from sqlalchemy.pool import NullPool

        assert not isinstance(db_session.engine.pool, NullPool)
        assert db_session.engine.pool.size() > 0
        # Safe here, and it is what removes a round trip from every
        # parameterised query.
        assert "statement_cache_size" not in db_session._connect_args

    def test_an_unknown_port_falls_back_to_the_safe_side(self) -> None:
        """A URL this cannot read is treated as the pooler.

        Assuming the pooler costs latency. Assuming session mode when it is not
        costs intermittent failures under load, which is much harder to see and
        far worse to debug.
        """
        assert db_session._port_of("postgres://nonsense") != 5432
