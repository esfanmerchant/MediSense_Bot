"""Request models for doctor registration and its review."""

from __future__ import annotations

import re
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.appointments.schedule import AvailabilityWindow

_PHONE = re.compile(r"^\+?[\d\s-]{7,20}$")

#: One line of a qualification list — "MBBS, King Edward Medical University".
Qualification = Annotated[str, Field(min_length=1, max_length=200)]


class _Base(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore", populate_by_name=True)


class ApplicationUpdate(_Base):
    """A partial draft save.

    Every field is optional and nothing is required until submission, because
    somebody assembling their credentials will leave and come back — and a form
    that refuses to save until it is complete is a form people fill in twice.

    ``exclude_unset`` is what makes this idempotent *and* able to clear a field:
    an omitted key is left alone, an explicit ``null`` blanks it.
    """

    full_name: Annotated[str, Field(min_length=2, max_length=120)] | None = Field(
        default=None, alias="fullName"
    )
    phone: str | None = None
    national_id: Annotated[str, Field(max_length=64)] | None = Field(default=None, alias="nationalId")
    address: Annotated[str, Field(max_length=500)] | None = None
    registration_number: Annotated[str, Field(min_length=2, max_length=64)] | None = Field(
        default=None, alias="registrationNumber"
    )
    specialization: Annotated[str, Field(min_length=2, max_length=120)] | None = None
    department_id: Annotated[str, Field(max_length=64)] | None = Field(
        default=None, alias="departmentId"
    )
    qualifications: (
        Annotated[list[Qualification], Field(max_length=20)] | None
    ) = None
    years_experience: Annotated[int, Field(ge=0, le=70)] | None = Field(
        default=None, alias="yearsExperience"
    )
    previous_hospital: Annotated[str, Field(max_length=200)] | None = Field(
        default=None, alias="previousHospital"
    )
    consultation_fee: Annotated[float, Field(ge=0, le=1_000_000)] | None = Field(
        default=None, alias="consultationFee"
    )
    #: Validated on the way in rather than stored as free-form JSON: these
    #: windows become the slot grid patients book against the moment the
    #: application is approved, and a malformed entry there is a calendar that
    #: silently produces no appointments.
    availability: Annotated[list[AvailabilityWindow], Field(max_length=40)] | None = None

    @field_validator("phone")
    @classmethod
    def _valid_phone(cls, value: str | None) -> str | None:
        if value and not _PHONE.match(value):
            raise ValueError("Enter a valid phone number.")
        return value


class ReviewApprove(_Base):
    notes: Annotated[str, Field(max_length=1000)] | None = None


class ReviewReject(_Base):
    #: Shown to the applicant verbatim, so it has to say something. "Rejected"
    #: with no reason produces a resubmission with the same problem in it.
    reason: Annotated[str, Field(min_length=5, max_length=500)]
    notes: Annotated[str, Field(max_length=1000)] | None = None


class DocumentVerification(_Base):
    verified: bool
