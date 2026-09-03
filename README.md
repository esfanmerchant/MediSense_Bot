# MediSense — Smart Healthcare Management System

A secure hospital platform with three primary roles (Admin, Doctor, Patient), a
patient self-service portal, an AI health assistant with voice symptom input,
OCR for uploaded prescriptions and reports, real-time vitals monitoring with
doctor alerts, automated billing, break-glass emergency access, and an
append-only audit trail.

> **Clinical safety.** The AI assistant provides preliminary guidance only. It
> never issues a diagnosis, and nothing it produces enters the medical record
> without a doctor's explicit attestation.

---

## Stack

| Layer | Choice |
|---|---|
| API | Python 3.13 · FastAPI · SQLAlchemy 2 (async) · Alembic, in `api/` |
| Client | Next.js App Router · React · TypeScript · Tailwind, in `client/` |
| Data | Supabase Postgres (asyncpg over the transaction pooler) |
| Auth | Custom: httpOnly cookie JWT + server-side session rows, scrypt hashing |
| Storage | Supabase Storage, private buckets with short-lived signed URLs |
| OCR | Gemini vision (with consent) · PaddleOCR PP-OCRv5 locally otherwise |
| AI | Google Gemini — vision extraction, chatbot, symptom triage |
| Tests | pytest + httpx TestClient |

Supabase supplies the database and file storage. It does **not** supply
authentication: Supabase Auth has no idle-timeout concept, and R8 requires the
server to end a session after two minutes of inactivity, so sessions are owned
by this application. The service role key is server-side only and never reaches
the browser.

## Getting started

```powershell
# 1. Secrets
cp .env.example .env          # fill in the Supabase values (see below)

# 2. API
python -m venv api\.venv
api\.venv\Scripts\python.exe -m pip install -e "api[dev]"
cd api; ..\api\.venv\Scripts\python.exe -m alembic upgrade head; cd ..
npm run dev:api               # http://localhost:4000  (docs at /docs)

# 3. Client
npm --prefix client install
npm run dev                   # http://localhost:3000
```

Full command list: [api/Makefile.md](api/Makefile.md).

### Supabase values

| Variable | Where |
|---|---|
| `DATABASE_URL` | Connect → ORMs → Prisma (pooled, port 6543) |
| `DIRECT_URL` | Connect → ORMs → Prisma (direct, port 5432) — migrations only |
| `SUPABASE_URL` | Project Settings → API |
| `SUPABASE_PUBLISHABLE_KEY` | Project Settings → API — safe in the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API — **server only**, bypasses RLS |

Both connection strings are needed: the transaction pooler cannot run DDL, so
migrations use the direct connection while runtime queries use the pool. A
password containing `@` must be percent-encoded as `%40`.

### Email delivery

Verification codes, two-factor codes and the doctor-application notices all go
out through one SMTP transport (`api/app/services/email.py`). Without these the
application still runs, and a one-time code stays reachable: with no transport
configured, and only outside production, the code is written to the API log
(`email_code_not_delivered_logged_instead`) so a developer can finish a sign-up
without a mail server. In production it is not logged — an operator who turned
delivery off has said the code should not go anywhere.

| Variable | Meaning |
|---|---|
| `EMAIL_ENABLED` | `false` disables delivery entirely; nothing is sent and nothing fails |
| `SMTP_HOST` / `SMTP_PORT` | The relay. Gmail is `smtp.gmail.com` / `587` |
| `SMTP_SECURE` | `true` for implicit TLS (port 465); `false` starts TLS on 587 |
| `SMTP_USER` / `SMTP_PASSWORD` | For Gmail this must be an **app password**, not the account's own |
| `SMTP_FROM` | The visible sender, e.g. `MediSense <no-reply@medisense.pk>` |

Mail is never allowed to fail an operation: `send` returns a `Delivery` and
raises nothing, so a slow relay cannot become a slow appointment booking.

#### Staying out of the spam folder

Most of what decides where a message lands is settled before anybody reads it.
What the code does about that:

| | |
|---|---|
| `From` is forced to the authenticated account | A `From` the sending server is not authorised for fails SPF and DKIM, and is the single fastest way into a spam folder. A mismatched `SMTP_FROM` is overridden and logged rather than honoured |
| `Message-ID`, `Date`, `Reply-To` | A message missing these looks assembled by a script, because usually it is |
| `List-Unsubscribe` + `List-Unsubscribe-Post` | One-click unsubscribe, required of bulk senders by Gmail and Yahoo since 2024. It is honest: no session, no password, and `POST /api/notifications/unsubscribe` acts on a sealed token |
| A footer that names the sender and says why the message arrived | Both in the HTML and in the plain-text part |
| Plain text alongside every HTML message | An HTML-only message is less accessible and more likely to be junked |
| No images, no tracking pixel | Nothing to load, nothing to block, and no open-tracking to look like bulk mail |
| No `X-Priority`, no `Importance`, no `Precedence: bulk` | Claiming urgency on routine mail reads as a sender jumping a queue |

Codes and break-glass notices carry **no** unsubscribe. A one-time code is the
only way into an account and a security notice is not switchable, so offering
to stop either would be an offer this system will not honour — and an
unhonoured offer is what the header is checked against in the first place.

**The rest is DNS, and only you can do it.** Nothing above outweighs sending
from a domain that authenticates. Today the sender is a `@gmail.com` address,
which passes SPF and DKIM because Gmail signs its own outgoing mail — but it
identifies the hospital as a personal mailbox, and a free Gmail account is
capped at roughly 500 recipients a day.

To do better, move to a domain you own and publish three records:

* **SPF** — `v=spf1 include:<your provider> -all`
* **DKIM** — the key your provider gives you, so each message is signed
* **DMARC** — start at `v=DMARC1; p=none; rua=mailto:you@yourdomain`, read the
  reports for a fortnight, then tighten to `p=quarantine` and later `p=reject`

Then set `SMTP_FROM` to an address at that domain — and `SMTP_USER` to an
account there, because the two must match or the alignment above kicks in and
sends from the wrong one. `EMAIL_SENDER_IDENTITY` should name the clinic and
its address; the default is generic, and a real postal identity in the footer
is worth more than any header.

`CLIENT_ORIGIN` must be the public URL. Every email link is built from it, and
a `localhost` unsubscribe in real mail is a dead link — worse than none,
because somebody who presses it and gets nothing reports the message instead.
The API logs an error at startup if that is the case in production.

### Push notifications and medication reminders

A push is the only channel that reaches somebody who is not looking at the
site, which is what a reminder to take a tablet has to do. Unlike an email it
is **encrypted to the device before it leaves this server** — the keys come
from the browser at subscribe time, and Google's, Apple's or Mozilla's push
service in the middle routes ciphertext it cannot open. That is what makes it
acceptable for a reminder to name a medicine, and why an email never does.

| Variable | Meaning |
|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | The keypair that identifies this server to a push service. Both empty means push is simply off |
| `VAPID_SUBJECT` | A `mailto:` a push service can complain to before it starts dropping messages |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | The public half again, for the browser. It must match, or every subscription is rejected on send |

Generate a pair with:

```bash
python -c "from py_vapid import Vapid01; import base64; \
  from cryptography.hazmat.primitives import serialization as s; \
  v=Vapid01(); v.generate_keys(); b=lambda x: base64.urlsafe_b64encode(x).decode().rstrip('='); \
  print('pub ', b(v.public_key.public_bytes(s.Encoding.X962, s.PublicFormat.UncompressedPoint))); \
  print('priv', b(v.private_key.private_numbers().private_value.to_bytes(32,'big')))"
```

**Push is the default channel; email is the exception.** A push is cheap to
receive and cheap to dismiss, so every notification type reaches a device. An
inbox is not, and a sender that mails about every small thing is one people
filter out — which costs the messages that mattered. So `EMAILED_TYPES` in
`api/app/modules/notifications/templates.py` is the short list: money, a booked
time, your record being opened, your account changing hands, and the welcome
that says the account exists.

