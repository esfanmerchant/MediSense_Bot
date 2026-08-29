"""Appointment booking and the consultation lifecycle (R7, spec §14).

Authorization here is scope-shaped rather than check-shaped: every read runs
through ``scope_for``, which turns the caller's role into a SQL filter, so an
appointment belonging to someone else is never loaded — not loaded and then
rejected. Writes then re-check the specific relationship, because being able to
*see* an appointment is not the same as being able to complete it.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.api.deps import CurrentAuth, DbSession, client_ip, require_any_permission
from app.api.responses import Page, ok, pagination
from app.core.config import settings
from app.core.errors import bad_request, forbidden
from app.db.base import utcnow
from app.db.enums import AppointmentStatus, AuditAction, NotificationType, Role
from app.db.models import Appointment
from app.modules.appointments import service
from app.modules.appointments.schedule import MAX_RANGE_DAYS, iso_utc, to_clinic
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission
from app.modules.billing import service as billing
from app.modules.notifications.service import (
    notify,
    user_id_for_doctor,
    user_id_for_patient,
)

router = APIRouter(prefix="/appointments", tags=["appointments"])

#: Every appointment route needs at least one of these. The finer question —
#: *this* appointment, *this* transition — is settled in the service layer.
RequireAppointmentAccess = Annotated[
    object,
    Depends(
        require_any_permission(
            Permission.APPOINTMENT_BOOK_OWN,
            Permission.APPOINTMENT_READ_OWN,
            Permission.APPOINTMENT_READ_ASSIGNED,
            Permission.APPOINTMENT_MANAGE_ANY,
        )
    ),
]


def normalize_start(value: datetime) -> datetime:
    """Normalise a submitted time to the naive-UTC form the columns hold.

    A client may send ``...Z``, an explicit offset, or a bare timestamp. An
    offset is honoured; a bare value is read as UTC, which is what every
    timestamp this API hands out carries. Seconds are dropped because slots
    always start on a minute boundary — without this, ``09:00:30`` would miss
    the grid and be rejected as "not one of the doctor's slots", which is true
    but unhelpful.
    """
    if value.tzinfo is not None:
        value = value.astimezone(UTC).replace(tzinfo=None)
    return value.replace(second=0, microsecond=0)


class BookingRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    doctor_id: str = Field(alias="doctorId", min_length=1, max_length=64)
    start_time: datetime = Field(alias="startTime")
    reason: Annotated[str, Field(max_length=500)] | None = None
    #: Honoured only for administrators booking on someone's behalf; a patient's
    #: own id always comes from their session.
    patient_id: str | None = Field(default=None, alias="patientId", max_length=64)

    _normalize_start = field_validator("start_time")(normalize_start)


class RescheduleRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    start_time: datetime = Field(alias="startTime")
    reason: Annotated[str, Field(max_length=500)] | None = None

    _normalize_start = field_validator("start_time")(normalize_start)


class CancelRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    reason: Annotated[str, Field(max_length=500)] | None = None


class StatusChangeRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    status: AppointmentStatus
    notes: Annotated[str, Field(max_length=2000)] | None = None


async def _audit(
    request: Request,
    db: DbSession,
    auth: CurrentAuth,
    action: AuditAction,
    appointment: Appointment,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Record an appointment event.

    Metadata carries times and ids — scheduling facts — and never the reason a
    patient gave for the visit, which is clinical content and belongs in the
    record rather than the audit trail.
    """
    await record_audit(
        db,
        AuditEntry(
            action=action,
            user_id=auth.user_id,
            actor_role=auth.role,
            patient_id=appointment.patient_id,
            entity_type="Appointment",
            entity_id=appointment.id,
            ip_address=client_ip(request),
            user_agent=request.headers.get("user-agent"),
            request_id=getattr(request.state, "request_id", None),
            emergency_access_id=auth.emergency_access_id,
            metadata={
                "doctorId": appointment.doctor_id,
                "startTime": iso_utc(appointment.start_time),
                "status": str(appointment.status),
            }
            | (metadata or {}),
        ),
    )


async def _notify_both(
    db: DbSession,
    appointment: Appointment,
    *,
    notification_type: NotificationType,
    title: str,
    patient_body: str,
    doctor_body: str,
) -> None:
    """Tell both parties, each in their own words.

    Separate bodies rather than one shared string: "your appointment" and "an
    appointment" are the difference between a message that reads as addressed to
    you and one that reads as a system log line.
    """
    link = f"/appointments/{appointment.id}"
    await notify(
        db,
        user_id=await user_id_for_patient(db, appointment.patient_id),
        notification_type=notification_type,
        title=title,
        body=patient_body,
        link=link,
        metadata={"appointmentId": appointment.id},
    )
    await notify(
        db,
        user_id=await user_id_for_doctor(db, appointment.doctor_id),
        notification_type=notification_type,
        title=title,
        body=doctor_body,
        link=link,
        metadata={"appointmentId": appointment.id},
    )


