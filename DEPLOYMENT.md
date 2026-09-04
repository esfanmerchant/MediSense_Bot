# Deploying MediSense

Two pieces that must be deployed differently, and one mistake that breaks
sign-in on the first try.

---

## The shape of it

| Piece | Where | Why not somewhere else |
|---|---|---|
| `client/` — Next.js | **Vercel** | It is a Next.js app; this is what Vercel is for. |
| `api/` — FastAPI | **A container host in `ap-south-1` (Mumbai)** | Not Vercel. See below. |
| Postgres | **Supabase, `ap-south-1`** | Already there. |

### Why the API cannot go on Vercel

It is not a preference. The API holds two things serverless functions cannot:

* a **background dispatcher loop** started in the lifespan handler, which sends
  queued email and fires medication reminders on a schedule, and
* a **server-sent-events stream** (`/api/vitals/alerts/stream`) that a browser
  keeps open while a doctor watches live vitals.

A serverless function is invoked, runs, and is frozen. The loop would never run
and the stream would be cut. It also makes the connection-per-request cost
permanent, which is the single largest source of latency in this system.

Any container host works: **Render**, **Railway**, **Fly.io**, or **Google Cloud
Run**. `api/Dockerfile` is already there. **Pick the Mumbai region** — the
database is there, and every millisecond between the API and Postgres is paid on
every query.

---

## Before the first deploy

### 1. Leave the database on the transaction pooler

`DATABASE_URL` uses Supabase's **transaction** pooler on port `6543`, and
`db/session.py` runs `NullPool` against it. That pairing is correct, and this
section exists because the obvious-looking change is a trap that was walked into
and back out of during this project's review.

**What the change looks like.** Session mode (`5432`) pins a server connection,
which allows a client-side pool, which removes the connection cost. Measured
from outside the region, that cost is about **one second per request** and the
pool takes the median from 1,660 ms to 421 ms.

**Why it was reverted.** Session mode caps the *whole project* at **15
concurrent clients**, and every pooled connection holds one for as long as the
pool does. Exceed it and Postgres refuses with `(EMAXCONNSESSION) max clients
reached in session mode`, which surfaces as a 500 on an ordinary request. Two
processes found the ceiling in under a minute — and worse, a process that is
*killed* leaves its sessions `idle in transaction` for another ten minutes.
Measured during the review: twelve orphaned Supavisor sessions, the entire
ceiling, held by test runs that no longer existed.

**And the premise does not survive the move to Mumbai.** That one-second
connection is a TLS handshake across a long link. Run the API in `ap-south-1`
beside the database and it costs single-digit milliseconds — so `NullPool` is
suddenly cheap, and the pool is buying almost nothing in exchange for a hard
client ceiling and a bad failure mode.

So: **6543 and `NullPool`, and put the API in Mumbai.** That is faster than
session mode from here, and it has no client cap at all — the transaction pooler
multiplexes many clients onto few server connections, which is what it is for.

`db/session.py` reads the port and configures itself either way, so this stays a
one-line decision in `.env` if a future deployment genuinely needs the other
shape. If it ever does: `replicas × (POOL_SIZE + POOL_OVERFLOW) <= 15`, and the
Dockerfile already runs one worker per container, so three replicas is the
ceiling.

`DIRECT_URL` uses 5432 and is what migrations run over. The pooler cannot run
DDL, which is why there are two.

### 2. Carry `PHI_ENCRYPTION_KEY` across, exactly

This key seals `symptoms`, `diagnosis`, `treatmentPlan`, `notes` and
`followUpNotes` on `medical_records`. **It is not derivable from anything else.**

* Every environment reading the same database needs the **same value**.
* An environment without it silently falls back to `SESSION_SECRET` and writes
  ciphertext the correctly-configured process cannot open.
* It belongs in the backup set. A database dump without this key is not a backup.

`GET /api/health/ready` reports which one a running process is using:

```json
"clinicalEncryption": { "dedicatedKey": true, "usingSessionSecretFallback": false }
```

### 3. Run the migrations

Against `DIRECT_URL`, before the API serves its first request:

```bash
cd api && alembic upgrade head
```

---

## The mistake that breaks sign-in

Sessions live in **`httpOnly` cookies with `SameSite=Lax`**. A `Lax` cookie is
not sent on a cross-*site* request — and `medisense.vercel.app` and
`medisense-api.onrender.com` are different sites. Deployed that way, every
request from the browser arrives without a session and **nothing works after the
login screen**, with no error that says why.

