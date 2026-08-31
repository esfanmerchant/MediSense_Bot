"""Request and response models for authentication."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.core.session_policy import DeviceClass
from app.db.enums import Gender, Role, TwoFactorMethod, UserStatus

Password = Annotated[str, Field(min_length=10, max_length=200)]
_PHONE = re.compile(r"^\+?[\d\s-]{7,20}$")
#: Long enough for a six-digit code and a ten-character backup code, with room
#: for the spaces people paste around them.
Code = Annotated[str, Field(min_length=4, max_length=32)]


class _Base(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore")


def _normalise_email(value: str) -> str:
    return value.strip().lower()


class RegisterRequest(_Base):
    name: Annotated[str, Field(min_length=2, max_length=120)]
    email: EmailStr
    password: Password
    #: The only two roles anybody may ask for. A doctor still cannot *practise*
    #: by choosing this — it creates an application an administrator has to
    #: approve — but NURSE and ADMIN remain accounts only an administrator
    #: creates, so no one can grant themselves either by editing a request body.
    role: Literal[Role.PATIENT, Role.DOCTOR] = Role.PATIENT
    #: Must be true. A default of False rather than a required field so an
    #: older client gets a clear refusal naming the box it did not tick,
    #: rather than a schema error about a missing key.
    accepted_terms: bool = Field(default=False, alias="acceptedTerms")
    phone: str | None = None
    date_of_birth: datetime | None = Field(default=None, alias="dateOfBirth")
    gender: Gender = Gender.UNDISCLOSED
    blood_group: Literal["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] | None = Field(
        default=None, alias="bloodGroup"
    )
    address: Annotated[str, Field(max_length=500)] | None = None
    emergency_contact_name: Annotated[str, Field(max_length=120)] | None = Field(
        default=None, alias="emergencyContactName"
    )
    emergency_contact_phone: str | None = Field(default=None, alias="emergencyContactPhone")

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore", populate_by_name=True)

    _email = field_validator("email")(lambda v: _normalise_email(str(v)))

    @field_validator("phone", "emergency_contact_phone")
    @classmethod
    def _valid_phone(cls, value: str | None) -> str | None:
        if value and not _PHONE.match(value):
            raise ValueError("Enter a valid phone number.")
        return value

    @field_validator("date_of_birth")
    @classmethod
    def _not_future(cls, value: datetime | None) -> datetime | None:
        if value and value.replace(tzinfo=None) > datetime.utcnow():
            raise ValueError("Date of birth cannot be in the future.")
        return value


class LoginRequest(_Base):
    email: EmailStr
    password: Annotated[str, Field(min_length=1, max_length=200)]
    #: Drives the idle-timeout tier (R8). Defaults to the strictest class, so a
    #: client cannot widen its own timeout by omitting the field.
    device_class: DeviceClass = Field(default=DeviceClass.SHARED_TERMINAL, alias="deviceClass")

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore", populate_by_name=True)

    _email = field_validator("email")(lambda v: _normalise_email(str(v)))


class ForgotPasswordRequest(_Base):
    email: EmailStr

    _email = field_validator("email")(lambda v: _normalise_email(str(v)))


class ResetPasswordRequest(_Base):
    token: Annotated[str, Field(min_length=10)]
    password: Password


class ChangePasswordRequest(_Base):
    current_password: Annotated[str, Field(min_length=1)] = Field(alias="currentPassword")
    new_password: Password = Field(alias="newPassword")

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore", populate_by_name=True)


class VerifyEmailRequest(_Base):
    email: EmailStr
    code: Code
    #: Carried here as well as on login because verification issues the first
    #: session, and a session created without it would silently get the
    #: strictest timeout tier on a personal device.
    device_class: DeviceClass = Field(default=DeviceClass.SHARED_TERMINAL, alias="deviceClass")

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore", populate_by_name=True)

    _email = field_validator("email")(lambda v: _normalise_email(str(v)))


class ResendCodeRequest(_Base):
    email: EmailStr

    _email = field_validator("email")(lambda v: _normalise_email(str(v)))


class TwoFactorVerifyRequest(_Base):
    challenge_id: Annotated[str, Field(min_length=8, max_length=64)] = Field(alias="challengeId")
    code: Code
    remember_device: bool = Field(default=False, alias="rememberDevice")

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore", populate_by_name=True)


class ChallengeRequest(_Base):
    challenge_id: Annotated[str, Field(min_length=8, max_length=64)] = Field(alias="challengeId")

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore", populate_by_name=True)


class TwoFactorStartRequest(_Base):
    method: TwoFactorMethod


class TwoFactorConfirmRequest(_Base):
    challenge_id: Annotated[str, Field(min_length=8, max_length=64)] = Field(alias="challengeId")
    code: Code

    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore", populate_by_name=True)


class TwoFactorDisableRequest(_Base):
    #: The password is required as well as a current code. Either alone is
    #: enough to *use* the account; turning the second factor off should need
    #: both, or an unlocked session left open becomes a way to remove it.
    password: Annotated[str, Field(min_length=1, max_length=200)]
    code: Code


class PasswordConfirmRequest(_Base):
    password: Annotated[str, Field(min_length=1, max_length=200)]


class UserOut(BaseModel):
    """Public shape of a user. Never carries the password hash."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    email: str
    role: Role
    phone: str | None
    status: UserStatus
    patient_id: str | None = Field(default=None, serialization_alias="patientId")
    doctor_id: str | None = Field(default=None, serialization_alias="doctorId")
    permissions: list[str]


class SessionOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_id: str = Field(serialization_alias="sessionId")
    #: ``None`` means the device class is exempt from idle expiry.
    idle_timeout_seconds: int | None = Field(serialization_alias="idleTimeoutSeconds")
    access_token_expires_in_seconds: int = Field(serialization_alias="accessTokenExpiresInSeconds")
