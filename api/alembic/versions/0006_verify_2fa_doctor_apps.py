"""Email verification, two-factor authentication, and doctor self-registration.

Three features, one revision, because they share a spine: none of them can work
until ``users`` carries the columns that describe how an account proves itself,
and splitting that column set across three migrations would leave two of them
in a state where the application does not run.

**What this does.**

*Types.* Three new enums (``TwoFactorMethod``, ``DoctorApplicationStatus``,
``DoctorDocumentKind``) are created, and values are added to two existing ones —
``AuditAction`` gains the seven actions these flows record, and
``NotificationType`` gains ``DOCTOR_APPLICATION``. Recording a doctor's approval
as ``CONFIG_CHANGED`` would put a false claim in an append-only table, which is
the same reasoning revision 0005 gives for ``AUDIT_VIEWED``.

*Columns.* ``users`` gains the verification code's hash, expiry, attempt count
and send bookkeeping, plus the two-factor flag, method, sealed TOTP secret and
hashed backup codes. Every one is nullable or defaulted, so existing rows are
valid the moment they exist.

*Tables.* ``two_factor_challenges``, ``trusted_devices``,
``doctor_applications`` and ``doctor_application_documents``.

*Backfill, and this is the part that matters.* Two things would otherwise break
on deploy:

1. **Every existing account would be locked out.** Login now refuses an
   unverified address, and every row predates the column that records
   verification. So every current user is stamped verified at their creation
   time — they were created by an administrator or registered before this
   existed, and treating a working account as unproven would be a regression
   dressed up as security.
2. **Every seeded doctor would be locked out.** Login also refuses a doctor
   whose application is not APPROVED. Doctors who already hold a ``Doctor`` row
   were approved by the administrator who created them, which is the stronger
   form of the same decision, so each gets an APPROVED application recording
   exactly that.

Revision ID: 0006_verify_2fa_doctor_apps

The identifier is abbreviated because Alembic stores it in a
``varchar(32)``; a descriptive one is silently truncated at write time and
the upgrade fails after every statement has already run.
Revises: 0005_audit_viewed_action
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0006_verify_2fa_doctor_apps"
down_revision: str | None = "0005_audit_viewed_action"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: New enum types, and their values in declaration order.
NEW_TYPES: dict[str, tuple[str, ...]] = {
    "TwoFactorMethod": ("EMAIL", "TOTP"),
    "DoctorApplicationStatus": ("DRAFT", "SUBMITTED", "APPROVED", "REJECTED"),
    "DoctorDocumentKind": ("REGISTRATION_CERTIFICATE", "DEGREE", "NATIONAL_ID", "PHOTO"),
}

#: Values added to enum types that already exist.
ADDED_VALUES: dict[str, tuple[str, ...]] = {
    "AuditAction": (
        "EMAIL_VERIFIED",
        "TWO_FACTOR_ENABLED",
        "TWO_FACTOR_DISABLED",
        "BACKUP_CODES_REGENERATED",
        "DOCTOR_APPLICATION_SUBMITTED",
        "DOCTOR_APPLICATION_APPROVED",
        "DOCTOR_APPLICATION_REJECTED",
    ),
    "NotificationType": ("DOCTOR_APPLICATION",),
}

#: (column, type, extra). Split out so the loop below reads as a list of columns
#: rather than eleven near-identical statements.
USER_COLUMNS: tuple[tuple[str, str], ...] = (
    ('"emailVerificationCodeHash"', "text"),
    ('"emailVerificationExpiresAt"', "timestamp(3)"),
    ('"emailVerificationAttempts"', "integer NOT NULL DEFAULT 0"),
    ('"emailVerificationSentAt"', "timestamp(3)"),
    ('"emailVerificationSendCount"', "integer NOT NULL DEFAULT 0"),
    ('"twoFactorEnabled"', "boolean NOT NULL DEFAULT false"),
    ('"twoFactorMethod"', '"TwoFactorMethod"'),
    ('"twoFactorSecret"', "text"),
    ('"twoFactorBackupCodes"', "jsonb NOT NULL DEFAULT '[]'::jsonb"),
    ('"twoFactorEnabledAt"', "timestamp(3)"),
)


def upgrade() -> None:
    for type_name, values in NEW_TYPES.items():
        rendered = ", ".join(f"'{value}'" for value in values)
        # Guarded the way the baseline guards its own types, so this is safe to
        # run against a database built from 0001 after these models existed.
        op.execute(
            f"""
            DO $$ BEGIN
                CREATE TYPE "{type_name}" AS ENUM ({rendered});
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
            """
        )

    for type_name, values in ADDED_VALUES.items():
        for value in values:
            op.execute(f"ALTER TYPE \"{type_name}\" ADD VALUE IF NOT EXISTS '{value}'")

    for column, definition in USER_COLUMNS:
        op.execute(f"ALTER TABLE users ADD COLUMN IF NOT EXISTS {column} {definition}")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS two_factor_challenges (
            id text PRIMARY KEY,
            "userId" text NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
            purpose text NOT NULL DEFAULT 'LOGIN',
            method "TwoFactorMethod" NOT NULL,
            "codeHash" text,
            "pendingSecret" text,
            "deviceClass" text NOT NULL DEFAULT 'PERSONAL',
            "expiresAt" timestamp(3) NOT NULL,
            attempts integer NOT NULL DEFAULT 0,
            "consumedAt" timestamp(3),
            "sentAt" timestamp(3),
            "createdAt" timestamp(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
        )
        """
    )
    op.execute(
        'CREATE INDEX IF NOT EXISTS "two_factor_challenges_userId_idx" '
        'ON two_factor_challenges ("userId")'
    )
    op.execute(
        'CREATE INDEX IF NOT EXISTS "two_factor_challenges_expiresAt_idx" '
        'ON two_factor_challenges ("expiresAt")'
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trusted_devices (
            id text PRIMARY KEY,
            "userId" text NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
            "tokenHash" text NOT NULL,
            "expiresAt" timestamp(3) NOT NULL,
            "lastUsedAt" timestamp(3),
            "userAgent" text,
            "createdAt" timestamp(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
        )
        """
    )
    op.execute(
        'CREATE UNIQUE INDEX IF NOT EXISTS "trusted_devices_tokenHash_key" '
        'ON trusted_devices ("tokenHash")'
    )
    op.execute(
        'CREATE INDEX IF NOT EXISTS "trusted_devices_userId_idx" ON trusted_devices ("userId")'
    )
    op.execute(
        'CREATE INDEX IF NOT EXISTS "trusted_devices_expiresAt_idx" '
        'ON trusted_devices ("expiresAt")'
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS doctor_applications (
            id text PRIMARY KEY,
            "userId" text NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
            status "DoctorApplicationStatus" NOT NULL DEFAULT 'DRAFT',
            "fullName" text,
            phone text,
            "nationalId" text,
            address text,
            "registrationNumber" text,
            specialization text,
            "departmentId" text REFERENCES departments(id) ON DELETE SET NULL ON UPDATE CASCADE,
            qualifications jsonb NOT NULL DEFAULT '[]'::jsonb,
            "yearsExperience" integer,
            "previousHospital" text,
            "consultationFee" numeric(10,2),
            availability jsonb NOT NULL DEFAULT '[]'::jsonb,
            "submittedAt" timestamp(3),
            "reviewedAt" timestamp(3),
            "reviewedById" text,
            "rejectionReason" text,
            "reviewNotes" text,
            "createdAt" timestamp(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
            "updatedAt" timestamp(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
        )
        """
    )
    op.execute(
        'CREATE UNIQUE INDEX IF NOT EXISTS "doctor_applications_userId_key" '
        'ON doctor_applications ("userId")'
    )
    op.execute(
        'CREATE INDEX IF NOT EXISTS "doctor_applications_status_submittedAt_idx" '
        'ON doctor_applications (status, "submittedAt")'
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS doctor_application_documents (
            id text PRIMARY KEY,
            "applicationId" text NOT NULL
                REFERENCES doctor_applications(id) ON DELETE CASCADE ON UPDATE CASCADE,
            kind "DoctorDocumentKind" NOT NULL,
            "storageBucket" text NOT NULL DEFAULT 'doctor-credentials',
            "storagePath" text NOT NULL,
            "fileName" text NOT NULL,
            "mimeType" text NOT NULL,
            "fileSize" integer NOT NULL,
            "checksumSha256" text,
            verified boolean NOT NULL DEFAULT false,
            "verifiedById" text,
            "uploadedAt" timestamp(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
        )
        """
    )
    op.execute(
        'CREATE UNIQUE INDEX IF NOT EXISTS "doctor_application_documents_storagePath_key" '
        'ON doctor_application_documents ("storagePath")'
    )
    op.execute(
        'CREATE INDEX IF NOT EXISTS "doctor_application_documents_applicationId_idx" '
        'ON doctor_application_documents ("applicationId")'
    )

    # --- Backfill ---------------------------------------------------------
    #
    # Everyone who already has an account has already been trusted with one.
    # Stamped at creation time rather than now, so the column says when the
    # account became usable rather than when this migration happened to run.
    op.execute(
        """
        UPDATE users
        SET "emailVerifiedAt" = "createdAt"
        WHERE "emailVerifiedAt" IS NULL AND status <> 'PENDING_VERIFICATION'
        """
    )

    # A doctor holding a Doctor row was approved by the administrator who
    # created them. The application records that decision so there is one
    # description of who may practise, not two that can disagree.
    op.execute(
        """
        INSERT INTO doctor_applications (
            id, "userId", status, "fullName", phone, "registrationNumber",
            specialization, "departmentId", "yearsExperience", "consultationFee",
            availability, "submittedAt", "reviewedAt", "createdAt", "updatedAt"
        )
        SELECT
            'backfill-' || d.id,
            d."userId",
            'APPROVED'::"DoctorApplicationStatus",
            u.name,
            u.phone,
            d."licenseNumber",
            d.specialization,
            d."departmentId",
            d."yearsExperience",
            d."consultationFee",
            d.availability,
            d."createdAt",
            d."createdAt",
            d."createdAt",
            d."updatedAt"
        FROM doctors d
        JOIN users u ON u.id = d."userId"
        WHERE NOT EXISTS (
            SELECT 1 FROM doctor_applications a WHERE a."userId" = d."userId"
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS doctor_application_documents")
    op.execute("DROP TABLE IF EXISTS doctor_applications")
    op.execute("DROP TABLE IF EXISTS trusted_devices")
    op.execute("DROP TABLE IF EXISTS two_factor_challenges")

    for column, _definition in USER_COLUMNS:
        op.execute(f"ALTER TABLE users DROP COLUMN IF EXISTS {column}")

    for type_name in NEW_TYPES:
        op.execute(f'DROP TYPE IF EXISTS "{type_name}"')

    # The values added to AuditAction and NotificationType are deliberately left
    # in place. Postgres cannot remove an enum value without rewriting the type,
    # and rows already recorded as DOCTOR_APPLICATION_APPROVED must not be
    # rewritten to say something else — the audit log is append-only in both
    # directions (see revision 0005).
    #
    # ``emailVerifiedAt`` is also left as backfilled: it is true, and undoing it
    # would be discarding a fact rather than reversing a change.
