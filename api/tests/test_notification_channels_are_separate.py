"""The bell is the portal list. It is not the outbox.

One event writes one row per channel. The ``IN_APP`` row is what a person reads
in the portal; the ``EMAIL`` and ``PUSH`` rows are queue entries the dispatcher
drains. Reading the list endpoint without a channel filter conflated the two,
with two consequences seen in the running product:

* **Every emailed notification appeared twice in the bell** — three times once
  push was added — because the same title and body existed once per channel.
* **"Mark all read" cancelled the outbox.** It set ``status = READ`` on every
  unread row of every channel, and the dispatcher claims by
  ``status == PENDING``. Anything still waiting was never sent, and nothing
  anywhere said so.

The second never lost a real message — the window between queueing and the
dispatcher's next pass is under a minute, and no row was caught in it — but it
was a live way to lose one.
"""

from __future__ import annotations

import inspect

import pytest

from app.db.enums import NotificationChannel, NotificationStatus
from app.modules.notifications import dispatcher, router


class TestEveryEndpointFiltersTheChannel:
    """One helper, used by all three, so a fourth endpoint cannot forget."""

    def test_the_filter_names_both_halves(self) -> None:
        source = inspect.getsource(router._mine)
        # Without the user id it reads somebody else's inbox; without the
        # channel it reads the delivery queue and calls it an inbox.
        assert "Notification.user_id == auth.user_id" in source
        assert "NotificationChannel.IN_APP" in source

    @pytest.mark.parametrize(
        "endpoint",
        [router.list_notifications, router.mark_read, router.mark_all_read],
    )
    def test_the_endpoint_uses_it(self, endpoint: object) -> None:
        assert "_mine(auth)" in inspect.getsource(endpoint)

    def test_no_endpoint_still_filters_by_hand(self) -> None:
        # A hand-written `user_id ==` is how the channel gets left off again.
        source = inspect.getsource(router)
        body = source[source.index("def _mine") + 400 :]
        assert "Notification.user_id == auth.user_id" not in body

    def test_the_unread_count_is_filtered_too(self) -> None:
        # A badge counting delivery rows is the same bug wearing a number.
        source = inspect.getsource(router.list_notifications)
        assert source.count("_mine(auth)") >= 2


class TestMarkAllReadCannotCancelTheOutbox:
    """The two states have to stay apart, and only one query touches both."""

    def test_read_and_pending_are_different_states(self) -> None:
        assert NotificationStatus.READ != NotificationStatus.PENDING

    def test_the_dispatcher_claims_by_pending(self) -> None:
        for claim in (dispatcher.claim_pending, dispatcher.claim_pending_push):
            source = inspect.getsource(claim)
            assert "NotificationStatus.PENDING" in source

    def test_the_dispatcher_claims_only_its_own_channel(self) -> None:
        assert "NotificationChannel.EMAIL" in inspect.getsource(dispatcher.claim_pending)
        assert "NotificationChannel.PUSH" in inspect.getsource(dispatcher.claim_pending_push)

    def test_marking_read_is_scoped_away_from_them(self) -> None:
        source = inspect.getsource(router.mark_all_read)
        assert "_mine(auth)" in source
        # And it still does what it is for.
        assert "NotificationStatus.READ" in source


class TestTheChannelsThemselves:
    def test_there_are_three(self) -> None:
        assert {c.value for c in NotificationChannel} == {"IN_APP", "EMAIL", "PUSH"}

    def test_only_the_in_app_row_is_marked_sent_on_write(self) -> None:
        from app.modules.notifications import service

        source = inspect.getsource(service.notify)
        # The in-app row is delivered by being written; the other two are not,
        # which is exactly why they must not be listed as things somebody read.
        assert "channel=NotificationChannel.IN_APP" in source
        assert "status=NotificationStatus.SENT" in source

    @pytest.mark.parametrize(
        "queue",
        ["queue_email", "queue_push"],
    )
    def test_a_queued_row_starts_pending(self, queue: str) -> None:
        from app.modules.notifications import service

        source = inspect.getsource(getattr(service, queue))
        assert "status=NotificationStatus.PENDING" in source
