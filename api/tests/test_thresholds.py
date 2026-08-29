"""The threshold engine (spec §16-17).

No network, no database. This is the code that decides whether a reading is
worth waking somebody for, so both failure directions are tested deliberately:

* a **missed** breach is a patient deteriorating unnoticed;
* a **spurious** breach is one more alarm in a ward that already has too many,
  and alarm fatigue is not a nuisance — it is how a real alert gets ignored.

Neither is "the safe direction". They are different harms and the engine has to
avoid both, which is why the sustained-reading rule is tested as carefully as
the breach rule itself.
"""

from __future__ import annotations

import pytest

from app.db.enums import AlertSeverity, VitalType
from app.modules.vitals.thresholds import (
    PLAUSIBLE,
    Threshold,
    applicable,
    breaches,
    evaluate,
    is_plausible,
)


def rule(
    vital_type: VitalType = VitalType.HEART_RATE,
    minimum: float | None = 50,
    maximum: float | None = 120,
    severity: AlertSeverity = AlertSeverity.WARNING,
    sustained: int = 1,
    patient_specific: bool = False,
) -> Threshold:
    return Threshold(
        vital_type=vital_type,
        min_value=minimum,
        max_value=maximum,
        severity=severity,
        sustained_readings=sustained,
        patient_specific=patient_specific,
    )


class TestPlausibility:
    """The spec's "validate reading" step: is this a measurement at all?"""

    @pytest.mark.parametrize(
        ("vital_type", "value"),
        [
            (VitalType.HEART_RATE, 72),
            # A real emergency, and it must be storable. Refusing extreme-but-
            # possible values would discard exactly the readings that matter.
            (VitalType.HEART_RATE, 250),
            (VitalType.OXYGEN_SATURATION, 100),
            (VitalType.TEMPERATURE, 41.5),
        ],
    )
    def test_possible_readings_are_accepted(self, vital_type: VitalType, value: float) -> None:
        assert is_plausible(vital_type, value)

    @pytest.mark.parametrize(
        ("vital_type", "value"),
        [
            (VitalType.HEART_RATE, 900),  # sensor fault
            (VitalType.HEART_RATE, 0),  # detached lead, not asystole-by-API
            (VitalType.OXYGEN_SATURATION, 140),  # impossible by definition
            (VitalType.TEMPERATURE, 3),  # a room, not a person
            (VitalType.RESPIRATORY_RATE, 0),
        ],
    )
    def test_impossible_readings_are_refused(self, vital_type: VitalType, value: float) -> None:
        assert not is_plausible(vital_type, value)

    def test_every_vital_type_has_bounds(self) -> None:
        # A type added to the enum without bounds would raise KeyError on the
        # first reading, in the validator, on a live ward.
        assert set(PLAUSIBLE) == set(VitalType)


class TestBreachDetection:
    def test_a_value_inside_the_range_is_not_a_breach(self) -> None:
        assert breaches(rule(), 72) is None

    def test_both_directions_are_reported_distinctly(self) -> None:
        assert breaches(rule(), 40) == "LOW"
        assert breaches(rule(), 150) == "HIGH"

    def test_the_bounds_themselves_are_acceptable(self) -> None:
        # A threshold of "50" means 50 is allowed. Off-by-one here would alert
        # on every patient sitting exactly on a round number.
        assert breaches(rule(), 50) is None
        assert breaches(rule(), 120) is None

    def test_a_one_sided_rule_only_constrains_its_side(self) -> None:
        # Oxygen saturation has a floor and no ceiling; there is no such thing
        # as too much of it.
        oxygen = rule(VitalType.OXYGEN_SATURATION, minimum=92, maximum=None)
        assert breaches(oxygen, 88) == "LOW"
        assert breaches(oxygen, 100) is None


class TestWhichRuleApplies:
    def test_the_hospital_default_is_used_when_nothing_else_exists(self) -> None:
        found = applicable([rule()], VitalType.HEART_RATE)
        assert found is not None and not found.patient_specific

    def test_a_patients_own_rule_wins(self) -> None:
        """Conflict C9: a COPD patient's ordinary saturation is not an emergency.

        A ward that alarms every time they breathe is a ward that stops
        listening, so the personal rule must beat the hospital's rather than
        merely being consulted alongside it.
        """
        hospital = rule(VitalType.OXYGEN_SATURATION, minimum=92, maximum=None)
        personal = rule(
            VitalType.OXYGEN_SATURATION, minimum=85, maximum=None, patient_specific=True
        )

        for order in ([hospital, personal], [personal, hospital]):
            found = applicable(order, VitalType.OXYGEN_SATURATION)
            assert found is personal, "order of rows must not decide the outcome"

    def test_an_unconfigured_vital_has_no_rule(self) -> None:
        assert applicable([rule()], VitalType.TEMPERATURE) is None


