"""Every unauthenticated endpoint is rate limited.

The companion to ``test_access_control_review``. That one asks whether an
endpoint checks *who* you are; this one asks what happens when nobody has to be
anybody. A route with no session and no limit is a resource anyone on the
internet may spend without cost, and three of them shipped that way before this
file existed:

* ``/auth/register`` and ``/auth/forgot-password`` each **send an email to an
  address supplied in the request**. Unbounded, that is an open relay pointed at
  strangers from this hospital's own mailbox — and the damage lands on the
  sender's reputation, so the first thing to break afterwards is the invoice and
  reminder mail that everybody depends on.
* ``/auth/reset-password`` takes the credential in its body.

Reading the routes rather than listing them by hand is the point. A new public
endpoint added next year is caught by a test written today, which is exactly the
failure a hand-written list cannot see.
"""

from __future__ import annotations

import inspect
import re

import pytest

from tests.test_access_control_review import PUBLIC_PATHS, api_routes, source_of

#: How the limiter is applied everywhere: an `Annotated[None, Depends(limit(...))]`
#: alias taken as a parameter. Matching the alias name rather than `limit(`
#: keeps this honest — the alias is declared in the router beside the endpoint,
#: and the assertion below re-reads that declaration for its numbers.
USES_A_LIMIT = re.compile(r"\b\w*RateLimit\b")


def limits_in(module_source: str) -> dict[str, tuple[int, int]]:
    """Every ``limit(times=…, seconds=…)`` declared in a router, by alias."""
    found: dict[str, tuple[int, int]] = {}
    for match in re.finditer(
        r"(\w+RateLimit)\s*=\s*Annotated\[\s*None,\s*Depends\(\s*limit\("
        r"times=(\d+),\s*seconds=(\d+)",
        module_source,
        re.DOTALL,
    ):
        found[match.group(1)] = (int(match.group(2)), int(match.group(3)))
    return found


#: Public routes that legitimately carry no limiter. Four, each for its own
#: reason, and each reason is that limiting it would make something worse.
UNLIMITED_BY_DESIGN = {
    # A load balancer polls these every few seconds by design, they touch
    # nothing but a `SELECT 1`, and rate limiting the endpoint that reports
    # whether the service is alive is how a busy service gets declared dead.
    "/api/health",
    "/api/health/ready",
    # Published text, served from a Python module with no query behind it. The
    # limiter counts in Postgres — so limiting this would replace an endpoint
    # that costs zero database work with one that costs a round trip per
    # request. The limit would be more expensive than the thing it protects.
    "/api/auth/terms",
    # Refusing to sign somebody out is a worse outcome than the traffic it
    # would prevent. Logout is idempotent, already best-effort about
    # authentication so an expired session can still clear its cookies, and a
    # 429 here strands a person signed in on a shared machine.
    "/api/auth/logout",
}


def public_routes() -> list[tuple[list[str], str, object]]:
    return [entry for entry in api_routes() if entry[1] in PUBLIC_PATHS]


class TestNothingPublicIsFree:
    def test_the_public_surface_is_the_one_that_was_reviewed(self) -> None:
        """If this fails, a route was added to PUBLIC_PATHS — read the rest of
        this file before deciding it belongs there."""
        assert {path for _, path, _ in public_routes()} == PUBLIC_PATHS

    def test_every_public_endpoint_carries_a_rate_limit(self) -> None:
        unlimited = []
        for methods, path, endpoint in public_routes():
            if path in UNLIMITED_BY_DESIGN:
                continue
            if not USES_A_LIMIT.search(source_of(endpoint)):
                unlimited.append(f"{','.join(methods)} {path}")

        assert unlimited == [], (
            "public endpoints anybody can call without cost: "
            f"{unlimited}. Add a limit, or add the path to UNLIMITED_BY_DESIGN "
            "with a reason."
        )

    @pytest.mark.parametrize(
        "path", ["/api/auth/register", "/api/auth/forgot-password"]
    )
    def test_the_endpoints_that_send_mail_are_limited(self, path: str) -> None:
        """Singled out because these two are the expensive ones.

        Every accepted call puts a message in somebody's inbox from this
        hospital's address. They are named individually so that removing the
        limit from one of them fails with a test that says why.
        """
        endpoint = next(e for _, p, e in public_routes() if p == path)
        assert USES_A_LIMIT.search(source_of(endpoint)), f"{path} sends mail with no limit"


class TestTheLimitsAreMeaningful:
    """A limit of a million an hour passes the test above and stops nothing."""

    def test_no_limit_is_wide_enough_to_be_decorative(self) -> None:
        from app.modules.auth import router as auth_router

        declared = limits_in(inspect.getsource(auth_router))
        assert declared, "no rate limits found in the auth router"

        too_wide = {
            name: (times, seconds)
            for name, (times, seconds) in declared.items()
            # More than one request a second sustained is not a limit on
            # anything a human does through a sign-in form.
            if times / max(seconds, 1) > 1.0
        }
        assert too_wide == {}, f"these allow more than one request a second: {too_wide}"

    def test_mailing_endpoints_are_the_tightest(self) -> None:
        """An email costs a real person's attention and the sender's reputation.

        Registration should be scarcer than signing in, not the other way round.
        """
        from app.modules.auth import router as auth_router

        declared = limits_in(inspect.getsource(auth_router))
        register = declared["RegisterRateLimit"]
        login = declared["LoginRateLimit"]

        per_hour = lambda pair: pair[0] * 3600 / pair[1]  # noqa: E731
        assert per_hour(register) < per_hour(login), (
            f"registration ({per_hour(register):.0f}/h) is looser than login "
            f"({per_hour(login):.0f}/h)"
        )