def _when(appointment: Appointment) -> str:
    local = to_clinic(appointment.start_time)
    return local.strftime("%d %b %Y at %H:%M")


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------


@router.get("/availability")
async def get_availability(
    auth: CurrentAuth,
    db: DbSession,
    doctor_id: Annotated[str, Query(alias="doctorId", min_length=1, max_length=64)],
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
) -> dict[str, Any]:
    """A doctor's slot grid, marked free or taken.

    Open to any signed-in user because a patient must be able to browse before
    booking. What comes back is free/busy only — never who holds a slot — so
    browsing a calendar reveals no one's care.
    """
    today = to_clinic(utcnow()).date()
    first = from_date or today
    last = to_date or first + timedelta(days=13)

    if last < first:
        raise bad_request("The 'to' date must not be before the 'from' date.")
    if (last - first).days >= MAX_RANGE_DAYS:
        raise bad_request(f"Request at most {MAX_RANGE_DAYS} days of availability at a time.")
    # A past start is clamped rather than rejected: "this week" is a reasonable
    # thing for a client to ask for on a Wednesday.
    first = max(first, today)

    days = await service.availability(db, doctor_id, first, last)
    return ok({"doctorId": doctor_id, "timezone": settings.CLINIC_TIMEZONE, "days": days})


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@router.get("")
async def list_appointments(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    _: RequireAppointmentAccess,
    status: AppointmentStatus | None = None,
    from_date: Annotated[date | None, Query(alias="from")] = None,
    to_date: Annotated[date | None, Query(alias="to")] = None,
    doctor_id: Annotated[str | None, Query(alias="doctorId")] = None,
    patient_id: Annotated[str | None, Query(alias="patientId")] = None,
    upcoming_only: Annotated[bool, Query(alias="upcomingOnly")] = False,
) -> dict[str, Any]:
    """The caller's appointments — their own, their caseload, or all for an admin."""
    filters = service.list_filters(
        auth,
        status=status,
        from_date=from_date,
        to_date=to_date,
        doctor_id=doctor_id,
        patient_id=patient_id,
        upcoming_only=upcoming_only,
    )

    total = await service.count_appointments(db, filters)
    order = Appointment.start_time.asc() if upcoming_only else Appointment.start_time.desc()
    rows = (
        await db.execute(
            service.visible_columns().where(*filters).order_by(order).limit(page.limit).offset(page.offset)
        )
    ).all()

    return ok([service.serialize_row(row) for row in rows], page.meta(total))


@router.get("/{appointment_id}")
async def get_appointment(
    appointment_id: str, auth: CurrentAuth, db: DbSession, _: RequireAppointmentAccess
) -> dict[str, Any]:
    row = await service.load_for(db, auth, appointment_id)
    return ok(service.serialize_row(row))


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


@router.post("", status_code=201)
async def book_appointment(
    payload: BookingRequest, request: Request, auth: CurrentAuth, db: DbSession
) -> dict[str, Any]:
    """Book a slot.

    Contention is settled by the unique index on ``slotKey``: if two requests
    race for one slot, the loser's INSERT fails and the application's
    ``IntegrityError`` handler returns ``SLOT_UNAVAILABLE``. Nothing here needs
    to lock, and no check-then-write window exists to lose.
    """
    appointment = await service.book(
        db,
        auth,
        doctor_id=payload.doctor_id,
        start=payload.start_time,
        reason=payload.reason,
        requested_patient_id=payload.patient_id,
    )

    await _audit(request, db, auth, AuditAction.APPOINTMENT_CREATED, appointment)
    await _notify_both(
        db,
        appointment,
        notification_type=NotificationType.APPOINTMENT_BOOKED,
        title="Appointment requested",
        patient_body=(
            f"Your appointment on {_when(appointment)} has been requested "
            "and is awaiting confirmation."
        ),
        doctor_body=f"A new appointment request for {_when(appointment)} awaits your confirmation.",
    )

    row = await service.load_for(db, auth, appointment.id)
    return ok(service.serialize_row(row))