class TestEvaluate:
    def test_a_normal_reading_raises_nothing(self) -> None:
        assert evaluate(VitalType.HEART_RATE, [72], [rule()]) is None

    def test_a_breaching_reading_is_reported_with_its_rule(self) -> None:
        breach = evaluate(VitalType.HEART_RATE, [150], [rule()])
        assert breach is not None
        assert breach.direction == "HIGH"
        assert breach.value == 150
        assert breach.severity == AlertSeverity.WARNING

    def test_an_unconfigured_vital_never_alerts(self) -> None:
        """And that is a configuration gap, not a clean reading.

        The service logs it; the engine's job is only to refuse to invent a
        limit nobody set.
        """
        assert evaluate(VitalType.TEMPERATURE, [41.0], [rule()]) is None

    def test_no_readings_is_not_a_breach(self) -> None:
        assert evaluate(VitalType.HEART_RATE, [], [rule()]) is None

    def test_the_patient_rule_governs_the_outcome(self) -> None:
        rules = [
            rule(VitalType.OXYGEN_SATURATION, minimum=92, maximum=None),
            rule(
                VitalType.OXYGEN_SATURATION, minimum=85, maximum=None, patient_specific=True
            ),
        ]
        # 88 breaches the hospital floor but not this patient's.
        assert evaluate(VitalType.OXYGEN_SATURATION, [88], rules) is None
        assert evaluate(VitalType.OXYGEN_SATURATION, [80], rules) is not None


class TestSustainedReadings:
    """One reading is not a trend, and a trend must not be missed."""

    def test_a_single_breach_does_not_fire_when_two_are_required(self) -> None:
        assert evaluate(VitalType.HEART_RATE, [150], [rule(sustained=2)]) is None

    def test_two_consecutive_breaches_fire(self) -> None:
        assert evaluate(VitalType.HEART_RATE, [150, 145], [rule(sustained=2)]) is not None

    def test_a_normal_reading_in_between_breaks_the_run(self) -> None:
        # Newest first: breach, then normal. Not sustained.
        assert evaluate(VitalType.HEART_RATE, [150, 72], [rule(sustained=2)]) is None

    def test_insufficient_history_stays_quiet(self) -> None:
        """A patient's very first reading cannot be a sustained breach.

        Staying quiet is right: the next reading will have the history. Firing
        early would defeat the setting at the exact moment it is meant to work.
        """
        assert evaluate(VitalType.HEART_RATE, [150], [rule(sustained=3)]) is None

    def test_oscillating_across_a_limit_is_not_sustained(self) -> None:
        """A value crossing the band in both directions is a probe problem.

        Both readings breach *something*, but not the same bound — counting that
        as sustained would mean alerting on noise.
        """
        assert evaluate(VitalType.HEART_RATE, [150, 40], [rule(sustained=2)]) is None

    def test_only_the_required_number_of_readings_is_examined(self) -> None:
        # Older normal readings beyond the window are irrelevant; the run of two
        # is what the rule asked for.
        assert (
            evaluate(VitalType.HEART_RATE, [150, 145, 72, 68], [rule(sustained=2)]) is not None
        )

    def test_zero_is_treated_as_one(self) -> None:
        # Defensive: a misconfigured 0 must not mean "never alert".
        assert evaluate(VitalType.HEART_RATE, [150], [rule(sustained=0)]) is not None


class TestMessages:
    def test_it_names_the_vital_the_value_and_the_limit(self) -> None:
        breach = evaluate(VitalType.HEART_RATE, [150], [rule()])
        assert breach is not None
        message = breach.message()
        assert "Heart rate" in message
        assert "150" in message
        assert "120" in message
        assert "bpm" in message

    def test_it_says_which_way_the_value_went(self) -> None:
        """"Outside range" makes the reader work out which, when they can least
        afford to."""
        assert "above" in evaluate(VitalType.HEART_RATE, [150], [rule()]).message()
        assert "below" in evaluate(VitalType.HEART_RATE, [40], [rule()]).message()

    def test_whole_numbers_are_not_written_as_decimals(self) -> None:
        # A heart rate is 52, not 52.0.
        message = evaluate(VitalType.HEART_RATE, [40.0], [rule()]).message()
        assert "40.0" not in message
        assert "40" in message

    def test_a_personal_limit_says_so(self) -> None:
        """The reader needs to know whether this is the ward's rule or this
        patient's, because it changes what the number means."""
        personal = rule(minimum=60, maximum=100, patient_specific=True)
        assert "this patient's" in evaluate(VitalType.HEART_RATE, [150], [personal]).message()
        assert "this patient's" not in evaluate(VitalType.HEART_RATE, [150], [rule()]).message()

    def test_every_vital_type_can_be_described(self) -> None:
        from app.modules.vitals.thresholds import LABELS, UNITS

        assert set(LABELS) == set(VitalType)
        assert set(UNITS) == set(VitalType)