**Each account chooses its channels** at *Settings → Notifications*
(`PATCH /api/account/notifications`). The in-app list is not switchable — it is
the record that somebody was told. Two types ignore both switches and the page
says so plainly: a break-glass access to your record, and a change to your
account's security. Turning email off means "stop telling me about
appointments"; it does not mean "do not tell me if somebody opened my medical
record", and the person who would want that silenced is not the patient.

**Today's doses are a to-do list that resets by itself.**
`GET /api/medication-reminders/today` is the active reminders joined to the
ticks recorded against the clinic-local date, so at midnight the same query
returns the same doses with nothing ticked. Nothing runs at 00:00 to clear it —
a nightly job is one more thing that can fail while everybody is asleep and
leave somebody looking at yesterday. A tick is a note to self; it is not
evidence a medicine was swallowed and no clinician is shown it.

**Reminder times come from the patient, never from the prescription.** A
prescription's `frequency` is prose — "twice a day", "after meals", "SOS" — and
turning that into 08:00 would be a guess. A notification saying *take your
Metformin now* at an hour nobody chose is a confidently wrong instruction about
medicine, so `PUT /api/medication-reminders/{prescriptionId}` takes times the
patient set on their own record, in the clinic's timezone, and only the patient
may set them. Discontinuing the medicine stops the reminders in the same pass,
without deleting anything.

### Running more than one worker

Two things in the API are exactly correct in one process and wrong in four: the
rate limiter counts per worker, and the live vitals feed fans out per worker, so
an alert reaches only the browsers connected to whichever worker recorded the
vital. Setting `REDIS_URL` fixes both — one sliding window across all workers,
and a channel each worker relays events back from.

| Variable | Meaning |
|---|---|
| `REDIS_URL` | Optional. Empty is a supported configuration and the right one for a single worker |

An unreachable Redis is treated as absent, not as an outage: every call falls
back to the in-process behaviour rather than failing the request.

### Codes, sessions and the clinic clock

| Variable | Meaning |
|---|---|
| `SESSION_SECRET` | Signs sessions **and** derives the key that seals TOTP secrets at rest — rotating it invalidates both |
| `JWT_SECRET` | Signs access tokens |
| `CLINIC_TIMEZONE` | The wall clock every schedule is written in. `Asia/Karachi` |

Verification and two-factor codes are six digits, stored only as a hash, valid
for ten minutes, and burned after five wrong attempts. A trusted device is a
hashed token in an httpOnly cookie that lasts thirty days — and is refused
outright when the sign-in declared a shared terminal.

Uploaded application documents live in the same private Supabase Storage
bucket the rest of the system uses; nothing is public, and every read is a
short-lived signed URL.

### Identity at registration

Every account gives a CNIC when it registers, whatever role it holds. It is
stored as thirteen digits — the dashes people type are thrown away, so two
people who typed it differently are one value in the column.

**It is an identifier, never a credential.** Sign-in remains email and
password. A CNIC is printed on a card people hand to shopkeepers; a system that
let it open an account would be one whose accounts open with something
everybody already has.

The column is nullable and the API requires it. Accounts that existed before it
was asked for have none, and a NOT NULL with a made-up default would put a fake
identity number on a real person's record — worse than a gap, because a gap is
visibly a gap.

### Demo accounts

All fictional, all sharing the password `Demo@Pass123`.

| Email | Role |
|---|---|
| `doctor@example.com` | Doctor — Cardiology, treats Priya and Vikram |
| `doctor3@example.com` | Doctor — General Medicine, treats Meera |
| `patient@example.com` | Patient — Priya Sharma |
| `nurse@example.com` | Nurse — emergency access only, no dashboard |

**There is no demo administrator.** The system runs one administrator, and it
is a real account, so its password is not in this file. The integration tests
that act as one read `TEST_ADMIN_EMAIL` and `TEST_ADMIN_PASSWORD` from the
environment and skip when those are unset — a skip rather than a failure,
because a missing credential is not a broken endpoint.

