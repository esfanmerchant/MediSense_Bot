"""Vital threshold defaults, and the index that keeps them unambiguous.

Two changes, both about the same question: *which rule governs this reading?*

**The partial unique index.** ``vital_thresholds_vitalType_patientId_key``
cannot constrain the hospital defaults, because those rows have a NULL
``patientId`` and Postgres permits any number of NULLs under a unique index.
Without this second, partial index a duplicate hospital default for one vital
would be accepted and the answer would depend on row order.

**The seeded rows.** Spec §17 requires thresholds to be configurable rather than
hardcoded, and they are — these are ordinary rows an authorised user edits
through the API. But shipping with none configured would mean shipping with
alerting silently switched off, which is a far worse default than a
conservative starting set.

These are conventional adult observation ranges and are **not** clinically
approved for any particular ward: the spec is explicit that real thresholds must
be "configurable by authorized hospital personnel and validated against the
project's clinical requirements". They exist so the feature is on before anyone
configures it, not so nobody has to.

``sustainedReadings`` is 1 throughout, which suits how readings arrive here:
each one is a deliberate measurement, minutes or hours apart, not a sample from
a continuous stream. A deployment attaching real bedside monitors should raise
it — that is what the setting is for, and 1 would alert on every detached probe.

Revision ID: 0003_vital_threshold_defaults
Revises: 0002_ocr_engine_paddle
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003_vital_threshold_defaults"
down_revision: str | None = "0002_ocr_engine_paddle"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: (vitalType, min, max, severity). NULL bounds are one-sided on purpose —
#: there is no such thing as too much oxygen saturation.
DEFAULTS: list[tuple[str, float | None, float | None, str]] = [
    ("HEART_RATE", 50, 120, "WARNING"),
    ("SYSTOLIC_BP", 90, 180, "WARNING"),
    ("DIASTOLIC_BP", 50, 110, "WARNING"),
    ("OXYGEN_SATURATION", 92, None, "CRITICAL"),
    ("TEMPERATURE", 35.0, 38.5, "WARNING"),
    ("RESPIRATORY_RATE", 10, 24, "WARNING"),
]


def upgrade() -> None:
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS "vital_thresholds_hospital_default_key"
        ON vital_thresholds ("vitalType")
        WHERE "patientId" IS NULL
        """
    )

    # Bound parameters rather than an f-string. These values are module
    # constants so interpolation would be safe today, but a migration is exactly
    # the kind of file someone later edits to take a value from elsewhere.
    insert = sa.text(
        """
        INSERT INTO vital_thresholds
            (id, "vitalType", "patientId", "minValue", "maxValue",
             severity, enabled, "sustainedReadings", "createdAt", "updatedAt")
        SELECT
            :id, CAST(:vital_type AS "VitalType"), NULL, :minimum, :maximum,
            CAST(:severity AS "AlertSeverity"), true, 1,
            now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc'
        WHERE NOT EXISTS (
            SELECT 1 FROM vital_thresholds
            WHERE "vitalType" = CAST(:vital_type AS "VitalType") AND "patientId" IS NULL
        )
        """
    )

    bind = op.get_bind()
    for vital_type, minimum, maximum, severity in DEFAULTS:
        # Seeded only where nothing is configured. Re-running must never
        # overwrite a threshold a clinician has since tuned.
        bind.execute(
            insert,
            {
                "id": f"seed-threshold-{vital_type.lower().replace('_', '-')}",
                "vital_type": vital_type,
                "minimum": minimum,
                "maximum": maximum,
                "severity": severity,
            },
        )


def downgrade() -> None:
    # Only the untouched seed rows are removed. A threshold an administrator has
    # edited is their configuration now, and a downgrade of this migration is
    # not a reason to discard it.
    op.execute(
        """
        DELETE FROM vital_thresholds
        WHERE id LIKE 'seed-threshold-%' AND "patientId" IS NULL AND "updatedAt" = "createdAt"
        """
    )
    op.execute('DROP INDEX IF EXISTS "vital_thresholds_hospital_default_key"')
