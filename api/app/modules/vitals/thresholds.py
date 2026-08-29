"""The threshold engine (spec §16-17).

Pure functions over values. No database, no session, no clock — which is what
makes the one piece of this system that decides whether to wake a doctor at 3am
exhaustively testable.

Three rules shape everything here.

**Thresholds are data, never literals.** Spec §17 is explicit: "do not hardcode
thresholds throughout the application". Every number this module compares
against arrives as a ``Threshold`` read from ``vital_thresholds``. The only
constants below are *plausibility* limits — the range within which a number is a
measurement at all rather than a broken sensor — and those are a different
question from whether a measurement is concerning.

**A patient's own threshold beats the hospital's.** A COPD patient lives at a
saturation that would be an emergency in anyone else, and a ward that alarms
every time they breathe is a ward that stops listening to alarms (conflict C9).

**One reading is not a trend.** A detached probe reads zero; a cuff moved mid-
measurement reads nonsense. ``sustained_readings`` says how many consecutive
breaching readings it takes before this is worth a person's attention, and the
engine will not fire until it has actually seen them.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.db.enums import AlertSeverity, VitalType

#: Physiologically possible ranges — the limits of what could be a measurement
#: rather than a fault. Deliberately far wider than any alerting threshold: a
#: heart rate of 250 is a genuine emergency and must be *stored*, while 900 is a
#: sensor error and must be refused before it reaches the chart. Rejecting a
#: real extreme value would be far worse than accepting an odd one, so these
#: bounds are generous on purpose.
PLAUSIBLE: dict[VitalType, tuple[float, float]] = {
    VitalType.HEART_RATE: (10, 300),
    VitalType.SYSTOLIC_BP: (40, 300),
    VitalType.DIASTOLIC_BP: (20, 200),
    VitalType.OXYGEN_SATURATION: (50, 100),
    VitalType.TEMPERATURE: (25, 45),
    VitalType.RESPIRATORY_RATE: (3, 80),
}

#: How each vital is written when a person reads the alert.
UNITS: dict[VitalType, str] = {
    VitalType.HEART_RATE: "bpm",
    VitalType.SYSTOLIC_BP: "mmHg",
    VitalType.DIASTOLIC_BP: "mmHg",
    VitalType.OXYGEN_SATURATION: "%",
    VitalType.TEMPERATURE: "°C",
    VitalType.RESPIRATORY_RATE: "breaths/min",
}

LABELS: dict[VitalType, str] = {
    VitalType.HEART_RATE: "Heart rate",
    VitalType.SYSTOLIC_BP: "Systolic blood pressure",
    VitalType.DIASTOLIC_BP: "Diastolic blood pressure",
    VitalType.OXYGEN_SATURATION: "Oxygen saturation",
    VitalType.TEMPERATURE: "Temperature",
    VitalType.RESPIRATORY_RATE: "Respiratory rate",
}


@dataclass(frozen=True)
class Threshold:
    """One configured rule, as read from the database."""

    vital_type: VitalType
    min_value: float | None
    max_value: float | None
    severity: AlertSeverity
    sustained_readings: int
    #: True when this row belongs to one patient rather than the hospital.
    patient_specific: bool


@dataclass(frozen=True)
class Breach:
    vital_type: VitalType
    value: float
    threshold: Threshold
    #: "LOW" or "HIGH" — which bound was crossed. Both are abnormal, and a
    #: message that only ever says "outside range" makes a reader work out
    #: which, at the moment they can least afford to.
    direction: str

    @property
    def severity(self) -> AlertSeverity:
        return self.threshold.severity

    def message(self) -> str:
        label = LABELS[self.vital_type]
        unit = UNITS[self.vital_type]
        bound = self.threshold.min_value if self.direction == "LOW" else self.threshold.max_value
        comparison = "below" if self.direction == "LOW" else "above"
        scope = "this patient's" if self.threshold.patient_specific else "the"
        return (
            f"{label} {_number(self.value)} {unit} is {comparison} {scope} "
            f"configured limit of {_number(bound)} {unit}."
        )


def _number(value: float | None) -> str:
    """Render without a trailing ``.0`` — a heart rate is 52, not 52.0."""
    if value is None:
        return "—"
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def is_plausible(vital_type: VitalType, value: float) -> bool:
    """Whether this could be a measurement at all.

    The "validate reading" step of the spec's architecture. A value outside
    these bounds is a device or entry fault; storing it would corrupt the trend
    a clinician reads, and alerting on it would train them to ignore alerts.
    """
    low, high = PLAUSIBLE[vital_type]
    return low <= value <= high


def applicable(thresholds: list[Threshold], vital_type: VitalType) -> Threshold | None:
    """The rule that governs this vital, patient overrides winning.

    Returns ``None`` when nothing is configured, which the caller must treat as
    "no rule" rather than "no problem" — an unconfigured vital is a gap in the
    configuration, not a clean reading.
    """
    candidates = [rule for rule in thresholds if rule.vital_type == vital_type]
    for rule in candidates:
        if rule.patient_specific:
            return rule
    return candidates[0] if candidates else None


def breaches(threshold: Threshold, value: float) -> str | None:
    """Which bound this value crosses, or ``None``.

    Bounds are independently optional: oxygen saturation has a floor and no
    ceiling, because there is no such thing as too much of it.
    """
    if threshold.min_value is not None and value < threshold.min_value:
        return "LOW"
    if threshold.max_value is not None and value > threshold.max_value:
        return "HIGH"
    return None


def evaluate(
    vital_type: VitalType,
    recent_values: list[float],
    thresholds: list[Threshold],
) -> Breach | None:
    """Decide whether this reading warrants an alert.

    ``recent_values`` is newest first and *includes* the reading being judged,
    so index 0 is the new measurement and the rest are its immediate history.

    A breach only counts once ``sustained_readings`` consecutive readings have
    all crossed the same bound. Requiring the same direction matters: a value
    oscillating across a limit is a probe problem, and calling it a sustained
    breach would mean alerting on noise.
    """
    if not recent_values:
        return None

    rule = applicable(thresholds, vital_type)
    if rule is None:
        return None

    direction = breaches(rule, recent_values[0])
    if direction is None:
        return None

    needed = max(1, rule.sustained_readings)
    if len(recent_values) < needed:
        # Not enough history to know it is sustained. Staying quiet is right:
        # the next reading will have the history, and firing early would defeat
        # the setting the moment it matters.
        return None
    if not all(breaches(rule, value) == direction for value in recent_values[:needed]):
        return None

    return Breach(vital_type=vital_type, value=recent_values[0], threshold=rule, direction=direction)