```bash
TEST_ADMIN_EMAIL=you@example.org TEST_ADMIN_PASSWORD=...   .venv/Scripts/python.exe -m pytest tests/test_authorization_integration.py
```

Several demo accounts are currently `SUSPENDED` in the database and cannot sign
in, which fails the integration tests that use them. Reactivating them is an
administrator's decision, not something a test run should make for itself.

## Project layout

```
api/
├── alembic/                   # migrations; 0001 is the schema baseline
└── app/
    ├── core/                  # config, errors, logging, security, session policy
    ├── db/                    # engine, models, enums
    ├── api/                   # dependencies (auth, RBAC, resource access)
    ├── modules/
    │   ├── auth/              # login, sessions, RBAC catalogue
    │   ├── audit/             # append-only, hash-chained log; read-only router
    │   ├── emergency/         # break-glass grant, revoke, review
    │   ├── users/             # admin user management, care assignments
    │   ├── patients/          # profile, roster, consent
    │   ├── doctors/           # directory and caseload
    │   ├── departments/
    │   ├── appointments/      # availability grid, booking, lifecycle
    │   ├── records/           # clinical history + the clinical access gate
    │   ├── prescriptions/     # medication, discontinued never deleted
    │   ├── documents/         # upload, metadata, signed retrieval
    │   ├── assistant/         # health assistant, symptom review
    │   ├── vitals/            # readings, threshold engine, alerts, SSE
    │   ├── billing/           # invoices, credit notes
    │   ├── notifications/     # in-app + email, templates, dispatcher loop
    │   └── dashboard/         # one summary per role
    ├── services/              # storage, upload validation, extraction, AI safety
    └── main.py
client/src/
├── app/                       # login, patient, doctor, admin
├── components/                # AppShell, UI primitives, assistant
└── lib/                       # api client, session + inactivity timer, speech
ocr/                           # PaddleOCR feasibility harness
```

Business logic lives in `modules/*/service.py`. Routers translate HTTP to
service calls and nothing more.

## Tests

Two tiers, because they answer different questions at very different speeds.

**Fast tier — under a second, run on every change:**

```
cd api && .venv/Scripts/python.exe -m ruff check . && .venv/Scripts/python.exe -m mypy app
cd api && .venv/Scripts/python.exe -m pytest -q --ignore-glob="*_integration.py"
npm run verify        # client typecheck, lint, UI tests, build
```

That is every test that does not need the database — about 725 of them, in
twenty seconds. The exclusion is the point: `*_integration.py` is the tier
below.

`mypy` earns its place here: it caught three of the four Phase 10 defects in
seconds, where the database suite needed eighteen minutes to surface the same
class of bug — a wrong attribute on a model or an enum.

**Full tier — around 1h45m, run before a release:**

```
cd api && .venv/Scripts/python.exe -m pytest
```

It is slow for one reason: the Supabase database is in Tokyo and every query
costs a measured ~149 ms round-trip. The work is almost entirely waiting, not
computing.

**UI tests** (`client/src/**/*.test.tsx`) run in jsdom and cover the safety
properties that exist only on the client and that no server-side test can reach:
that the AI disclaimer is always rendered and cannot be dismissed, that an
emergency is announced to assistive technology rather than merely coloured, that
a currency amount is never parsed into a float, that describing symptoms saves
nothing on its own, and that a breaching vital is marked in words as well as in
colour.

## API conventions

Success: `{"success": true, "data": …}`, with `meta` on paginated lists.
Failure — always this shape, never a stack trace:

```json
{
  "success": false,
  "error": { "code": "FORBIDDEN_RESOURCE", "message": "You do not have access to this patient's data." },
  "requestId": "b1f0…"
}
```

Every response carries `X-Request-Id`, and audit entries record the same id, so
a security event traces back to the exact request.

## Security model

**Authentication.** Tokens live in `httpOnly` cookies, so injected page script
cannot read them. The JWT proves identity; the `Session` row decides whether the
caller is still allowed in.

