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
| OCR | PaddleOCR (PP-OCRv5 mobile), in-process |
| AI | Google Gemini — chatbot, symptom triage, OCR fallback |
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

### Demo accounts

All fictional, all sharing the password `Demo@Pass123`.

| Email | Role |
|---|---|
| `admin@example.com` | Admin |
| `doctor@example.com` | Doctor — Cardiology, treats Priya and Vikram |
| `doctor3@example.com` | Doctor — General Medicine, treats Meera |
| `patient@example.com` | Patient — Priya Sharma |
| `nurse@example.com` | Nurse — emergency access only, no dashboard |

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
    │   ├── audit/             # append-only, hash-chained log
    │   ├── users/             # admin user management, care assignments
    │   ├── patients/          # profile, roster, consent
    │   ├── doctors/           # directory and caseload
    │   ├── departments/
    │   └── dashboard/         # one summary per role
    └── main.py
client/src/
├── app/                       # login, patient, doctor, admin
├── components/                # AppShell, UI primitives
└── lib/                       # api client, session + inactivity timer
ocr/                           # PaddleOCR feasibility harness
```

Business logic lives in `modules/*/service.py`. Routers translate HTTP to
service calls and nothing more.

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

**Audit (R6).** `record_audit()` is the only write path; there is no update or
delete counterpart. Entries are hash-chained under a Postgres advisory lock, so
a row edited or removed directly in the database fails `verify_audit_chain()`.
`AuditLog.userId` is deliberately not a foreign key: the trail must outlive its
subject. Metadata holds references — field names, record ids — never clinical
values. In deployment, also revoke write access:

```sql
REVOKE UPDATE, DELETE ON audit_logs FROM medisense_app;
```

**Logging.** structlog with a central redaction list. Passwords, tokens, API
keys, cookies and extracted document text never reach a log sink.

## Requirement traceability

| Req | Status | Where |
|---|---|---|
| R1 real-time vitals + alerts | schema + dashboard surface | `Vital`, `VitalThreshold`, `Alert` — engine in Phase 10 |
| R2 encryption + role-based access | **done (access control)** | `rbac.py`, `deps.py`; at-rest field encryption Phase 13 |
| R3 emergency override | schema + guard | break-glass path in `deps.py` — request flow Phase 13 |
| R4 automated billing | schema only | `Invoice.appointmentId` unique — Phase 11 |
| R5 doctor record updates | schema only | Phase 5 |
| R6 append-only audit | **done** | `modules/audit/service.py` |
| R7 patient portal | overview shipped | `client/src/app/patient` — records/billing Phase 5+ |
| R8 2-minute timeout | **done** | `session_policy.py`, `deps.py`, client countdown |

Nothing is marked complete on the strength of a UI existing — a feature counts
only with API, database, authorization, validation, error handling, audit and
passing tests behind it.

## Build phases

1. ~~Repository analysis~~
2. ~~Foundation — database, env, auth, RBAC, audit, error handling~~
3. ~~Core users and role dashboards~~
4. Appointments ← next
5. Medical records · 6. Documents + storage · 7. OCR · 8. AI assistant
9. Voice input · 10. Vitals · 11. Billing · 12. Notifications
13. Audit, emergency access, hardening · 14. Full test pass · 15. Verification
