from __future__ import annotations

import pytest

from app.db.enums import Role
from app.modules.auth.rbac import Permission, permissions_for, role_has_permission


class TestRolePermissions:
    def test_patients_reach_only_their_own_data(self) -> None:
        assert role_has_permission(Role.PATIENT, Permission.RECORD_READ_OWN)
        assert not role_has_permission(Role.PATIENT, Permission.RECORD_READ_ASSIGNED)
        assert not role_has_permission(Role.PATIENT, Permission.PATIENT_READ_ANY)

    @pytest.mark.parametrize(
        "permission",
        [Permission.RECORD_WRITE, Permission.PRESCRIPTION_WRITE, Permission.CONSULTATION_COMPLETE],
    )
    def test_patients_never_write_clinical_records(self, permission: Permission) -> None:
        # Physician-authored records are not patient-editable (spec §13).
        assert not role_has_permission(Role.PATIENT, permission)

    def test_doctors_are_scoped_to_assigned_patients(self) -> None:
        assert role_has_permission(Role.DOCTOR, Permission.RECORD_READ_ASSIGNED)
        assert not role_has_permission(Role.DOCTOR, Permission.PATIENT_READ_ANY)

    def test_administration_is_separate_from_clinical_content(self) -> None:
        # Admins run the hospital; they get no standing right to read charts.
        assert role_has_permission(Role.ADMIN, Permission.USER_MANAGE)
        assert role_has_permission(Role.ADMIN, Permission.AUDIT_READ)
        assert not role_has_permission(Role.ADMIN, Permission.RECORD_READ_ASSIGNED)
        assert not role_has_permission(Role.ADMIN, Permission.RECORD_WRITE)

    def test_nurses_hold_no_standing_patient_access(self) -> None:
        assert role_has_permission(Role.NURSE, Permission.EMERGENCY_REQUEST)
        for denied in (
            Permission.RECORD_READ_ASSIGNED,
            Permission.PATIENT_READ_ANY,
            Permission.DOCUMENT_READ_ASSIGNED,
            Permission.PATIENT_READ_OWN,
        ):
            assert not role_has_permission(Role.NURSE, denied)

    @pytest.mark.parametrize("role", [Role.DOCTOR, Role.PATIENT, Role.NURSE])
    def test_only_admins_read_the_audit_log(self, role: Role) -> None:
        assert not role_has_permission(role, Permission.AUDIT_READ)

    @pytest.mark.parametrize("role", list(Role))
    def test_every_role_has_a_permission_set(self, role: Role) -> None:
        assert len(permissions_for(role)) > 0
