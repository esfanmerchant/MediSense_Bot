"""The terms people agree to, and the version they agreed to.

**Held on the server, not in the client.** Consent is only meaningful if the
system can say *what* was agreed to, and a document that lives only in a React
component cannot be quoted back six months later. The text and its version live
here; the client renders what this returns.

**The version is the whole mechanism.** ``TERMS_VERSION`` is stamped on the user
when they accept, so a later change to the wording does not silently claim the
agreement of everybody who signed up before it. Bumping it is a deliberate act
that means "this needs agreeing to again" — which is why it is a date rather
than a number nobody can place.

The text is deliberately plain. A hospital's users include people who are ill,
worried, and reading on a phone; a wall of legal boilerplate they cannot parse
is consent in form only, and this system's whole posture — the audit trail, the
break-glass review, the AI that refuses to diagnose — is undermined by asking
somebody to tick a box they had no chance of understanding.
"""

from __future__ import annotations

from typing import Any

#: The version stamped on a user's acceptance. A date, so anybody reading an
#: audit entry can place it. Bump this only when the *substance* changes —
#: fixing a typo and forcing every user in the hospital to re-consent is how a
#: consent screen becomes something people click through without reading.
TERMS_VERSION = "2026-09-03"


class Section:
    """One heading and its paragraphs."""

    def __init__(self, heading: str, body: list[str]) -> None:
        self.heading = heading
        self.body = body

    def as_dict(self) -> dict[str, Any]:
        return {"heading": self.heading, "body": self.body}


TERMS: list[Section] = [
    Section(
        "What MediSense is",
        [
            "MediSense connects patients with doctors: you can find a doctor, book "
            "an appointment, keep your medical records in one place, and pay for "
            "your visits.",
            "MediSense is not a medical provider. The doctors on this platform are "
            "independent practitioners responsible for their own clinical decisions. "
            "We provide the software they and you use.",
        ],
    ),
    Section(
        "The assistant does not diagnose",
        [
            "The AI assistant answers questions about your own records and helps you "
            "decide what to do next. It will not tell you what condition you have, "
            "and it is not a substitute for seeing a doctor.",
            "If anything you describe sounds serious, the assistant will say so and "
            "direct you to a clinician rather than reassure you.",
            "In an emergency, do not use this platform. Go to the nearest emergency "
            "department or call for help.",
        ],
    ),
    Section(
        "Your records and who can see them",
        [
            "Your medical records are visible to you and to the clinicians treating "
            "you. Administrators can see billing and account information, not your "
            "diagnoses.",
            "A clinician may open your record in an emergency without your prior "
            "consent. Every such access is recorded, time-limited, and reviewed by "
            "an administrator afterwards.",
            "Every access to a medical record is written to an audit trail that "
            "cannot be edited or deleted, including by us.",
        ],
    ),
    Section(
        "Paying, and being paid",
        [
            "Consultation fees are set by each doctor. MediSense adds a platform fee "
            "and any tax that applies; both are shown on your invoice before you pay.",
            "Invoices are due within three days. After that a single late charge is "
            "added — once, not per day.",
            "Payments are made by transfer to the account shown on your bill and "
            "confirmed by a person at MediSense. Uploading a screenshot is not "
            "payment: your bill is settled when we have checked the money arrived.",
            "Doctors are paid the consultation fee. They may withdraw their balance "
            "once it reaches the minimum shown in their portal.",
        ],
    ),
    Section(
        "If a bill is not paid",
        [
            "We will remind you the day before an invoice is due and again once it "
            "is overdue. Both go to your portal and, unless you have turned it off, "
            "to your email and your devices.",
            "An overdue invoice may pause new bookings on your account. It does not "
            "stop you seeing your own records, and it never stops emergency care — "
            "a doctor treating you in an emergency is not shown your balance.",
            "If an invoice remains unpaid after it is due, MediSense may recover the "
            "amount owed, together with the late charge and any reasonable costs of "
            "recovery. That may include instructing a collections agent or beginning "
            "civil proceedings in the courts of Pakistan.",
            "We will write to you at the email address on your account before taking "
            "either step, and we will tell you the amount, what it is for, and how "
            "long you have to settle it. If you think an invoice is wrong, tell us "
            "before it falls due — while a query you have raised is open we will not "
            "begin recovery on it.",
            "Nothing here changes your right to be treated. Non-payment is a debt "
            "between you and MediSense; it is not a clinical matter and is not "
            "recorded in your medical record.",
        ],
    ),
    Section(
        "What we ask of you",
        [
            "Give accurate information about yourself. A medical record built on "
            "wrong details is dangerous to the person it belongs to.",
            "Use your own account. Do not share your password or let anybody else "
            "use your session.",
            "Doctors must hold a current registration and upload genuine "
            "credentials. Practising without one is a criminal matter, not only a "
            "breach of these terms.",
            "Do not use MediSense to harass anybody, to obtain medication "
            "improperly, or to access records that are not yours.",
        ],
    ),
    Section(
        "Community guidelines",
        [
            "Treat clinicians and staff with respect. Abusive messages to a doctor "
            "or through the assistant are grounds for suspension.",
            "Do not upload anything that is not yours to upload — another person's "
            "records, documents, or identity papers.",
            "Do not attempt to break, probe, or overload the platform. Security "
            "research is welcome; tell us rather than testing on real patients.",
            "Cancel appointments you cannot attend. A slot you hold and do not use "
            "is a slot somebody who needed it could not book.",
        ],
    ),
    Section(
        "Suspension",
        [
            "We may suspend an account that breaks these terms. Suspension ends "
            "access immediately and the reason is recorded.",
            "Suspension does not delete your medical records. They are kept because "
            "they are part of your care history, and because a hospital that can "
            "make somebody's treatment disappear is a hospital nobody should trust.",
            "If you believe a suspension was wrong, contact us and it will be "
            "reviewed by a person.",
        ],
    ),
    Section(
        "Changes to these terms",
        [
            f"These are version {TERMS_VERSION}. If we change them in a way that "
            "matters, we will ask you to agree again the next time you sign in.",
            "You can read the current version at any time from your portal.",
        ],
    ),
]


def as_dict() -> dict[str, Any]:
    """The document, for the API and for the consent dialog."""
    return {
        "version": TERMS_VERSION,
        "sections": [section.as_dict() for section in TERMS],
    }
