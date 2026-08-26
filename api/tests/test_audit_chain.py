from __future__ import annotations

import re

from app.modules.audit.service import compute_entry_hash, sanitize_metadata

ENTRY = {
    "action": "PATIENT_RECORD_VIEW",
    "userId": "user_1",
    "patientId": "patient_1",
    "timestamp": "2026-08-26T10:00:00.000Z",
}


class TestChainHashing:
    """R6 — the chain is what makes 'immutable' testable rather than asserted."""

    def test_is_deterministic(self) -> None:
        assert compute_entry_hash("prev", ENTRY) == compute_entry_hash("prev", ENTRY)

    def test_ignores_top_level_key_order(self) -> None:
        reordered = {
            "timestamp": ENTRY["timestamp"],
            "patientId": ENTRY["patientId"],
            "action": ENTRY["action"],
            "userId": ENTRY["userId"],
        }
        assert compute_entry_hash("prev", reordered) == compute_entry_hash("prev", ENTRY)

    def test_ignores_key_order_inside_nested_metadata(self) -> None:
        # Postgres jsonb reorders object keys on storage, so an entry read back
        # would never re-verify if nesting were hashed in document order.
        a = {**ENTRY, "metadata": {"reason": "BAD_PASSWORD", "failedLoginCount": 1, "locked": False}}
        b = {**ENTRY, "metadata": {"locked": False, "reason": "BAD_PASSWORD", "failedLoginCount": 1}}
        assert compute_entry_hash("prev", a) == compute_entry_hash("prev", b)

    def test_still_detects_a_changed_metadata_value(self) -> None:
        a = {**ENTRY, "metadata": {"reason": "BAD_PASSWORD", "failedLoginCount": 1}}
        b = {**ENTRY, "metadata": {"reason": "BAD_PASSWORD", "failedLoginCount": 4}}
        assert compute_entry_hash("prev", a) != compute_entry_hash("prev", b)

    def test_preserves_array_order_which_is_meaningful(self) -> None:
        a = {**ENTRY, "metadata": {"fields": ["diagnosis", "dosage"]}}
        b = {**ENTRY, "metadata": {"fields": ["dosage", "diagnosis"]}}
        assert compute_entry_hash("prev", a) != compute_entry_hash("prev", b)

    def test_changes_when_any_field_changes(self) -> None:
        altered = {**ENTRY, "patientId": "patient_2"}
        assert compute_entry_hash("prev", altered) != compute_entry_hash("prev", ENTRY)

    def test_changes_when_the_predecessor_changes(self) -> None:
        # A deleted entry breaks every entry after it.
        assert compute_entry_hash("prev_a", ENTRY) != compute_entry_hash("prev_b", ENTRY)
        assert compute_entry_hash(None, ENTRY) != compute_entry_hash("prev_a", ENTRY)

    def test_produces_a_full_length_sha256_digest(self) -> None:
        assert re.fullmatch(r"[0-9a-f]{64}", compute_entry_hash(None, ENTRY))

    def test_tampering_with_one_entry_invalidates_the_next(self) -> None:
        h1 = compute_entry_hash(None, {**ENTRY, "action": "LOGIN"})
        h2 = compute_entry_hash(h1, ENTRY)
        h3 = compute_entry_hash(h2, {**ENTRY, "action": "LOGOUT"})

        tampered = compute_entry_hash(h1, {**ENTRY, "patientId": "patient_x"})
        assert compute_entry_hash(tampered, {**ENTRY, "action": "LOGOUT"}) != h3


class TestMetadataSanitisation:
    def test_drops_secrets_a_caller_should_never_have_passed(self) -> None:
        cleaned = sanitize_metadata(
            {"password": "hunter2", "token": "abc", "reason": "BAD_PASSWORD", "count": 3}
        )
        assert cleaned == {"reason": "BAD_PASSWORD", "count": 3}

    def test_scrubs_nested_structures(self) -> None:
        cleaned = sanitize_metadata({"outer": {"refreshToken": "x", "keep": 1}})
        assert cleaned == {"outer": {"keep": 1}}

    def test_leaves_ordinary_values_alone(self) -> None:
        assert sanitize_metadata({"field": "diagnosis", "recordId": "abc"}) == {
            "field": "diagnosis",
            "recordId": "abc",
        }