@router.post("/{appointment_id}/cancel")
async def cancel(
    appointment_id: str,
    payload: CancelRequest,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireAppointmentAccess,
) -> dict[str, Any]:
    """Cancel and release the slot so someone else can take it."""
    row = await service.load_for(db, auth, appointment_id)
    appointment: Appointment = row[0]

    await service.cancel_appointment(db, auth, appointment, payload.reason)
    await _audit(
        request,
        db,
        auth,
        AuditAction.APPOINTMENT_CANCELLED,
        appointment,
        {"cancelledByRole": str(auth.role)},
    )
    await _notify_both(
        db,
        appointment,
        notification_type=NotificationType.APPOINTMENT_CANCELLED,
        title="Appointment cancelled",
        patient_body=f"Your appointment on {_when(appointment)} has been cancelled.",
        doctor_body=f"The appointment on {_when(appointment)} has been cancelled.",
    )
    # Re-read so a cancellation returns the same shape as every other
    # appointment response, counterparty names included.
    return ok(service.serialize_row(await service.load_for(db, auth, appointment_id)))


@router.post("/{appointment_id}/reschedule")
async def reschedule(
    appointment_id: str,
    payload: RescheduleRequest,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireAppointmentAccess,
) -> dict[str, Any]:
    """Move an appointment to a new slot.

    Produces a *new* appointment linked to the original by
    ``rescheduledFromId``, so the response carries a different id than the one
    in the path — the original time survives as a fact rather than being
    overwritten.
    """
    row = await service.load_for(db, auth, appointment_id)
    original: Appointment = row[0]

    replacement = await service.reschedule_appointment(
        db, auth, original, start=payload.start_time, reason=payload.reason
    )

    await _audit(
        request,
        db,
        auth,
        AuditAction.APPOINTMENT_UPDATED,
        replacement,
        {
            "operation": "reschedule",
            "previousAppointmentId": original.id,
            "previousStartTime": iso_utc(original.start_time),
        },
    )
    await _notify_both(
        db,
        replacement,
        notification_type=NotificationType.APPOINTMENT_RESCHEDULED,
        title="Appointment rescheduled",
        patient_body=f"Your appointment has been moved to {_when(replacement)}.",
        doctor_body=f"An appointment has been moved to {_when(replacement)}.",
    )

    new_row = await service.load_for(db, auth, replacement.id)
    return ok(service.serialize_row(new_row))


@router.post("/{appointment_id}/status")
async def set_status(
    appointment_id: str,
    payload: StatusChangeRequest,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireAppointmentAccess,
) -> dict[str, Any]:
    """Advance an appointment: confirm, check in, start, complete, or no-show.

    Legal moves and their actors come from ``ALLOWED_TRANSITIONS``; the caller
    names a target and the machine decides whether it is reachable from here and
    whether this caller may do it.
    """
    row = await service.load_for(db, auth, appointment_id)
    appointment: Appointment = row[0]
    previous = appointment.status

    if payload.notes is not None:
        # A refusal, not a malformed request: an administrator may legitimately
        # confirm this appointment, but consultation notes are clinical content
        # and belong to the doctor who saw the patient (R2).
        if auth.role != Role.DOCTOR or auth.doctor_id != appointment.doctor_id:
            raise forbidden("Only the treating doctor can add consultation notes.")
        appointment.notes = payload.notes

    await service.change_status(db, auth, appointment, payload.status)

    action = (
        AuditAction.CONSULTATION_COMPLETED
        if payload.status == AppointmentStatus.COMPLETED
        else AuditAction.APPOINTMENT_UPDATED
    )
    await _audit(
        request,
        db,
        auth,
        action,
        appointment,
        {"from": str(previous), "to": str(payload.status), "notesUpdated": payload.notes is not None},
    )

    if payload.status == AppointmentStatus.CONFIRMED:
        await notify(
            db,
            user_id=await user_id_for_patient(db, appointment.patient_id),
            notification_type=NotificationType.APPOINTMENT_BOOKED,
            title="Appointment confirmed",
            body=f"Your appointment on {_when(appointment)} is confirmed.",
            link=f"/appointments/{appointment.id}",
            metadata={"appointmentId": appointment.id},
        )

    if payload.status == AppointmentStatus.COMPLETED:
        # Automatic billing (spec §15, R4). Inside the same transaction as the
        # status change, so a completed consultation and its invoice commit
        # together or not at all — there is no window where the visit is billed
        # but not recorded, or recorded but never billed.
        #
        # Idempotent by construction: the unique `Invoice.appointmentId` means a
        # retried completion finds the existing invoice instead of writing a
        # second one, and `created` says which happened.
        invoice, created = await billing.generate_for_appointment(db, appointment)
        if created:
            await billing.announce(db, invoice)
            await _audit(
                request,
                db,
                auth,
                AuditAction.INVOICE_CREATED,
                appointment,
                {
                    "invoiceId": invoice.id,
                    "invoiceNumber": invoice.invoice_number,
                    "totalAmount": str(invoice.total_amount),
                },
            )

    updated = await service.load_for(db, auth, appointment.id)
    return ok(service.serialize_row(updated))
