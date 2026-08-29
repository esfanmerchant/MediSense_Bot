"""Break-glass access (spec §"Emergency Access", requirement R3, conflict C1).

**A grant is issued immediately, not approved.** This is the decision the whole
module turns on, and it looks wrong until you consider what break-glass is for.
An unconscious patient arrives and the clinician in front of them is not their
assigned doctor. If the system waits for an administrator to click approve, it
has failed at the one moment it existed for — and the staff learn to keep a
shared login for emergencies, which is worse than anything this module could do.

So control does not come from *withholding* access. It comes from making access
expensive to misuse:

* a **reason** is mandatory and stored, so "why" is answerable later;
* the grant is **scoped to one patient** — it opens a chart, not the hospital;
* it **expires on a clock**, in minutes, not at the end of a shift;
* **every read is counted and audited** under BREAK_GLASS severity;
* the **patient is told** their record was opened this way;
* an **administrator must review it afterwards**, and unreviewed grants pile up
  visibly rather than quietly.

The deterrent is the review, not the restriction. A clinician who breaks glass
for a real emergency has nothing to fear from any of the above; one who does it
to read a colleague's chart is leaving a signed, timestamped record of having
done so.

**Expiry is enforced at the moment of use**, in ``resolve_patient_access`` —
never by a background sweeper. A sweeper that stops running would silently
extend every outstanding grant, which is exactly the failure mode a time-boxed
credential cannot afford. ``status`` is therefore a record of how a grant
*ended*, not what makes it stop working.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, not_found
from app.db.base import new_id, utcnow
from app.db.enums import EmergencyAccessStatus, NotificationType, Role
from app.db.models import EmergencyAccess, Patient, User
from app.modules.notifications.service import notify

#: How long a grant lasts. Short enough that walking away from a terminal does
#: not leave a chart open for the rest of a shift, long enough to actually treat
#: someone. Administrators extend by granting again — which leaves a second
#: audited record, rather than one grant that quietly grew.
GRANT_MINUTES = 30

#: A reason has to be a sentence, not a keystroke. Too short to say anything is
#: the same as saying nothing, and the reason is the only part of this record
#: that explains the rest of it.
MIN_REASON_LENGTH = 15


def is_live(grant: EmergencyAccess, *, now: Any = None) -> bool:
    """Whether this grant would authorize a read right now.

    Computed from status *and* the clock, because a grant that has run out is
    still ``ACTIVE`` in the column until something writes to it.
    """
    moment = now or utcnow()
    return grant.status == EmergencyAccessStatus.ACTIVE and grant.expires_at > moment


def effective_status(grant: EmergencyAccess) -> EmergencyAccessStatus:
    """What to show a reader. ``ACTIVE`` but past its expiry is ``EXPIRED``."""
    if grant.status == EmergencyAccessStatus.ACTIVE and grant.expires_at <= utcnow():
        return EmergencyAccessStatus.EXPIRED
    return grant.status


async def existing_live_grant(
    db: AsyncSession, requester_id: str, patient_id: str
) -> EmergencyAccess | None:
    """A grant this person already holds for this patient.

    Reused rather than duplicated: a clinician whose session dropped mid-
    emergency should not accumulate a second record for the same event, and a
    pile of near-identical grants makes the review that follows harder, not
    easier.
    """
    grant = (
        await db.execute(
            select(EmergencyAccess)
            .where(
                EmergencyAccess.requester_id == requester_id,
                EmergencyAccess.patient_id == patient_id,
                EmergencyAccess.status == EmergencyAccessStatus.ACTIVE,
                EmergencyAccess.expires_at > utcnow(),
            )
            .order_by(EmergencyAccess.granted_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return grant


async def grant(
    db: AsyncSession,
    *,
    requester_id: str,
    patient_id: str,
    reason: str,
    ip_address: str | None,
    user_agent: str | None,
) -> tuple[EmergencyAccess, bool]:
    """Open a chart. Returns (grant, created).

    ``created`` is False when an existing live grant was reused, which is a
    normal outcome and not an error.
    """
    exists = (
        await db.execute(select(Patient.id).where(Patient.id == patient_id))
    ).scalar_one_or_none()
    if exists is None:
        raise not_found("No such patient.")

    already = await existing_live_grant(db, requester_id, patient_id)
    if already is not None:
        return already, False

    record = EmergencyAccess(
        id=new_id(),
        requester_id=requester_id,
        patient_id=patient_id,
        reason=reason,
        status=EmergencyAccessStatus.ACTIVE,
        ip_address=ip_address,
        user_agent=user_agent,
        expires_at=utcnow() + timedelta(minutes=GRANT_MINUTES),
    )
    db.add(record)
    await db.flush()
    return record, True


async def revoke(
    db: AsyncSession, grant_record: EmergencyAccess, *, revoked_by: str
) -> None:
    """End a grant before its clock does."""
    if grant_record.status == EmergencyAccessStatus.REVOKED:
        return
    grant_record.status = EmergencyAccessStatus.REVOKED
    grant_record.revoked_at = utcnow()
    grant_record.revoked_by_id = revoked_by
    await db.flush()


async def review(
    db: AsyncSession, grant_record: EmergencyAccess, *, reviewer_id: str, notes: str
) -> None:
    """Record the compliance review this grant was always going to get."""
    if grant_record.reviewed_at is not None:
        raise conflict("That emergency access has already been reviewed.")
    grant_record.reviewed_at = utcnow()
    grant_record.reviewed_by_id = reviewer_id
    grant_record.review_notes = notes
    await db.flush()


async def announce(db: AsyncSession, grant_record: EmergencyAccess, requester_name: str) -> None:
    """Tell the patient, and tell the administrators.

    The patient is told because it is their record: someone outside their care
    team opened it, and finding that out from an audit request months later is
    not transparency. The notification says *that* it happened and who did it —
    never what they read, which is clinical content and stays in the portal.

    Administrators are told because the review is the control, and a review
    nobody is prompted to do is a review that does not happen.
    """
    patient_user_id = (
        await db.execute(
            select(Patient.user_id).where(Patient.id == grant_record.patient_id)
        )
    ).scalar_one_or_none()

    await notify(
        db,
        user_id=patient_user_id,
        notification_type=NotificationType.EMERGENCY_ACCESS,
        title="Your record was opened under emergency access",
        body=(
            f"{requester_name} opened your record under emergency access. "
            "This is recorded and will be reviewed by an administrator."
        ),
        link="/patient",
        metadata={"emergencyAccessId": grant_record.id},
        priority=2,
    )

    admin_ids = (
        (await db.execute(select(User.id).where(User.role == Role.ADMIN))).scalars().all()
    )
    for admin_id in admin_ids:
        await notify(
            db,
            user_id=admin_id,
            notification_type=NotificationType.EMERGENCY_ACCESS,
            title="Emergency access granted — review required",
            body=f"{requester_name} was granted emergency access to a patient record.",
            link="/admin/emergency",
            metadata={"emergencyAccessId": grant_record.id},
            priority=2,
        )


def serialize(grant_record: EmergencyAccess, *, requester_name: str | None = None) -> dict[str, Any]:
    return {
        "id": grant_record.id,
        "requesterId": grant_record.requester_id,
        "requesterName": requester_name,
        "patientId": grant_record.patient_id,
        "reason": grant_record.reason,
        "status": str(effective_status(grant_record)),
        "grantedAt": grant_record.granted_at.isoformat() + "Z",
        "expiresAt": grant_record.expires_at.isoformat() + "Z",
        "revokedAt": (
            grant_record.revoked_at.isoformat() + "Z" if grant_record.revoked_at else None
        ),
        # How much was actually read under the grant. A grant used once looks
        # very different from one used ninety times, and that difference is the
        # first thing a reviewer should see.
        "accessCount": grant_record.access_count,
        "reviewedAt": (
            grant_record.reviewed_at.isoformat() + "Z" if grant_record.reviewed_at else None
        ),
        "reviewedById": grant_record.reviewed_by_id,
        "reviewNotes": grant_record.review_notes,
        "live": is_live(grant_record),
    }
