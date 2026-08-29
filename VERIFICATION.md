# Requirement verification

Phase 15. Every claim below was checked against the running system — the live
database, the registered routes, the executed test suite — rather than read off
a checklist. Where something is incomplete or carries a known limitation, it
says so.

The spec's rule for this phase: *"Do not mark a requirement complete simply
because the UI exists. Verify the complete backend workflow."*

## Definition of done (§45)

A feature counts as complete only with all of: UI · API · database ·
authorization · validation · error handling · audit logging where required ·
tests written · tests passing · no secrets committed.

---

## R1 — Real-time vital monitoring and doctor alerts

| | |
|---|---|
| **API** | 8 endpoints under `/api/vitals` and `/api/alerts`, including `GET /api/alerts/stream` (SSE) |
| **Database** | `vitals`, `vital_thresholds`, `alerts`; two unique indexes verified present in the live database |
| **Authorization** | Writes need `vital:write`; reads go through `require_clinical_access`, so an administrator is refused |
| **Validation** | Plausibility bounds reject device faults (900 bpm) while storing clinical extremes (250 bpm); inverted blood pressure and future timestamps refused |
| **Audit** | `VITAL_RECORDED` and `VITAL_ALERT`, recording which vitals were taken and never their values (C5) |
| **UI** | `/patient/vitals`, `/doctor/alerts`, and the recording form on the doctor's chart |
| **Tests** | 91 — `test_thresholds.py` (34), `test_vitals_integration.py` (43), `vitals.test.tsx` (14) |

**Verified specifics.** A patient's own threshold overrides the hospital default
(C9). An ongoing breach produces one alert, not one per reading, while a
*worsening* breach escalates the open alert. The reading is persisted before it
is judged, so a threshold misconfiguration can cost an alert but never a
measurement.

**Known limitation.** The SSE fan-out is in-process. A multi-worker deployment
would deliver each event only to subscribers on the worker that produced it; the
fix is a shared bus, and Postgres `LISTEN/NOTIFY` is unavailable because the
Supabase transaction pooler does not carry notifications. The dashboard refetches
on reconnect, so the gap costs latency rather than correctness.

---

## R2 — Secure role-based patient data access

| | |
|---|---|
| **API** | 14 endpoints across records, prescriptions, patients, documents |
| **Database** | `doctor_patient_assignments` with a unique `(doctorId, patientId)` index, verified present |
| **Authorization** | Permissions are a catalogue, and row access is decided separately by `resolve_patient_access` |
| **Validation** | Pydantic on every payload; patient identity comes from the session, never the URL or body |
| **Audit** | `PATIENT_RECORD_VIEW`; refusals recorded as `ACCESS_DENIED` at `SECURITY` severity |
| **UI** | `/patient/records`, `/doctor/patients` |
| **Tests** | 98 across `test_rbac.py`, `test_authorization_integration.py`, `test_records_integration.py`, `test_access_control_review.py` |

**The load-bearing distinction.** Clinical access is *narrower* than patient
access. `resolve_patient_access` answers "may this caller touch this file at
all", and an administrator passes it — they hold `patient:read:any` so they can
correct a misspelled name. Records and prescriptions accept only four of its five
answers, and `ADMIN` is not among them. An administrator gets 403 on a diagnosis.

**Verified in the catalogue, not just in handlers.** `test_access_control_review`
asserts that administrators hold no clinical read permission, nurses hold no
standing patient access, and patients hold no clinical write — properties of
`ROLE_PERMISSIONS` itself, so they cannot be lost by editing one endpoint.

---

## R3 — Controlled emergency override with logging

