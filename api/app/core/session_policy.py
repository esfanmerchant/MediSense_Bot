"""Session lifetime policy.

R8 asks for a two-minute inactivity logout everywhere. Applied literally it
also logs out the vitals wall display, which exists to be watched and not
touched, and cuts off an elderly patient mid-dictation — the exact user the
voice feature is for. So the strict rule is kept where the threat actually is,
an unattended shared ward terminal, and the other classes are tiered.

See conflict C3 in the requirements triage.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

from app.core.config import settings


class DeviceClass(StrEnum):
    SHARED_TERMINAL = "SHARED_TERMINAL"
    PERSONAL = "PERSONAL"
    MONITOR = "MONITOR"


#: Anything a client sends that is not recognised falls back to the strictest
#: tier, so a caller cannot widen its own timeout by inventing a device class.
DEFAULT_DEVICE_CLASS = DeviceClass.SHARED_TERMINAL

REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7

#: How stale ``lastSeenAt`` may get before it is written again. Without this
#: every authenticated request would issue an UPDATE.
LAST_SEEN_WRITE_THROTTLE_SECONDS = 10


def coerce_device_class(value: str | None) -> DeviceClass:
    try:
        return DeviceClass(value or "")
    except ValueError:
        return DEFAULT_DEVICE_CLASS


def idle_timeout_seconds(device_class: str) -> int | None:
    """Seconds of inactivity allowed, or ``None`` when the class is exempt."""
    match coerce_device_class(device_class):
        case DeviceClass.MONITOR:
            # View-only wall display. Any action taken from it re-authenticates.
            return None
        case DeviceClass.PERSONAL:
            return max(settings.SESSION_IDLE_TIMEOUT_SECONDS, 15 * 60)
        case _:
            return settings.SESSION_IDLE_TIMEOUT_SECONDS


def access_token_ttl_seconds(device_class: str) -> int:
    """Kept at or below the idle window so a stolen token dies quickly."""
    idle = idle_timeout_seconds(device_class)
    return 15 * 60 if idle is None else min(idle, 15 * 60)


def absolute_timeout_seconds() -> int:
    return settings.SESSION_ABSOLUTE_TIMEOUT_SECONDS


@dataclass(frozen=True)
class IdleCheck:
    expired: bool
    #: Seconds remaining, or ``None`` when the class is exempt. Drives the
    #: client's countdown warning.
    remaining_seconds: int | None


def check_idle(device_class: str, last_seen_at: datetime, now: datetime | None = None) -> IdleCheck:
    idle = idle_timeout_seconds(device_class)
    if idle is None:
        return IdleCheck(expired=False, remaining_seconds=None)

    now = now or datetime.now(UTC)
    # Postgres `timestamp` columns come back naive; compare in the same frame.
    if last_seen_at.tzinfo is None:
        last_seen_at = last_seen_at.replace(tzinfo=UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)

    elapsed = (now - last_seen_at).total_seconds()
    return IdleCheck(
        expired=elapsed >= idle,
        remaining_seconds=max(0, int(-(-(idle - elapsed) // 1))),
    )
