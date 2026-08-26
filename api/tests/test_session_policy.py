from __future__ import annotations

from datetime import timedelta

from app.core.session_policy import access_token_ttl_seconds, check_idle, idle_timeout_seconds
from app.db.base import utcnow


def seconds_ago(n: int):
    return utcnow() - timedelta(seconds=n)


class TestInactivityTimeout:
    """R8 — enforced server-side, tiered by device class (conflict C3)."""

    def test_shared_terminal_is_exactly_two_minutes(self) -> None:
        assert idle_timeout_seconds("SHARED_TERMINAL") == 120
        assert not check_idle("SHARED_TERMINAL", seconds_ago(119)).expired
        assert check_idle("SHARED_TERMINAL", seconds_ago(121)).expired

    def test_an_unknown_device_class_falls_back_to_the_strictest_tier(self) -> None:
        # A client must not be able to widen its own timeout by sending junk.
        assert idle_timeout_seconds("WHATEVER") == 120
        assert check_idle("WHATEVER", seconds_ago(300)).expired

    def test_a_clinicians_own_device_gets_a_longer_window(self) -> None:
        assert idle_timeout_seconds("PERSONAL") == 900
        assert not check_idle("PERSONAL", seconds_ago(300)).expired
        assert check_idle("PERSONAL", seconds_ago(901)).expired

    def test_monitoring_displays_are_exempt(self) -> None:
        # A vitals wall exists to be watched, not touched.
        assert idle_timeout_seconds("MONITOR") is None
        result = check_idle("MONITOR", seconds_ago(86_400))
        assert not result.expired
        assert result.remaining_seconds is None

    def test_reports_remaining_seconds_for_the_client_warning(self) -> None:
        remaining = check_idle("SHARED_TERMINAL", seconds_ago(90)).remaining_seconds
        assert remaining is not None
        assert 29 <= remaining <= 31

    def test_access_token_never_outlives_the_idle_window(self) -> None:
        assert access_token_ttl_seconds("SHARED_TERMINAL") <= 120
        assert access_token_ttl_seconds("PERSONAL") <= 900
