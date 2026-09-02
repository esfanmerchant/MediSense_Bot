"""Pulling a booking request out of what the model wrote.

The parser is the join between a language model and a real appointment, so the
cases that matter are the ones where a model is approximately right: extra
spaces, a lowercase keyword, a sentence wrapped around it. A brittle match turns
"it booked nothing" into a silent failure nobody can explain.

The one thing it must never do is leave the machine line in the reply. A patient
shown `BOOK: doctor=...` is being shown the plumbing.
"""

from __future__ import annotations

import pytest

from app.services import assistant


class TestFindingTheRequest:
    def test_a_well_formed_line_is_read(self) -> None:
        answer, intent = assistant.extract_booking(
            "I found a time with Dr Rajesh Iyer.\nBOOK: doctor=Rajesh Iyer; date=2026-09-04"
        )
        assert intent == ("Rajesh Iyer", "2026-09-04")
        assert answer == "I found a time with Dr Rajesh Iyer."

    @pytest.mark.parametrize(
        "line",
        [
            "BOOK: doctor=Rajesh Iyer; date=2026-09-04",
            "book: doctor=Rajesh Iyer; date=2026-09-04",
            "BOOK:doctor=Rajesh Iyer;date=2026-09-04",
            "BOOK :  doctor =  Rajesh Iyer ;  date = 2026-09-04  ",
        ],
    )
    def test_spacing_and_case_do_not_break_it(self, line: str) -> None:
        # A model reproduces a format approximately. Insisting on one exact
        # spelling is how this silently stops working.
        _, intent = assistant.extract_booking(f"Here you go.\n{line}")
        assert intent == ("Rajesh Iyer", "2026-09-04")

    def test_the_machine_line_never_survives_into_the_reply(self) -> None:
        answer, _ = assistant.extract_booking(
            "Theek hai.\nBOOK: doctor=Neha Kulkarni; date=2026-09-10"
        )
        assert "BOOK" not in answer
        assert answer == "Theek hai."

    def test_an_ordinary_answer_is_left_exactly_alone(self) -> None:
        original = "Metformin is usually taken after food. Ask your doctor before changing it."
        answer, intent = assistant.extract_booking(original)
        assert intent is None
        assert answer == original

    def test_only_the_first_request_is_honoured(self) -> None:
        # A model proposing two bookings has misunderstood, and acting on both
        # would put two appointments in front of somebody who asked for one.
        answer, intent = assistant.extract_booking(
            "One.\nBOOK: doctor=A One; date=2026-09-04\nBOOK: doctor=B Two; date=2026-09-05"
        )
        assert intent == ("A One", "2026-09-04")
        assert "BOOK" not in answer

    def test_a_malformed_date_is_not_a_booking(self) -> None:
        # The line has to be a date the resolver can parse; "next Tuesday" is
        # the model failing to do the one mechanical part asked of it.
        answer, intent = assistant.extract_booking(
            "Sure.\nBOOK: doctor=Rajesh Iyer; date=next Tuesday"
        )
        assert intent is None
        # And because it did not match, the text stays — the sentence the model
        # wrote is still worth reading.
        assert "Sure." in answer

    def test_the_word_book_in_a_sentence_is_not_a_request(self) -> None:
        original = "You can book an appointment from the appointments page."
        answer, intent = assistant.extract_booking(original)
        assert intent is None
        assert answer == original


class TestWhatTheModelIsTold:
    def test_the_platform_brief_is_in_every_context(self) -> None:
        # Asked "how does billing work", a model with no brief invents a policy
        # that sounds plausible and is wrong.
        context = assistant.build_context(
            active_medications=[], upcoming_appointments=[], specialities=[]
        )
        assert "ABOUT MEDISENSE" in context
        assert "3 days" in context

    def test_the_patient_is_named_and_described(self) -> None:
        context = assistant.build_context(
            patient_name="Ayesha Khan",
            patient_facts=["Patient's age: 34", "Patient's allergies: penicillin"],
            active_medications=["Metformin 500mg after dinner"],
            upcoming_appointments=[],
            specialities=["Cardiology"],
        )
        assert "Ayesha Khan" in context
        assert "penicillin" in context

    def test_doctors_are_listed_one_per_line(self) -> None:
        # A comma-joined run becomes unreadable at twenty doctors and the model
        # starts quoting fragments of the wrong one.
        context = assistant.build_context(
            active_medications=[],
            upcoming_appointments=[],
            specialities=[],
            doctors=["Rajesh Iyer — Cardiology — Aga Khan, Karachi — PKR 3000"],
        )
        assert "  - Rajesh Iyer — Cardiology" in context

    def test_no_doctors_is_stated_rather_than_omitted(self) -> None:
        context = assistant.build_context(
            active_medications=[], upcoming_appointments=[], specialities=[]
        )
        assert "Doctors available to book: none listed" in context
