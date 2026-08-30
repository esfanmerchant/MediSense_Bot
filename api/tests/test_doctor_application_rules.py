"""The rules of a doctor application that need no database to check.

What a qualification year may be, how a qualification reads once it has been
approved into free text, and which credential files a submission is still short
of — all pure, so every case is checked here rather than one at a time through
HTTP. ``test_doctor_application_integration.py`` drives the same rules through
the real endpoints.

The property worth stating plainly about the years: **the draft model does not
judge them.** This form autosaves on a debounce while somebody is typing, so a
person entering 2015 sends 2, then 20, then 201; a range check on the field
would refuse each of those saves and tell them their draft was lost. So
``Qualification`` takes any integer, ``qualification_issues`` asks whether they
are real years once at submit, and the renderer degrades rather than guesses.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.db.enums import DoctorDocumentKind
from app.modules.doctor_applications.schemas import Qualification
from app.modules.doctor_applications.service import (
    MIN_QUALIFICATION_YEAR,
    REQUIRED_DOCUMENTS,
    max_qualification_year,
    missing_documents,
    qualification_issues,
    render_qualification,
    render_qualifications,
)

#: The en dash a year range takes, written as an escape because in source an
#: en dash and a hyphen look alike.
DASH = "\u2013"


class TestTheYearsAreOptional:
    @pytest.mark.parametrize(
        "payload",
        [
            {"title": "MRCP"},
            {"title": "MRCP", "startYear": None},
            {"title": "MRCP", "endYear": None},
            {"title": "MRCP", "startYear": None, "endYear": None},
            {"title": "MRCP", "startYear": 2015},
            {"title": "MRCP", "endYear": 2020},
        ],
    )
    def test_a_qualification_parses_with_any_of_its_years_absent(self, payload: dict) -> None:
        parsed = Qualification.model_validate(payload)
        assert parsed.title == "MRCP"

    @pytest.mark.parametrize("half_typed", [2, 20, 201, 1492, 99999])
    def test_the_draft_model_accepts_a_year_it_would_never_store(self, half_typed: int) -> None:
        """A year is only wrong if it is still wrong at submit.

        This is the seam the autosave depends on: every keystroke on the way to
        2015 has to parse, or a debounced save refuses and the person is told
        their draft was lost over a digit.
        """
        parsed = Qualification.model_validate({"title": "MBBS", "startYear": half_typed})
        assert parsed.start_year == half_typed

    def test_the_draft_model_accepts_years_that_run_backwards(self) -> None:
        """Because 2020 is a perfectly good prefix of an end year typed second."""
        parsed = Qualification.model_validate(
            {"title": "MBBS", "startYear": 2020, "endYear": 2015}
        )
        assert (parsed.start_year, parsed.end_year) == (2020, 2015)

    def test_the_title_is_what_is_actually_required(self) -> None:
        with pytest.raises(ValidationError):
            Qualification.model_validate({"startYear": 2015, "endYear": 2020})

    def test_a_blank_title_is_not_a_title(self) -> None:
        with pytest.raises(ValidationError):
            Qualification.model_validate({"title": "   "})

    def test_the_title_is_stripped(self) -> None:
        assert Qualification.model_validate({"title": "  MBBS  "}).title == "MBBS"

    def test_a_bare_string_is_no_longer_a_qualification(self) -> None:
        """The shape changed, and the old one has to fail loudly rather than pass."""
        with pytest.raises(ValidationError):
            Qualification.model_validate("MBBS, King Edward Medical University")


class TestTheYearsAreJudgedAtSubmit:
    """``qualification_issues`` is where a year finally has to be a year."""

    @pytest.mark.parametrize("year", [1950, 1987, 2020])
    def test_a_plausible_year_raises_nothing(self, year: int) -> None:
        assert qualification_issues([{"title": "MBBS", "startYear": year}]) == []

    @pytest.mark.parametrize("year", [0, 19, 195, 1949, 3000])
    def test_a_year_below_the_floor_or_beyond_the_ceiling_is_reported(self, year: int) -> None:
        issues = qualification_issues([{"title": "MBBS", "startYear": year}])
        assert len(issues) == 1
        # Named for the step the client sends them back to.
        assert issues[0]["field"] == "qualifications"
        # The message has to say what a year may be, and which entry is wrong.
        assert str(MIN_QUALIFICATION_YEAR) in issues[0]["message"]
        assert "MBBS" in issues[0]["message"]

    def test_the_ceiling_leaves_room_for_a_course_in_progress(self) -> None:
        """A five-year degree started this year finishes well after it."""
        this_year = datetime.now(UTC).year
        assert max_qualification_year() >= this_year + 5
        assert qualification_issues([{"title": "MBBS", "endYear": this_year + 5}]) == []

    def test_the_year_after_the_ceiling_is_reported(self) -> None:
        assert qualification_issues([{"title": "MBBS", "endYear": max_qualification_year() + 1}])

    def test_a_qualification_cannot_end_before_it_starts(self) -> None:
        issues = qualification_issues([{"title": "MBBS", "startYear": 2020, "endYear": 2015}])
        assert len(issues) == 1
        assert issues[0]["field"] == "qualifications"
        assert "start year" in issues[0]["message"].lower()

    def test_one_typo_earns_one_complaint(self) -> None:
        """Out of range *and* out of order is two things to say about one mistake."""
        issues = qualification_issues([{"title": "MBBS", "startYear": 3000, "endYear": 2015}])
        assert len(issues) == 1
        assert str(MIN_QUALIFICATION_YEAR) in issues[0]["message"]

    def test_starting_and_ending_in_the_same_year_is_fine(self) -> None:
        """A one-year diploma is a real thing."""
        assert qualification_issues([{"title": "Diploma", "startYear": 2019, "endYear": 2019}]) == []

    def test_only_the_year_that_is_present_is_judged(self) -> None:
        """An impossible pair cannot be formed out of one year and a blank."""
        assert qualification_issues([{"title": "MBBS", "startYear": 2020, "endYear": None}]) == []
        assert qualification_issues([{"title": "MBBS", "startYear": None, "endYear": 2015}]) == []

    def test_an_entry_with_no_years_at_all_is_nothing_to_report(self) -> None:
        assert qualification_issues([{"title": "MRCP"}]) == []

    def test_every_bad_entry_is_named_not_just_the_first(self) -> None:
        issues = qualification_issues(
            [
                {"title": "MBBS", "startYear": 1500},
                {"title": "FCPS Cardiology", "startYear": 2020, "endYear": 2015},
                {"title": "MRCP", "startYear": 2001, "endYear": 2004},
            ]
        )
        assert len(issues) == 2
        assert "MBBS" in issues[0]["message"]
        assert "FCPS Cardiology" in issues[1]["message"]

    def test_a_row_written_before_the_years_existed_is_skipped(self) -> None:
        """A pre-migration string has no year to be wrong about."""
        assert qualification_issues(["MBBS, King Edward", None, 42]) == []

    def test_a_titleless_entry_is_still_described(self) -> None:
        """The message is read on its own, so it cannot start with a blank."""
        issues = qualification_issues([{"title": "", "startYear": 1500}])
        assert issues and issues[0]["message"].startswith("This qualification")


class TestTheStoredShape:
    def test_it_speaks_the_same_camel_case_the_api_does(self) -> None:
        stored = Qualification.model_validate(
            {"title": "MBBS", "startYear": 2015, "endYear": 2020}
        ).as_stored()
        assert stored == {"title": "MBBS", "startYear": 2015, "endYear": 2020}

    def test_absent_years_are_stored_as_null_rather_than_dropped(self) -> None:
        """A key that is present and null is a claim; a missing key is a guess."""
        assert Qualification.model_validate({"title": "MRCP"}).as_stored() == {
            "title": "MRCP",
            "startYear": None,
            "endYear": None,
        }


class TestRenderingForTheDoctorRow:
    """``Doctor.qualifications`` is free text, so the list collapses into one line."""

    @pytest.mark.parametrize(
        ("entry", "expected"),
        [
            (
                {"title": "MBBS", "startYear": 2015, "endYear": 2020},
                f"MBBS (2015{DASH}2020)",
            ),
            # An end year alone is a year of completion.
            ({"title": "MBBS", "startYear": None, "endYear": 2020}, "MBBS (2020)"),
            # A start year alone is open-ended: the course is still being taken.
            ({"title": "FCPS", "startYear": 2024, "endYear": None}, f"FCPS (2024{DASH})"),
            ({"title": "MRCP", "startYear": None, "endYear": None}, "MRCP"),
            ({"title": "MRCP"}, "MRCP"),
        ],
    )
    def test_a_missing_year_degrades_rather_than_hides_the_entry(
        self, entry: dict, expected: str
    ) -> None:
        assert render_qualification(entry) == expected

    def test_the_separator_is_an_en_dash(self) -> None:
        """A year range is a range, not a subtraction."""
        rendered = render_qualification({"title": "MBBS", "startYear": 2015, "endYear": 2020})
        assert DASH in rendered
        assert "-" not in rendered

    def test_the_title_is_stripped_on_the_way_out_too(self) -> None:
        assert render_qualification({"title": " MBBS ", "endYear": 2020}) == "MBBS (2020)"

    @pytest.mark.parametrize(
        "entry",
        [
            {"startYear": 2015, "endYear": 2020},
            {"title": ""},
            {"title": None},
            None,
            42,
        ],
    )
    def test_an_entry_with_no_title_renders_to_nothing(self, entry: object) -> None:
        assert render_qualification(entry) == ""

    def test_a_row_written_before_the_years_existed_still_reads(self) -> None:
        """The column is JSONB, so a pre-migration row must not fail an approval."""
        assert render_qualification("MBBS, King Edward") == "MBBS, King Edward"

    def test_the_list_joins_in_the_order_it_was_given(self) -> None:
        assert render_qualifications(
            [
                {"title": "MBBS", "startYear": 2010, "endYear": 2015},
                {"title": "FCPS Cardiology", "startYear": 2016},
                {"title": "MRCP"},
            ]
        ) == f"MBBS (2010{DASH}2015), FCPS Cardiology (2016{DASH}), MRCP"

    def test_entries_that_render_to_nothing_leave_no_gap(self) -> None:
        """Otherwise the column reads "MBBS, , MRCP" and looks like data loss."""
        assert render_qualifications([{"title": "MBBS"}, {"title": ""}, {"title": "MRCP"}]) == (
            "MBBS, MRCP"
        )

    @pytest.mark.parametrize("entries", [[], [{"title": ""}]])
    def test_nothing_to_say_is_none_rather_than_an_empty_string(self, entries: list) -> None:
        """The column should say "not stated", not "stated to be blank"."""
        assert render_qualifications(entries) is None


class TestTheRequiredDocuments:
    """An administrator cannot verify a claim without the files behind it."""

    def test_all_four_kinds_are_required(self) -> None:
        assert set(REQUIRED_DOCUMENTS) == set(DoctorDocumentKind)

    def test_nothing_attached_means_every_kind_is_missing(self) -> None:
        assert missing_documents([]) == [str(kind) for kind in REQUIRED_DOCUMENTS]

    def test_all_four_attached_means_nothing_is_missing(self) -> None:
        assert missing_documents(list(DoctorDocumentKind)) == []

    @pytest.mark.parametrize("absent", list(DoctorDocumentKind))
    def test_one_kind_short_names_that_kind_and_no_other(
        self, absent: DoctorDocumentKind
    ) -> None:
        held = [kind for kind in DoctorDocumentKind if kind is not absent]
        assert missing_documents(held) == [str(absent)]

    def test_a_second_copy_of_a_kind_satisfies_nothing_else(self) -> None:
        """Replacing a certificate is normal; it does not stand in for a photo."""
        certificate = DoctorDocumentKind.REGISTRATION_CERTIFICATE
        assert missing_documents([certificate, certificate]) == [
            str(kind) for kind in REQUIRED_DOCUMENTS if kind is not certificate
        ]

    def test_the_order_is_fixed_rather_than_whatever_was_uploaded(self) -> None:
        """So the client points at the first gap in the same place every time."""
        shuffled = [DoctorDocumentKind.PHOTO, DoctorDocumentKind.DEGREE]
        assert missing_documents(shuffled) == ["REGISTRATION_CERTIFICATE", "NATIONAL_ID"]