**Session expiry (R8).** Enforced server-side against `Session.lastSeenAt`, not
by a client timer — a client that never fires its timeout, or a script calling
the API directly, is still cut off. Refreshing does not extend an idle session.
Timeouts are tiered by device class:

| Device class | Idle limit |
|---|---|
| `SHARED_TERMINAL` | **2 minutes** — the required rule, kept where the threat is |
| `PERSONAL` | 15 minutes |
| `MONITOR` | exempt while view-only; any action requires re-authentication |

An unrecognised device class falls back to the strictest tier.

**Authorization.** Roles are bundles of permissions
([`rbac.py`](api/app/modules/auth/rbac.py)), which is what makes `NURSE` a data
change rather than a refactor. A permission is never authorization for a
specific row: `resolve_patient_access` separately checks that the caller owns
the record, has a care relationship (assignment or encounter), or holds an
active break-glass grant for exactly that patient. Patient identity comes from
the session, never the URL. Denials are audited as security events.

Admins deliberately hold no clinical read permission — they manage the hospital,
and the patient endpoint omits allergies and conditions for them.

**Clinical access is narrower than patient access** ([`records/access.py`](api/app/modules/records/access.py)).
`resolve_patient_access` answers "may this caller touch this patient's file at
all", and an administrator passes it. Records and prescriptions accept only four
of its five answers — `SELF`, `ASSIGNED_DOCTOR`, `TREATING_DOCTOR`,
`EMERGENCY_ACCESS` — so an admin who can see tomorrow's bookings still gets 403
on a diagnosis. `EMERGENCY_ACCESS` is in that list on purpose: gating clinical
reads on standing permissions alone would make break-glass useless for the one
thing it exists for (R3).

**Audit (R6).** `record_audit()` is the only write path; there is no update or
delete counterpart. Entries are hash-chained under a Postgres advisory lock, so
a row edited or removed directly in the database fails `verify_audit_chain()`.
`AuditLog.userId` is deliberately not a foreign key: the trail must outlive its
subject. Metadata holds references — field names, record ids — never clinical
values. In deployment, also revoke write access:

```sql
REVOKE UPDATE, DELETE ON audit_logs FROM medisense_app;
```

**Double booking (§14).** Every appointment holding a slot carries
`slotKey = "<doctorId>|<ISO start>"` under a unique index, so two concurrent
bookings for one slot cannot both commit — the loser raises `IntegrityError`,
which becomes `SLOT_UNAVAILABLE`. A read-then-write availability check alone
would leave exactly the race the requirement names. The column is nullable and
Postgres allows many NULLs in a unique index, so cancelling releases the slot by
clearing the key, with no free/busy table and no cleanup job.

**Documents (§25-27).** Buckets are private and there is no public URL for a
medical document. `GET /documents/{id}/download` mints a link only after the
clinical access check passes; it expires in five minutes and minting it is
audited, so possessing an id — or an old link — is not access (conflict C8).
Uploads are identified by their **magic number**, not by the browser's
`Content-Type` or the extension in the filename, both of which the caller
controls; a declared type that disagrees with the bytes is rejected outright.
Object paths are `{patientId}/{documentId}{ext}`, every part generated here, so
a crafted filename cannot traverse out of its prefix. Deletion is soft: a
document a clinician already read is part of what informed their decision.

Malware scanning is **not** implemented — no scanner is available in this
environment, and `files.scan_hook` marks where one would attach rather than
implying protection that does not exist.

**Document reading (§23-24).** Two engines, and the choice between them is a
privacy decision before a quality one. A **vision model** reads handwriting and
layout far better than classical OCR — and sending the document to Google is
exactly what AI consent covers, so it runs only for patients who granted it
(conflict C2). Everyone else gets **local PaddleOCR**, which keeps the file
inside the deployment. Withdrawing consent degrades the feature; it never
removes it. Which engine ran is recorded per document, because their failure
modes differ: PaddleOCR garbles characters, a vision model produces fluent text
that may not be on the page.

