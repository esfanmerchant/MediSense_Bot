# Page audit — in-page section navigation

Every route under `src/app/{patient,doctor,admin}`, its vertical blocks in order,
and what each page needs. Derived by reading the JSX: the "sections" column is
the list of top-level children of each page's `<div id="main">`, expanded through
the components those children delegate to (`AccountSettings`, `PaymentQueue`,
`VitalsTable`, and so on), so a page whose blocks live inside a component is
counted by what a person actually sees rather than by what the page file spells.

**Status: audit only. Nothing implemented yet.**

## How a page qualifies

A page needs work if it has **≥ 3 stacked sections**, or if its second section
starts below 720px at 390px wide.

The second half of that rule is **not measured yet**, and the column below says
so rather than guessing. Measuring it means driving the three portals in a
headless browser — see [What is not measured](#what-is-not-measured).

## What already exists

Three things are already in the codebase and the shared component must be built
out of them rather than beside them:

- **`Segmented`** (`src/components/forms.tsx`) — the horizontal button bar, with
  the animated active indicator, already used on three pages. A second bar that
  looks slightly different would be worse than no bar.
- **`AccountSettings`** — already does exactly what this audit asks for: tabs,
  synced to the URL, used by all three settings pages. `useTabFromHash` there is
  the URL-sync behaviour the new component needs, and it uses `replaceState`
  rather than `pushState` for the reason the brief gives.
- **`Icon`** — Material Symbols by name. The brief's `LucideIcon` type does not
  apply; `lucide-react` is not a dependency and adding one icon set for one
  component would put two in the bundle.

---

## Patient portal

| Route | Sections (top → bottom) | Count | Below fold at 390? | Current nav | Proposed |
|---|---|---|---|---|---|
| `/patient` | Welcome · Quick actions · At a glance (4 tiles) · Health snapshot · Latest report · Next appointments · Medication | **7** | not measured | none | **jump** |
| `/patient/appointments` | Book (stepper) · Awaiting confirmation · Upcoming · Past and cancelled | **4** | not measured | stepper (booking only) | **tabs** + sticky stepper |
| `/patient/records` | Current medication · Consultation history · What you told the assistant · Past medication | **4** | not measured | none | **tabs** |
| `/patient/vitals` | Record observations · Recent readings · Alert thresholds | **3** | not measured | none | **jump** |
| `/patient/documents` | Upload · Your documents | 2 | not measured | none | **jump** (borderline — see notes) |
| `/patient/billing` | Invoices (one list) | 1 | not measured | none | **needs a feature first** — see notes |
| `/patient/assistant` | Conversation | 1 | not measured | none | **needs a feature first** — see notes |
| `/patient/settings` | Profile · Security · Notifications · Appearance | 4 | n/a | **tabs, URL-synced** ✔ | migrate to shared component |

## Doctor portal

| Route | Sections (top → bottom) | Count | Below fold at 390? | Current nav | Proposed |
|---|---|---|---|---|---|
| `/doctor` | Welcome · Availability notice · Today's numbers (3 tiles) · Vital alerts · Clinic list | **5** | not measured | none | **jump** |
| `/doctor/appointments` | Today · Awaiting your confirmation · Upcoming · Past | **4** | not measured | none | **tabs** |
| `/doctor/patients/[id]` | Patient header · Reported by the patient · New consultation note · Current medication · Prescribe · History · Documents · Vitals · Alert thresholds | **8** | not measured | none | **tabs** — worst page in the app |
| `/doctor/availability` | Weekly schedule · Where you practise · Time off | **3** | not measured | none | **jump** |
| `/doctor/earnings` | Balance · Your withdrawals · Statement | **3** | not measured | none | **jump** |
| `/doctor/patients` | Caseload (one table) | 1 | not measured | none | none — a bar naming one section is noise |
| `/doctor/alerts` | Alerts (one list) | 1 | not measured | none | none |
| `/doctor/settings` | Profile · Security · Notifications · Appearance | 4 | n/a | **tabs, URL-synced** ✔ | migrate to shared component |
| `/doctor/onboarding` | Application (stepper) | — | not measured | stepper | make stepper sticky on mobile |
| `/doctor/pending` | Status notice | 1 | not measured | none | none |

## Admin portal

| Route | Sections (top → bottom) | Count | Below fold at 390? | Current nav | Proposed |
|---|---|---|---|---|---|
| `/admin` | Hero · Totals (4 tiles) · Waiting on you · Recent security events | **4** | not measured | none | **jump** |
| `/admin/billing` | Payments to confirm · Rates · Wallets · Invoices | **4** | not measured | none | **jump** |
| `/admin/revenue` | Totals · Over time · By speciality | **3** | not measured | none | **jump** |
| `/admin/audit` | Filters · Tamper check · Audit trail | **3** | not measured | none | **jump** |
| `/admin/emergency` | Access in force · Reviewed history | 2 | not measured | none | **jump** (borderline) |
| `/admin/users` | Search & filters · Accounts | 2 | not measured | none | **jump** (borderline) |
| `/admin/departments` | Add a department · All departments | 2 | not measured | none | **jump** (borderline) |
| `/admin/appointments` | Filters · Appointments | 2 | not measured | none | **jump** (borderline) |
| `/admin/doctor-requests` | Pending · Approved · Rejected | 3 | n/a | **Segmented** ✔ | migrate to shared, add count badges |
| `/admin/transactions` | All · Confirmed · Awaiting review · Rejected | 4 | n/a | **Segmented** ✔ | migrate to shared |
| `/admin/withdrawals` | Requests (one list) | 1 | not measured | none | none |
| `/admin/settings` | Profile · Security · Notifications · Appearance | 4 | n/a | **tabs, URL-synced** ✔ | migrate to shared component |

---

## What is not measured

The "below fold at 390?" column is empty on purpose. No headless browser is
installed (`@playwright/test` and `puppeteer` are both absent), so there is no
way to answer it that is not a guess, and the brief is explicit that guessing is
not acceptable here.

Measuring costs two things worth deciding out loud:

1. **A dev dependency.** `@playwright/test` plus one Chromium build, roughly
   150 MB, dev-only.
2. **Writes to the audit trail.** Several `GET`s in this API record an entry
   because reading them is itself an event: a patient's chart, their vitals, the
   audit log, and the administrator's dashboard. Driving all three portals as
   logged-in users writes those entries against live Supabase, into a table that
   is append-only and hash-chained and must never be deleted from. They would be
   real entries about accesses no clinician made — the exact thing the polling
   rules in `lib/useAsync.ts` were written to avoid.

Options, in the order I would pick them:

- **Measure everything except the four audited routes**, and derive those from
  the height of the blocks above their first section. Costs the dependency, adds
  no false audit entries.
- **Measure everything**, accepting a handful of audit entries on demo accounts.
- **Skip measurement**, and implement on the section-count rule alone. Every page
  marked ≥ 3 above qualifies on count without needing the fold rule at all; the
  measurement only decides the six pages marked *borderline*.

---

## Pages the brief names that do not exist

The brief lists pages this project does not have. None of these are oversights
to be fixed by adding navigation; they are either a different route here, or a
feature that does not exist yet.

| Brief | Reality |
|---|---|
| Patient → Prescriptions | No such page. Prescriptions are two sections inside `/patient/records`. |
| Patient → Billing: Outstanding / Paid tabs | `/patient/billing` renders one unfiltered list. The tabs need a filter that does not exist — a feature, not navigation. |
| Patient → Assistant: "Chats · Assistant" | There is no conversation list. The assistant holds one live conversation; there is no history to navigate to. |
| Patient → Documents / Reports: Lab · Prescriptions · Imaging | Documents carry a `documentType`, but the page does not group by it. Grouping is a feature; the nav would follow it. |
| Doctor → Consultation workspace | No such route. Notes and prescribing are sections of `/doctor/patients/[id]`. |
| Doctor → Live vitals (per patient) | No such route. Vitals are a section of the patient chart. |
| Doctor → Reports / Schedule | No such routes. `/doctor/availability` is the closest to Schedule. |
| Admin → Doctors / Patients as separate pages | One page, `/admin/users`, filtered by role. |
| Admin → patient detail (Overview / Records / Appointments / Billing / Documents) | No admin patient-detail route exists. An administrator deliberately cannot read a chart — `require_clinical_access` refuses them — so most of those tabs could not be built as described. |
| Admin → Appointments: Calendar · List | There is no calendar view, only a filtered list. |
| Admin → Billing: Invoices · Overdue · Reports | Overdue is a filter that does not exist; Reports is `/admin/revenue`. |
| Admin → Reports & analytics: Inflow · Revenue · Wait time · Diagnoses | `/admin/revenue` has revenue over time and by speciality. Inflow, wait time and diagnoses are not computed anywhere. |
| Bottom tab bar, 5 items per portal | `AppShell` renders a sidebar with grouped links, not a bottom bar. Each portal has 7–12 destinations, so five is a cut, not a layout change. |

## Notes on the borderline pages

Six pages have exactly two sections. A bar naming two things that both fit on
one screen is furniture, not navigation — it costs a row of vertical space to
tell somebody what they can already see. My recommendation is to decide these on
the measurement, not on the count: if the second section really does start below
720px on a phone, the bar earns its place; if it does not, leave them alone.

`/patient/documents`, `/admin/users`, `/admin/departments` and
`/admin/appointments` all have the same shape — a control block, then a list —
and would be better served by making the list's header sticky than by a jump bar
with two buttons in it.