| | |
|---|---|
| **API** | 5 endpoints under `/api/emergency` |
| **Database** | `emergency_access` with reason, expiry, access count, review fields |
| **Authorization** | `emergency:request` to open; the holder or `emergency:review` to revoke; `emergency:review` alone to review |
| **Validation** | Reason must be at least 15 characters — a keystroke is not an explanation |
| **Audit** | `EMERGENCY_ACCESS_GRANTED`, `_USED` per read, `_REVOKED`, all at `BREAK_GLASS` severity |
| **UI** | `/no-dashboard` (the nurse's only screen), `/admin/emergency` (review queue) |
| **Tests** | 37 — `test_emergency_integration.py` (23), `emergency.test.tsx` (14) |

**The deliberate design.** A grant is issued **immediately, without approval**.
Break-glass that waits for an administrator has failed at the moment it exists
for, and staff who cannot get in during an emergency start sharing logins —
which defeats every control here rather than just this one. Control comes from
making misuse expensive: one patient, a short clock, a counted and audited read
trail, a notification to the patient, and a mandatory review.

Expiry is enforced **at the moment of use**, never by a sweeper — a sweeper that
stopped running would silently extend every outstanding grant. The grant id rides
in the access token, but the token is a *pointer*: the grant is re-read on every
request, so revocation takes effect on the next call.

---

## R4 — Automatic billing after consultation

| | |
|---|---|
| **API** | 5 endpoints under `/api/invoices`; generation is triggered by consultation completion, not by a billing call |
| **Database** | `invoices` with **`invoices_appointmentId_key` unique** and `invoices_invoiceNumber_key` unique — both verified present in the live database; `invoice_number_seq` sequence |
| **Authorization** | `invoice:read:own` for patients, `invoice:read:any` and `invoice:manage` for administrators; doctors hold none |
| **Validation** | Void and credit note both require a reason; payment refused on a voided invoice |
| **Audit** | `INVOICE_CREATED`, `INVOICE_UPDATED` with the operation and amount |
| **UI** | `/patient/billing`, `/admin/billing` |
| **Tests** | 33 — `test_billing_integration.py` (25), `billing.test.tsx` (8) |

**Idempotency is the database's, not the application's.** Two concurrent
completions cannot both insert, because the loser hits the unique index rather
than an application check it might have raced past. The insert runs inside a
`SAVEPOINT`: without one, losing that race would poison the surrounding
transaction and turn a duplicate invoice into a *lost consultation*. A test
inserts a second invoice directly, bypassing the endpoint entirely, and asserts
the database refuses it.

Invoice numbers come from a Postgres sequence. `count(*) + 1` is a race with the
unique index at the end of it.

---

## R5 — Real-time authorized doctor record updates

| | |
|---|---|
| **API** | `/api/records`, `/api/records/{id}` |
| **Database** | `medical_records` with author, amendment timestamps |
| **Authorization** | `record:write`, which no patient role holds; amendment restricted to the authoring doctor |
| **Validation** | Field limits; an amendment cannot blank a diagnosis |
| **Audit** | `PATIENT_RECORD_CREATE`, `PATIENT_RECORD_UPDATE`, recording which fields changed and never their values |
| **UI** | `/doctor/patients/[id]` |
| **Tests** | Covered within the 98 above, `test_records_integration.py` |

An amended record is marked as amended rather than silently rewritten. The
one-second threshold exists because `created_at` and `updated_at` are stamped by
separate calls, and a record written across a millisecond boundary would
otherwise report itself amended the moment it was created.

---

## R6 — Append-only audit logging

| | |
|---|---|
| **API** | `GET /api/audit-logs` and `GET /api/audit-logs/verify`. **No POST, PUT, PATCH or DELETE exists** |
| **Database** | `audit_logs`, hash-chained; `userId` deliberately not a foreign key |
| **Authorization** | `audit:read`, held only by administrators — asserted in the catalogue test |
| **Audit** | Reading the trail is itself recorded, as `AUDIT_VIEWED` |
| **UI** | `/admin/audit`, with a chain-verification control |
| **Tests** | `test_audit_chain.py`, plus catalogue assertions that no write route exists |

**Verified against the live database, not asserted:**

```
entries              5,123
chain valid          True
unhashed rows        0
distinct hashes      5,123   (no collisions)
security events      304
```

And, crucially, the check is capable of failing: recomputing one entry's hash
with a single field altered produces a different hash. A verifier that always
returned `True` would pass the first test identically; this is what separates
tamper-*evident* from tamper-*claimed*.

`userId` is not a foreign key on purpose. This was confirmed by deleting a test
account: its audit entry survived with attribution intact. The trail has to
outlive its subject.

---

## R7 — Patient self-service portal

| | |
|---|---|
| **API** | 14 endpoints across appointments, assistant, notifications, plus records, documents and billing above |
| **Database** | Appointments carry `slotKey` under a **unique index, verified present** |
| **Authorization** | Every patient endpoint scopes to the session's patient id; a `patientId` in a body is ignored, not compared |
| **Validation** | Availability windows, lead times, double-booking, plausibility |
| **Audit** | Appointment lifecycle, AI interactions, document access |
| **UI** | 8 patient routes: overview, appointments, records, documents, vitals, billing, assistant |
| **Tests** | 80 across appointments and assistant, plus the UI suites |

Double booking is prevented by the database: `slotKey = "<doctorId>|<ISO start>"`
under a unique index. A read-then-write availability check alone would leave
exactly the race the requirement names.

---

## R8 — Two-minute inactivity timeout

**Verified against the running application:**

```
SHARED_TERMINAL     120s     <- the required rule
PERSONAL            900s
MONITOR             exempt while view-only
UNRECOGNISED        120s     <- unknown class falls to the strictest tier
absolute cap        43,200s
```

Enforced server-side against `Session.lastSeenAt`, not by a client timer. A
client that never fires its timeout — or a script calling the API directly — is
still cut off. The countdown in `AppShell` is a courtesy so a clinician does not
lose a half-written note; the server expires the session whether or not it ever
renders.

**Tests:** 30 across `test_session_policy.py`, `test_auth_flow_integration.py`,
`AppShell.test.tsx`.

---

## Feature areas

| Area | State | Evidence |
|---|---|---|
| AI assistant | done | Deterministic triage runs *before* the provider and cannot be overruled downward; diagnosis phrasings rewritten; a medication not on the patient's own list is stripped; disclaimer is a required field |
| Voice | done | Browser speech-to-text; audio never reaches the server; transcript editable before extraction; provenance recorded as `AI_ASSISTED` vs `PATIENT_REPORTED` |
| OCR | done | Gemini vision with PaddleOCR fallback; engine recorded per document; nothing reaches a chart without a doctor confirming it |
| Document storage | done | Supabase Storage. **Both buckets verified private** (`medical-documents=false, avatars=false`); URLs are signed and expire |
| Appointments | done | Unique `slotKey`; full lifecycle |
| Billing | done | See R4 |
| Notifications | done | In-app and email; the email deliberately says *less* than the in-app message |
| RBAC | done | Permission catalogue with breadth suffixes, plus separate row-level access |
| Audit | done | See R6 |

**Note on the spec's "Cloudinary".** The spec names Cloudinary for file storage;
this build uses **Supabase Storage**, because the database is already Supabase
and adding a second vendor for the same job would mean a second set of
credentials, a second failure mode and a second audit surface. The requirement —
private storage with time-limited access to medical documents — is met.

---

## No secrets committed

The whole history was scanned, not just the working tree: a secret removed in a
later commit is still in the history and still compromised.

```
commits scanned        8
unique blobs           265
distinct paths         232
.env ever committed    NO
```

One match surfaced and was run down: a JWT-shaped string in
`server/tests/unit/tokens.test.ts`, in the since-deleted Express backend.
Decoding it gives `{"sub":"user_1","role":"ADMIN"}` with a signature that is the
base64 of the literal text `fake-signature` — a deliberately invalid token used
to prove foreign tokens are rejected. Not a credential.

Both live credentials were rotated on 2026-08-29 and verified working: the
Gemini key returns structured JSON, and SMTP authenticates against Gmail.

---

## Full suite result

```
675 passed · 1 failed · 2 skipped · 1h 52m
```

The three non-passes were all the same thing: the AI provider's quota running
out *during* the run. Two tests skipped on a clean 429. The third failed —
and that failure was worth having, because it exposed a gap in the guard I
added in Phase 12.

`ai_enabled` probes the provider before a test runs and skips if it cannot
answer. But the probe and the call are two separate requests, so an account can
pass the probe and be rate-limited a second later. That is exactly what happened:
one test got the fallback's empty result and asserted against it as though the
provider had replied.

Fixed by checking the response as well as the probe: a reply carrying
`provider_unavailable` means the provider did not answer, and there is nothing to
assert about an answer that was never given. The fallback's own behaviour is
covered separately by tests that run with AI switched off and therefore always
execute.

One provider test deliberately keeps no guard —
`test_the_model_cannot_talk_an_emergency_down`. Its whole point is that the
deterministic layer produces `EMERGENCY` whether or not the provider answered, so
skipping it on a fallback would skip the assertion that matters most.

**Every non-AI test passed.** Nothing in the application failed; all three
non-passes were the external provider's quota.

## What this phase found

Verification is only worth doing if it can fail. It did.

**`test_access_control_review` was inspecting two endpoints, not eighty-seven.**
It iterated `app.routes`, which in this FastAPI version holds `_IncludedRouter`
wrappers rather than the flattened module routes — so three security tests were
passing over an effectively empty list. Fixed by walking `original_router`
recursively; the checks now cover all 87 `/api` routes and immediately surfaced
two endpoints worth examining (both turned out correct, and both are now
documented rather than assumed).

The same trap had already been hit once, in Phase 10, when enumerating routes
returned twenty entries with no paths. Knowing about it did not prevent writing a
test that fell into it — which is the argument for this phase existing.

Two smaller findings: the exemption list named routes that do not exist
(`/api/auth/heartbeat`, `/api/auth/password-reset`) while missing the real ones,
and a stray control character had been written into a regex, silently disabling
it.

And the fourth, from the suite itself: the provider skip-guard had a
probe-then-call race, described above.

---

## Known limitations, stated rather than hidden

- **Malware scanning is not implemented.** No scanner is available in this
  environment. `files.scan_hook` marks where one attaches rather than implying
  protection that does not exist.
- **Rate limiting counts per process.** A multi-worker deployment allows roughly
  one budget per worker. It is a cost and noise control; the defences that must
  not be bypassable — account lockout, authorization, audit — are all in the
  database.
- **SSE fan-out is per process.** See R1.
- **At-rest field encryption is not implemented.** Transport is TLS and the
  database is access-controlled, but individual clinical columns are not
  separately encrypted.
- **No PDF generation.** `GET /invoices/{id}` returns the full invoice and the
  client renders a printable view; a route named `/download` that emitted
  something other than a document would be worse than none.
- **Seeded clinical thresholds are conventional, not approved.** The spec
  requires real thresholds to be "validated against the project's clinical
  requirements". They exist so alerting is on before anyone configures it, not so
  nobody has to.
