"""Access-control review (spec §"Phase 13 — Access control review").

The other tests check that specific endpoints refuse specific people. This one
checks the *shape* of the whole surface, which is the failure those tests cannot
see: an endpoint added later with no guard at all is not caught by any test that
was written before it existed.

So this reads the registered routes and asserts properties over all of them. It
needs no database and runs in milliseconds, which means it runs on every change
rather than at the end.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest

from app.db.enums import Role
from app.main import app
from app.modules.auth.rbac import ROLE_PERMISSIONS, Permission

#: Endpoints that legitimately have no authentication.
#:
#: Both are probes. `/health` reports liveness; `/health/ready` reports which
#: integrations are configured as booleans and never their values — a load
#: balancer has to reach them before anyone has signed in.
PUBLIC_PATHS = {"/api/health", "/api/health/ready"}

#: Routes that authenticate but deliberately have no permission requirement:
#: signing in, signing out, refreshing, and asking who you are.
AUTH_ENTRY_PATHS = {
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/refresh",
    "/api/auth/me",
    "/api/auth/register",
    "/api/auth/heartbeat",
    "/api/auth/password-reset",
    "/api/auth/password-reset/confirm",
}


def api_routes() -> list[tuple[list[str], str, Any]]:
    found = []
    for route in app.routes:
        path = getattr(route, "path", None)
        endpoint = getattr(route, "endpoint", None)
        if not path or not path.startswith("/api") or endpoint is None:
            continue
        methods = sorted(m for m in (getattr(route, "methods", None) or []) if m != "HEAD")
        found.append((methods, path, endpoint))
    return found


def source_of(endpoint: Any) -> str:
    try:
        return inspect.getsource(endpoint)
    except OSError:  # pragma: no cover — only if source is unavailable
        return ""


class TestEverythingIsGuarded:
    def test_every_endpoint_authenticates_or_is_a_declared_probe(self) -> None:
        """A new endpoint with no guard is the failure this test exists for.

        If this fails, either add the guard or add the path to PUBLIC_PATHS with
        a reason — the point is that skipping authentication becomes a decision
        someone writes down, rather than something that happens by omission.
        """
        unguarded = []
        for methods, path, endpoint in api_routes():
            if path in PUBLIC_PATHS:
                continue
            source = source_of(endpoint)
            authenticated = "CurrentAuth" in source or "auth:" in source
            if not authenticated:
                unguarded.append(f"{','.join(methods)} {path}")

        assert unguarded == [], f"endpoints with no authentication: {unguarded}"

    def test_the_public_surface_stays_small(self) -> None:
        """Two probes. Anything else needs justifying in this file."""
        public = {path for _, path, _ in api_routes() if path in PUBLIC_PATHS}
        assert public == PUBLIC_PATHS

    def test_mutating_endpoints_carry_more_than_authentication(self) -> None:
        """Being signed in is not authorization.

        Every write either checks a permission, resolves clinical access, or
        scopes to the caller's own data. Authentication alone on a POST means
        any signed-in user can do it, which is almost never intended.
        """
        weak = []
        for methods, path, endpoint in api_routes():
            if not ({"POST", "PUT", "PATCH", "DELETE"} & set(methods)):
                continue
            if path in AUTH_ENTRY_PATHS or path in PUBLIC_PATHS:
                continue
            source = source_of(endpoint)
            guarded = any(
                marker in source
                for marker in (
                    "require_permission",
                    "Require",
                    "require_clinical_access",
                    "require_patient_access",
                    "clinical_scope",
                    "scope_for",
                    "visible_patient_ids",
                    "load_visible",
                    # Endpoints that derive the subject from the session alone —
                    # a patient acting on their own record.
                    "auth.patient_id",
                    "auth.user_id",
                    "auth.role",
                )
            )
            if not guarded:
                weak.append(f"{','.join(methods)} {path}")

        assert weak == [], f"mutating endpoints with only authentication: {weak}"


class TestPermissionCatalogue:
    def test_every_permission_is_held_by_some_role(self) -> None:
        """A permission no role holds guards an endpoint nobody can reach.

        That is either a dead endpoint or a role that lost a capability by
        accident, and both are worth noticing.
        """
        granted = {perm for perms in ROLE_PERMISSIONS.values() for perm in perms}
        orphans = sorted(str(perm) for perm in Permission if perm not in granted)
        assert orphans == [], f"permissions no role holds: {orphans}"

    def test_every_role_has_a_permission_set(self) -> None:
        missing = [str(role) for role in Role if role not in ROLE_PERMISSIONS]
        assert missing == [], f"roles with no permissions defined: {missing}"

    def test_administrators_hold_no_clinical_read(self) -> None:
        """R2, as a property of the catalogue rather than a check to remember.

        Running the hospital is not a reason to read a diagnosis. Admins hold
        `patient:read:any` so they can correct a name and see tomorrow's
        bookings — and none of the record, prescription or vital permissions.
        """
        admin = ROLE_PERMISSIONS[Role.ADMIN]
        forbidden = {
            Permission.RECORD_READ_OWN,
            Permission.RECORD_READ_ASSIGNED,
            Permission.RECORD_WRITE,
            Permission.PRESCRIPTION_READ_ASSIGNED,
            Permission.PRESCRIPTION_WRITE,
            Permission.VITAL_READ_ASSIGNED,
            Permission.VITAL_WRITE,
        }
        overlap = sorted(str(perm) for perm in admin & forbidden)
        assert overlap == [], f"administrators hold clinical permissions: {overlap}"

    def test_nurses_hold_no_standing_patient_access(self) -> None:
        """Conflict C1. A nurse records what they measure and requests
        break-glass; they never hold a standing right to a chart."""
        nurse = ROLE_PERMISSIONS[Role.NURSE]
        forbidden = {
            Permission.PATIENT_READ_ANY,
            Permission.RECORD_READ_ASSIGNED,
            Permission.PRESCRIPTION_READ_ASSIGNED,
            Permission.DOCUMENT_READ_ASSIGNED,
            Permission.VITAL_READ_ASSIGNED,
        }
        overlap = sorted(str(perm) for perm in nurse & forbidden)
        assert overlap == [], f"nurses hold standing patient access: {overlap}"

    def test_patients_cannot_write_clinical_content(self) -> None:
        """"Patients must not be able to modify physician-authored records" is a
        property of the catalogue, not a check somewhere in a handler."""
        patient = ROLE_PERMISSIONS[Role.PATIENT]
        forbidden = {
            Permission.RECORD_WRITE,
            Permission.PRESCRIPTION_WRITE,
            Permission.VITAL_WRITE,
            Permission.THRESHOLD_MANAGE,
        }
        overlap = sorted(str(perm) for perm in patient & forbidden)
        assert overlap == [], f"patients hold clinical write permissions: {overlap}"

    def test_only_administrators_review_emergency_access(self) -> None:
        """Reviewing your own break-glass is not a review."""
        holders = [
            str(role)
            for role, perms in ROLE_PERMISSIONS.items()
            if Permission.EMERGENCY_REVIEW in perms
        ]
        assert holders == [str(Role.ADMIN)]

    def test_only_administrators_read_the_audit_trail(self) -> None:
        holders = [
            str(role)
            for role, perms in ROLE_PERMISSIONS.items()
            if Permission.AUDIT_READ in perms
        ]
        assert holders == [str(Role.ADMIN)]


class TestAuditTrailIsAppendOnly:
    """R6: no ordinary API may modify or remove an entry."""

    @pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
    def test_the_audit_endpoint_offers_no_write(self, method: str) -> None:
        writes = [
            path
            for methods, path, _ in api_routes()
            if path.startswith("/api/audit-logs") and method in methods
        ]
        assert writes == [], f"audit trail exposes {method}: {writes}"

    def test_the_audit_module_exports_no_delete_or_update(self) -> None:
        """Belt and braces: not merely unrouted, but absent from the service."""
        from app.modules.audit import service

        names = [name.lower() for name in dir(service) if not name.startswith("_")]
        offenders = [
            name
            for name in names
            if ("delete" in name or "update" in name or "purge" in name)
            and "audit" in name
        ]
        assert offenders == [], f"audit service exposes mutation: {offenders}"