Both halves must share one registrable domain:

```
app.medisense.pk     → Vercel      (CLIENT_ORIGIN)
api.medisense.pk     → the API     (NEXT_PUBLIC_API_URL = https://api.medisense.pk/api)
```

Add the API subdomain as a CNAME to the container host, and the app subdomain to
Vercel. Then set `CLIENT_ORIGIN` on the API to the exact frontend origin — it is
what the CORS allowlist and every emailed link are built from.

---

## Vercel, step by step

1. **Import the repository.** New Project → pick this repo.
2. **Root Directory: `client`.** This is a monorepo; without it Vercel builds the
   repository root and finds no Next.js app.
3. Framework preset **Next.js**, build command `npm run build` — both detected.
4. **Environment variables** (Production and Preview):

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://api.<your-domain>/api` |
   | `NEXT_PUBLIC_SUPABASE_URL` | your Supabase project URL |
   | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | the public half of the VAPID pair |
   | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | optional; the clinic map is hidden without it |

   Only `NEXT_PUBLIC_*` belongs here. Anything else in this list would be
   compiled into the browser bundle, where it is public — see `.env.example`.

5. **Region.** Vercel serves the frontend from the edge; the region setting only
   affects server-rendered functions. `bom1` (Mumbai) is the right one, and it
   does not move the API — that is a separate deployment.

---

## The API host

Environment variables from `.env.example`. The ones that must not be missed:

| Variable | Note |
|---|---|
| `DATABASE_URL` | port **5432**, session mode |
| `DIRECT_URL` | port 5432, for migrations |
| `PHI_ENCRYPTION_KEY` | irreplaceable — see above |
| `JWT_SECRET`, `SESSION_SECRET` | 32+ characters each, generated separately |
| `CLIENT_ORIGIN` | exact frontend origin; CORS and every email link |
| `NODE_ENV` | `production` — turns on HSTS and refuses a localhost `CLIENT_ORIGIN` |
| `SUPABASE_SERVICE_ROLE_KEY` | server-side only, never `NEXT_PUBLIC_` |
| `SMTP_*`, `VAPID_*`, `AI_API_KEY` | email, push, assistant |

```bash
docker build -t medisense-api ./api
docker run -p 4000:4000 --env-file .env medisense-api
```

Point the host's health check at `/api/health/ready`. It returns 503 while the
database is unreachable, so a bad deploy is caught before traffic reaches it.

---

## Close the Data API

Supabase exposes a REST API over the same tables at `/rest/v1`, reachable with
the publishable key, and **row-level security is not enabled on any of the 36
tables**. Nothing in this application uses it — the API talks to Postgres
directly and reaches Supabase only for file storage.

**Project Settings → API → Data API → disable**, and disable the legacy `anon`
key while you are there. If it must stay on, enable RLS on every table and add
no policy: no policy means no rows.

---

## Backup and recovery

**What has to survive together.** Two things, and a dump of one without the
other is not a backup:

1. The Postgres database — Supabase takes automatic daily backups on paid plans;
   on the free plan take one yourself with `pg_dump` over `DIRECT_URL`.
2. `PHI_ENCRYPTION_KEY`. Every diagnosis, symptom list, treatment plan and
   consultation note in the dump is ciphertext. Without this key they are
   unreadable for ever, and no amount of database access recovers them.

Storage objects — uploaded scans, reports, avatars, payment proofs — live in
Supabase Storage and are **not** in a `pg_dump`. The database keeps their paths
and checksums, so a restore without the bucket leaves documents that are listed
and cannot be opened.

**Verifying a restore.** The audit log is hash-chained: each entry covers the one
before it. After restoring, ask the application whether the chain is intact
rather than assuming a successful `psql` means a successful restore:

```
GET /api/audit-logs/verify     →  { "valid": true, "entries": … }
```

A `false` here means rows are missing or were altered between the dump and the
restore. It is the one check that can tell the difference between a database
that loaded and a history that is still true.

**What a restore cannot undo.** Removing an account is permanent by design and
deletes rows; restoring a backup taken before it brings that person's data back.
Decide which of those you want *before* restoring, not after.

## After deploying

```bash
curl https://api.<your-domain>/api/health/ready
```

Then, in a browser: sign in, open a patient record, and check that a diagnosis
reads as prose. If it reads as `v1$…` the process is running on a different
`PHI_ENCRYPTION_KEY` than the one the data was written with — fix the variable
and restart rather than writing anything else.