Against invention, the vision path requires a verbatim `sourceText` per
medication — a fabricated entry has to fabricate its evidence too, next to which
it is visible — reports legibility per line, and returns `null` rather than a
plausible default. Nothing reaches a chart without a doctor confirming it, and
even a confirmed reading is not a prescription: a doctor still writes that
(conflict C7).

**The health assistant (§18-21).** A language model sits in the middle of a
safety path, so it is bracketed by two layers it cannot argue with. **Before**
the provider is called, [`triage.py`](api/app/services/triage.py) classifies
urgency from the patient's own words with regular expressions and nothing else.
**After** it replies, [`assistant.py`](api/app/services/assistant.py) reconciles
the two — and the rule is one-directional: the model may *raise* urgency, never
lower it. A model that decides crushing chest pain sounds like indigestion
cannot turn an escalation into reassurance, which is what "do not provide false
reassurance" has to mean in code.

The same pass removes what the model must not say. Diagnosis phrasings ("you
have X") are rewritten into "a doctor would need to assess whether…"; a
medication named in the answer that is not on the patient's own prescription
list is stripped outright, because that is the one output that could directly
cause harm if acted on. Every answer carries the disclaimer as a required field,
so no client can render guidance without it. Each intervention is recorded, so
the rate of model misbehaviour is measurable rather than invisible.

Losing the provider does not lose the safety net: an outage falls back to the
deterministic result, and an emergency is still escalated. That path runs on
every test run, because it is the one that has to hold when things go wrong.

Symptoms the patient describes are a **proposal until they correct it** (§20).
`POST /assistant/symptoms` writes nothing; `POST /assistant/symptoms/confirm`
stores the corrected list as `ReportedSymptom` rows carrying their provenance —
`PATIENT_REPORTED` when typed, `AI_ASSISTED` when transcribed. Those rows are
staged patient-reported information, not a medical record: there is no code path
from this module into `medical_records`, and only a doctor's promotion gives a
statement a clinical author (conflict C7).

**Voice symptom input (§20).** Speech-to-text runs in the patient's **browser**,
not on the server. The audio never reaches MediSense, is never stored, and never
passes through the AI provider key; only the transcript — text the patient can
read and correct — leaves the device. Uploading recordings for server-side
transcription would have meant holding patient audio and paying per call, for
strictly worse privacy.

The transcript lands in the same field the patient types into, which makes the
spec's two review points structural rather than optional:

    microphone -> transcript -> [edit] -> extraction -> [edit] -> analysis

Whether speech was involved travels with the result, because it changes what the
stored row means: a dictated symptom is `AI_ASSISTED` (a recogniser stood between
the patient's words and the text on file), a typed one is `PATIENT_REPORTED`.
Editing a transcript afterwards does not downgrade it to typed.

Recognition is a draft standard that Firefox does not implement, and this feature
exists for people who have difficulty typing — so an unsupported browser is told
so plainly rather than shown a microphone button that does nothing.

**Vital monitoring (§16-17).** The spec's pipeline — validate, save, evaluate,
alert, notify — runs in that order, and the order carries a guarantee: the
reading is persisted *before* it is judged, so a fault in the threshold
configuration can cost an alert but never a measurement.

Validation asks whether a number could be a measurement at all, which is a
different question from whether it is concerning. The plausibility bounds in
[`thresholds.py`](api/app/modules/vitals/thresholds.py) are deliberately far
wider than any alerting limit: a heart rate of 250 is a genuine emergency and is
stored and alerted on, while 900 is a sensor fault and is refused before it
reaches the chart.

Thresholds are rows, never literals. A patient's own rule beats the hospital
default, which is what stops a COPD patient's ordinary saturation alarming the
ward every reading (conflict C9). Two partial unique indexes make "which rule
governs this patient" a database guarantee rather than a query ordering: one
hospital default per vital, one override per patient per vital. The plain unique
index cannot do this alone, because Postgres permits any number of NULLs under
it — which is exactly the hole the second, partial index closes.

**An ongoing problem is one alert, not one per reading.** A patient whose
saturation sits below its floor breaches on every measurement; opening a new
alert each time would bury a ward in duplicates of a situation somebody is
already handling. An open alert therefore suppresses new ones — while a
*worsening* breach escalates the existing alert rather than being swallowed,
since the reason nobody has acted may be that it did not look urgent.

**Recording a vital is not reading a chart**, and the permission split is what
makes the nurse role coherent (conflict C1): `vital:write` lets a nurse record
what they just measured on the patient in front of them, and they still get 403
on that patient's history. Reads go through the same clinical gate as records,
so an administrator is refused here exactly as they are on a diagnosis.

Live updates are server-sent events rather than a frontend timer. Scope is
resolved once per connection from the same clinical rules, so a client is never
sent an event about a patient it would be refused on a GET. The fan-out is
in-process: a multi-worker deployment would need a shared bus, and Postgres
LISTEN/NOTIFY is unavailable here because the Supabase transaction pooler does
not carry notifications. The dashboard refetches on reconnect, so the gap costs
latency rather than correctness.

**Notifications (§31-32).** One service, two channels: `notify()` writes the
in-app row every time and queues an email alongside it when the type warrants
one, so no module knows how mail is sent or whether it is sent at all.

**The email says less than the in-app notification it accompanies, on purpose.**
An in-app notification is read inside the session, behind authentication, by
someone the access-control layer has already checked — so it can say "Heart rate
150 bpm is above the configured limit". An email crosses to a mail provider,
sits on their servers, is indexed by their search and lands on a lock screen.
None of that is inside the boundary the rest of this system maintains, so the
email says *that* something happened and where to see it:

    in-app:  "Heart rate 150 bpm is above the configured limit of 120 bpm."
    email:   "A recorded reading has crossed its configured threshold."

Scheduling and billing details are treated differently and deliberately: an
appointment time and an invoice number are what a reminder is *for*, and a
reminder that withholds the time is not a reminder. Diagnoses, medications,
symptoms, measurements and results are never in an email.

Sending happens on a background loop, never inside a request — a booking must
not wait on an SMTP handshake, and a slow mail server must not become a slow
hospital. Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several workers can
run the dispatcher and each message still goes to exactly one of them. A
transient failure leaves the row `PENDING` for the next pass; a permanent one
(refused mailbox, rejected login) fails immediately, because retrying it only
delays the queue behind it. Retry is bounded by age rather than a counter: a
reminder that arrives a day late tells someone about a slot they already missed.

Appointment reminders are idempotent by observation — the loop asks which
appointments already have a reminder notification and skips those, so there is
no "reminded" flag to fall out of step with reality.

**Break-glass access (R3, conflict C1).** A grant is issued **immediately, not
approved** — and that is the design, not a shortcut. Break-glass that waits for
an administrator has failed at the moment it exists for, and staff who cannot
get in during an emergency start sharing logins, which defeats every control in
this system rather than just this one.

Control comes from making misuse expensive instead of making access hard: a
mandatory stored reason, scope limited to **one patient**, automatic expiry in
minutes, every read counted and audited at `BREAK_GLASS` severity, a
notification to the patient that their record was opened this way, and a
compliance review afterwards. The deterrent is the review, not the restriction.

Expiry is enforced **at the moment of use**, never by a background sweeper: a
sweeper that stopped running would silently extend every outstanding grant. The
grant id rides in the access token, but the token is a *pointer* — the grant is
re-read on every request, so revocation takes effect on the next call rather
than when the token expires.

**Rate limiting** is a sliding window on the endpoints where repetition costs
something: the AI assistant (every call spends money), break-glass (probing for
patient ids), and login (in front of the account lockout that already exists).
Its counter lives in the process, so a multi-worker deployment allows roughly
one budget per worker — a real weakness, stated rather than hidden. It is a cost
and noise control; the defences that must not be bypassable — account lockout,
authorization, audit — are all in the database.

**Reading the audit trail is itself audited**, and there is no write route to
it at all. `record_audit()` is the only writer and is called from inside the
operations it records, so no API — administrator included — can add an entry by
hand. `GET /audit-logs/verify` recomputes the hash chain and reports whether it
still holds, which is what turns "append-only" from a claim into evidence.

**Logging.** structlog with a central redaction list. Passwords, tokens, API
keys, cookies and extracted document text never reach a log sink. The Supabase
service role key bypasses row-level security, so it appears only in
`services/storage.py` request headers — never in a response, a log line, or an
error message.

**Time zones.** Appointment columns are `timestamp` without a zone and every
stored value is UTC. A doctor's availability is wall-clock time at the clinic,
interpreted in `CLINIC_TIMEZONE` and converted at the boundary — so an Indian
clinic's 09:00 list does not surface as 14:30. Responses carry UTC with an
explicit `Z` alongside a pre-formatted clinic-local label.

## Requirement traceability

| Req | Status | Where |
|---|---|---|
| R1 real-time vitals + alerts | **done** | `modules/vitals/` — threshold engine, alert lifecycle, SSE |
| R2 encryption + role-based access | **done (access control)** | `rbac.py`, `deps.py`; at-rest field encryption Phase 13 |
| R3 emergency override | **done** | `modules/emergency/` — immediate grant, one patient, expiring, reviewed |
| R4 automated billing | **done** | `modules/billing/` — unique `appointmentId` is the idempotency guarantee |
| R5 doctor record updates | **done** | `modules/records/` — author-only amendment, audited by field |
| R6 append-only audit | **done** | `modules/audit/` — no write route; `/audit-logs/verify` proves the chain |
| R7 patient portal | **done** | `client/src/app/patient` — appointments, history, documents, vitals, billing, assistant |
| R8 2-minute timeout | **done** | `session_policy.py`, `deps.py`, client countdown |
| §13 medical records | **done** | `modules/records/`, `modules/prescriptions/` |
| §14 appointments | **done** | `modules/appointments/`, unique `slotKey` index |
| §25-27 documents | **done** | `modules/documents/`, `services/storage.py` — no malware scanner |
| §23-24 OCR + review | **done** | `services/extraction.py`, vision + local engines, doctor confirms |
| §18-19 AI assistant | **done** | `services/triage.py`, `services/assistant.py`, `modules/assistant/` |
| §20-21 voice + symptom review | **done** | `lib/useSpeechRecognition.ts`, `components/assistant.tsx`, `ReportedSymptom` provenance |
| §16-17 vitals + thresholds | **done** | `modules/vitals/`, `components/vitals.tsx` — engine, alert lifecycle, SSE |
| §15 automated billing | **done** | `modules/billing/`, `components/billing.tsx` — invoice per completed consultation |
| §31-32 notifications | **done** | `notifications/templates.py`, `dispatcher.py`, `services/email.py` — in-app + email |
| §33-34 rate limiting, ACL review | **done** | `core/ratelimit.py`, `tests/test_access_control_review.py` |

Nothing is marked complete on the strength of a UI existing — a feature counts
only with API, database, authorization, validation, error handling, audit and
passing tests behind it.

## Build phases

1. ~~Repository analysis~~
2. ~~Foundation — database, env, auth, RBAC, audit, error handling~~
3. ~~Core users and role dashboards~~
4. ~~Appointments — availability and leave, booking, reschedule, cancel,
   consultation lifecycle, in-app notifications~~
5. ~~Medical records — history, diagnoses, treatment plans, prescriptions~~
6. ~~Documents + Supabase Storage — upload, validation, signed retrieval~~
7. ~~OCR — vision extraction with a local fallback, and the review gate~~
8. ~~AI assistant — deterministic triage, grounded answers, symptom review~~
9. ~~Voice input — browser speech-to-text, editable transcript, provenance~~
10. ~~Vitals — threshold engine, alerts, live updates~~
11. ~~Billing — automatic invoice on consultation completion~~
12. ~~Notification delivery — email templates, dispatcher, appointment reminders~~
13. ~~Audit, emergency access, rate limiting, access-control review~~
14. ~~Test pass — UI test suite, two-tier test strategy~~
15. ~~Requirement verification — see [VERIFICATION.md](VERIFICATION.md)~~
