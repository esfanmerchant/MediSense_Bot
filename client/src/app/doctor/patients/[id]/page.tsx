"use client";

/**
 * One patient's chart, and the forms that add to it.
 *
 * Authoring is deliberately explicit — a record is filed under the doctor who
 * wrote it and can only be amended by them, so the "Amend" control appears on
 * their own notes and nowhere else. The API enforces this regardless; the UI
 * just avoids offering a button that would be refused.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { AppShell } from "@/components/AppShell";
import { DocumentsCard } from "@/components/DocumentsCard";
import { Icon } from "@/components/Icon";
import {
  PageSectionNav,
  Section,
  type Section as SectionSpec,
} from "@/components/layout/PageSectionNav";
import { PrescriptionRow, RecordTimeline } from "@/components/records";
import { RecordVitals, ThresholdsPanel, VitalsTable } from "@/components/vitals";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SkeletonRows,
  Textarea,
  cx,
} from "@/components/ui";
import {
  ApiError,
  patients,
  prescriptions as prescriptionsApi,
  records,
  type MedicalRecord,
  type ReportedSymptom,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";
import { useAsync } from "@/lib/useAsync";

const EASE = [0.16, 1, 0.3, 1] as const;

/** A block that grows open and folds shut, instead of appearing. */
function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.3, ease: EASE }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A checkmark that draws itself, for the moment something is saved. */
function DrawnCheck({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={cx("pop-scale h-5 w-5", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5l4.5 4.5L19 7" className="draw-stroke" />
    </svg>
  );
}

export default function PatientChart() {
  const params = useParams<{ id: string }>();
  const patientId = params.id;
  const { user } = useSession();
  const tr = useTr();

  const [refresh, setRefresh] = useState(0);
  const reloadAll = useCallback(() => setRefresh((n) => n + 1), []);

  // Refreshed when the reader comes back, never on a timer. The API writes
  // both of these to the audit trail as "this clinician opened this patient's
  // record", because looking at a chart is itself an event somebody may later
  // have to account for — and a timer would fill that trail with accesses no
  // person made. Returning to the window is different in the way that matters:
  // somebody really did just look at it again.
  const profile = useAsync(() => patients.get(patientId), [patientId], { live: "on-return" });
  const history = useAsync(
    () => records.list({ patientId, includePrescriptions: true, limit: 50 }),
    [patientId, refresh],
    { live: "on-return" },
  );
  const medication = useAsync(
    () => prescriptionsApi.list({ patientId, limit: 50 }),
    [patientId, refresh],
  );
  const reported = useAsync(
    () => records.reportedSymptoms({ patientId, limit: 50 }),
    [patientId, refresh],
  );

  // The parts of the note form that the symptoms card also writes to. See
  // NoteDraft below for why they are up here rather than inside the form.
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteSymptoms, setNoteSymptoms] = useState("");
  const [answering, setAnswering] = useState<string[]>([]);
  const draft = useMemo(
    () => ({
      open: noteOpen,
      setOpen: setNoteOpen,
      symptoms: noteSymptoms,
      setSymptoms: setNoteSymptoms,
      answering,
      setAnswering,
    }),
    [noteOpen, noteSymptoms, answering],
  );

  const rows = useMemo(() => history.data?.data ?? [], [history.data]);
  const meds = useMemo(() => medication.data?.data ?? [], [medication.data]);
  const active = useMemo(() => meds.filter((m) => m.active), [meds]);

  // The API refuses a chart the caller has no care relationship with, so a 403
  // here is the expected answer for an unrelated patient rather than a bug.
  const openSymptoms = (reported.data?.data ?? []).filter((row) => !row.promotedAt).length;

  const sections: SectionSpec[] = [
    {
      id: "reported",
      label: "Reported",
      icon: "record_voice_over",
      count: openSymptoms || undefined,
      badge: openSymptoms > 0 ? "warning" : undefined,
    },
    { id: "note", label: "Write a note", icon: "edit_note" },
    { id: "medication", label: "Medication", icon: "pill", count: active.length },
    { id: "prescribe", label: "Prescribe", icon: "prescriptions" },
    { id: "vitals", label: "Vitals", icon: "monitor_heart" },
    { id: "documents", label: "Documents", icon: "folder_open" },
    { id: "history", label: "History", icon: "history", count: rows.length },
  ];

  const denied =
    profile.error?.status === 403 || history.error?.status === 403;

  return (
    <AppShell role="DOCTOR">
      <div id="main" className="page-enter">
        <Link
          href="/doctor/patients"
          className="group inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Icon
            name="arrow_back"
            className="text-[18px] transition-transform duration-200 group-hover:-translate-x-0.5"
          />
          {tr("Back to my patients", "Mere mareezon par wapas")}
        </Link>

        {(profile.loading || history.loading) && (
          <div role="status" aria-live="polite" className="mt-4 space-y-6">
            <span className="sr-only">Loading the chart…</span>
            <div className="flex items-center gap-5 rounded-2xl border border-line bg-card p-6 shadow-card" aria-hidden>
              <span className="skeleton h-14 w-14 rounded-full" />
              <div className="flex-1 space-y-2">
                <span className="skeleton block h-6 w-48" />
                <span className="skeleton block h-3 w-72" />
              </div>
            </div>
            <SkeletonRows rows={2} />
            <SkeletonRows rows={3} />
          </div>
        )}

        {denied && (
          <div className="mt-4">
            <ErrorState
              title="You do not have access to this patient"
              message="Charts are reachable only through a care relationship — an assignment, or a consultation you are treating."
            />
          </div>
        )}

        {!denied && profile.error && (
          <div className="mt-4">
            <ErrorState message={profile.error.message} onRetry={profile.reload} />
          </div>
        )}

        {profile.data && !denied && (
          <div className="mt-4 space-y-6">
            <header className="card-thread blob-corner relative overflow-hidden rounded-2xl border border-line bg-card p-6 shadow-card">
              <div className="relative flex flex-wrap items-center gap-5">
                <Avatar name={profile.data.name} size="lg" ring="active" />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-accent">
                    {tr("Patient chart", "Mareez ka chart")}
                  </p>
                  <h1 className="mt-1 font-display text-2xl font-bold text-strong">
                    {profile.data.name}
                  </h1>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">
                      <Icon name="badge" className="text-[14px]" />
                      <span className="tabular-nums">{profile.data.medicalRecordNumber}</span>
                    </Badge>
                    {profile.data.bloodGroup && (
                      <Badge tone="info">
                        <Icon name="bloodtype" filled className="text-[14px]" />
                        {profile.data.bloodGroup}
                      </Badge>
                    )}
                    {profile.data.dateOfBirth && (
                      <Badge tone="neutral">
                        <Icon name="cake" className="text-[14px]" />
                        <span className="tabular-nums">born {profile.data.dateOfBirth}</span>
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              {profile.data.allergies && (
                <p
                  role="alert"
                  className="relative mt-5 flex items-start gap-2.5 rounded-xl border border-critical/40 border-l-4 border-l-critical bg-critical-soft px-4 py-3 text-sm font-medium text-critical"
                >
                  <Icon name="warning" filled className="mt-px shrink-0 text-[18px]" />
                  <span>Allergies: {profile.data.allergies}</span>
                </p>
              )}
              {profile.data.chronicConditions && (
                <p className="relative mt-3 flex items-start gap-2 text-sm text-muted">
                  <Icon name="clinical_notes" className="mt-px shrink-0 text-[18px] text-faint" />
                  <span>Chronic conditions: {profile.data.chronicConditions}</span>
                </p>
              )}
            </header>

            {/* Eight sections. On a phone this page showed one of them and
                said nothing about the rest — and it is the page a clinician is
                most likely to open on a phone.

                Jump rather than tabs, deliberately: ticking a reported symptom
                fills the note form directly below it, and putting those two
                behind different tabs would break the one workflow this page was
                built around. */}
            <PageSectionNav mode="jump" label="Sections" sections={sections} />

            <Section id="reported">
            <ReportedSymptomsCard
              rows={reported.data?.data ?? []}
              onUse={(picked) => {
                // The patient's own words go into the Symptoms box, where they
                // can be edited before anything is filed. A doctor's note has a
                // doctor's author, and pasting a patient's phrasing in with no
                // chance to correct it would blur the one line this whole
                // staging table exists to keep.
                const text = picked.map(describeSymptom).join("\n");
                setNoteOpen(true);
                setAnswering(picked.map((row) => row.id));
                setNoteSymptoms(noteSymptoms ? `${noteSymptoms}\n${text}` : text);
              }}
            />
            </Section>

            <Section id="note">
            <NewRecordForm patientId={patientId} draft={draft} onSaved={reloadAll} />
            </Section>

            <Section id="medication">
            <Card
              title="Current medication"
              description="Check this before prescribing."
              icon="pill"
              action={
                active.length > 0 && (
                  <Badge tone="good">
                    <span className="tabular-nums">{active.length}</span>{" "}
                    {tr("active", "jari")}
                  </Badge>
                )
              }
            >
              {active.length === 0 ? (
                <EmptyState icon="pill_off" title="No active prescriptions" />
              ) : (
                <MedicationList>
                  {active.map((prescription) => (
                    <MedicationItem key={prescription.id}>
                      <PrescriptionRow
                        prescription={prescription}
                        action={
                          <DiscontinueButton id={prescription.id} onDone={reloadAll} />
                        }
                      />
                    </MedicationItem>
                  ))}
                </MedicationList>
              )}
            </Card>
            </Section>

            <Section id="prescribe">
            <NewPrescriptionForm patientId={patientId} onSaved={reloadAll} />
            </Section>

            {/* Observations sit with the chart because that is where a doctor
                reads a trend — beside the history that explains it. */}
            <Section id="vitals">
            <RecordVitals patientId={patientId} onRecorded={reloadAll} />
            <VitalsTable key={`vitals-${refresh}`} patientId={patientId} snapshot />
            <ThresholdsPanel patientId={patientId} />
            </Section>

            <Section id="documents">
            <DocumentsCard
              patientId={patientId}
              title="Documents"
              description="Reports, prescriptions and scans. Links expire shortly after opening."
              // Removing another person's upload is not a doctor's call — the
              // uploader or an administrator withdraws it.
              canRemove={false}
              // Confirming an extracted dose is clinical judgement, so it is
              // offered here and not on the patient's own documents page.
              canConfirmOcr
            />
            </Section>

            <Section id="history">
            <Card title="History" description="Most recent first." icon="history">
              {history.error && !denied ? (
                <ErrorState message={history.error.message} onRetry={history.reload} />
              ) : (
                <RecordTimeline
                  records={rows}
                  emptyTitle="No records yet"
                  emptyDescription="Notes you file for this patient will appear here."
                  renderAction={(record) =>
                    record.doctorId === user?.doctorId ? (
                      <AmendControl record={record} onSaved={reloadAll} />
                    ) : null
                  }
                />
              )}
            </Card>
            </Section>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/** The medication list; rows grow in and fold out rather than jumping. */
function MedicationList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-y divide-line">
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </ul>
  );
}

function MedicationItem({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: reduce ? 0 : 0.3, ease: EASE }}
      className="overflow-hidden"
    >
      {children}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// What the patient said
// ---------------------------------------------------------------------------

/** "Headache — severe, three days". One line, the way a doctor would read it. */
function describeSymptom(row: ReportedSymptom): string {
  const qualifiers = [row.severity, row.duration].filter(Boolean).join(", ");
  return qualifiers ? `${row.symptom} — ${qualifiers}` : row.symptom;
}

/**
 * Patient-reported symptoms, waiting for a clinician.
 *
 * These were being collected and never shown. The assistant asked the patient
 * what was wrong, stored their answer with its provenance, and the doctor who
 * saw them the next morning had no way to know any of it existed.
 *
 * Two things this card is careful about. It is labelled as the patient's own
 * account throughout — nothing here is a finding, and the source is on every
 * row, so a transcription the model made is never mistaken for something a
 * person confirmed. And it distinguishes what has been dealt with from what has
 * not: once a note answers a line, the line moves out of the way, because a
 * list that only grows is a list nobody reads twice.
 */
function ReportedSymptomsCard({
  rows,
  onUse,
}: {
  rows: ReportedSymptom[];
  onUse: (picked: ReportedSymptom[]) => void;
}) {
  const tr = useTr();
  const [picked, setPicked] = useState<string[]>([]);
  const [showReviewed, setShowReviewed] = useState(false);

  const open = useMemo(() => rows.filter((row) => !row.promotedAt), [rows]);
  const reviewed = useMemo(() => rows.filter((row) => row.promotedAt), [rows]);

  // A row that has since been answered must not stay selected underneath.
  const selected = useMemo(
    () => open.filter((row) => picked.includes(row.id)),
    [open, picked],
  );

  if (rows.length === 0) return null;

  const toggle = (id: string) =>
    setPicked((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  return (
    <Card
      icon="record_voice_over"
      title={tr("Reported by the patient", "Mareez ne khud bataya")}
      description={tr(
        "Their own words, from the assistant. Not a diagnosis, and not written by a clinician.",
        "Assistant par mareez ke apne alfaz. Yeh tashkhees nahi, aur kisi doctor ne nahi likhe.",
      )}
      action={
        selected.length > 0 && (
          <Button onClick={() => { onUse(selected); setPicked([]); }}>
            <Icon name="edit_note" className="text-[20px]" />
            {tr(
              `Answer ${selected.length} in a note`,
              `${selected.length} ka note likhein`,
            )}
          </Button>
        )
      }
    >
      {open.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Icon name="task_alt" className="text-[18px] text-good" />
          {tr("Everything reported has been answered.", "Jo bataya gaya tha, sab ka jawab ho chuka.")}
        </p>
      ) : (
        <ul className="space-y-2">
          {open.map((row) => (
            <li key={row.id}>
              <label
                className={cx(
                  "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
                  picked.includes(row.id)
                    ? "border-primary bg-primary-soft"
                    : "border-line hover:bg-sunken",
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--primary)]"
                  checked={picked.includes(row.id)}
                  onChange={() => toggle(row.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{describeSymptom(row)}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge tone={row.source === "AI_ASSISTED" ? "warning" : "info"}>
                      {row.source === "AI_ASSISTED"
                        ? tr("Transcribed by the assistant", "Assistant ne likha")
                        : tr("Typed by the patient", "Mareez ne likha")}
                    </Badge>
                    <span>{new Date(row.createdAt).toLocaleString()}</span>
                  </span>
                  {row.rawText && (
                    <span className="mt-1.5 block text-sm text-muted">“{row.rawText}”</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {reviewed.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <button
            type="button"
            onClick={() => setShowReviewed((value) => !value)}
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Icon
              name={showReviewed ? "expand_less" : "expand_more"}
              className="text-[18px]"
            />
            {tr(
              `${reviewed.length} already answered`,
              `${reviewed.length} ka jawab ho chuka`,
            )}
          </button>
          <Expand open={showReviewed}>
            <ul className="mt-2 space-y-1.5">
              {reviewed.map((row) => (
                <li key={row.id} className="flex items-start gap-2 text-sm text-muted">
                  <Icon name="task_alt" className="mt-px shrink-0 text-[16px] text-good" />
                  <span>{describeSymptom(row)}</span>
                </li>
              ))}
            </ul>
          </Expand>
        </div>
      )}
    </Card>
  );
}

/**
 * Three pieces of this form's state live in the page above it.
 *
 * Choosing patient-reported symptoms has to open this form and fill its
 * Symptoms box, and that happens in the click that chooses them — not in an
 * effect down here reacting to a prop that changed. An effect would be a second
 * render pass doing what the event already knew, and React says so out loud.
 */
interface NoteDraft {
  open: boolean;
  setOpen: (value: boolean) => void;
  symptoms: string;
  setSymptoms: (value: string) => void;
  /** Ids of the reported rows this note answers. */
  answering: string[];
  setAnswering: (value: string[]) => void;
}

function NewRecordForm({
  patientId,
  draft,
  onSaved,
}: {
  patientId: string;
  draft: NoteDraft;
  onSaved: () => void;
}) {
  const { open, setOpen, symptoms, setSymptoms, answering, setAnswering } = draft;
  const [diagnosis, setDiagnosis] = useState("");
  const [treatmentPlan, setTreatmentPlan] = useState("");
  const [notes, setNotes] = useState("");
  const [followUpNotes, setFollowUpNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const empty = !symptoms && !diagnosis && !treatmentPlan && !notes && !followUpNotes;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await records.create({
        patientId,
        symptoms: symptoms || undefined,
        diagnosis: diagnosis || undefined,
        treatmentPlan: treatmentPlan || undefined,
        notes: notes || undefined,
        followUpNotes: followUpNotes || undefined,
        reportedSymptomIds: answering.length > 0 ? answering : undefined,
      });
      setAnswering([]);
      setSymptoms("");
      setDiagnosis("");
      setTreatmentPlan("");
      setNotes("");
      setFollowUpNotes("");
      setOpen(false);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save the record.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="New consultation note"
      description="Filed under your name. You can amend your own notes later; other clinicians cannot."
      icon="edit_note"
      action={
        !open && (
          <Button onClick={() => setOpen(true)}>
            <Icon name="add" className="text-[20px]" />
            Write a note
          </Button>
        )
      }
    >
      {!open && (
        <p className="text-sm text-muted">
          Records are permanent clinical history. Write what the next clinician needs to know.
        </p>
      )}
      <Expand open={open}>
        <div className="space-y-4">
          <Field label="Symptoms" htmlFor="symptoms">
            <Textarea
              id="symptoms"
              rows={3}
              value={symptoms}
              onChange={(event) => setSymptoms(event.target.value)}
              placeholder="What the patient reports"
            />
          </Field>
          <Field label="Diagnosis" htmlFor="diagnosis">
            <Textarea
              id="diagnosis"
              rows={2}
              value={diagnosis}
              onChange={(event) => setDiagnosis(event.target.value)}
            />
          </Field>
          <Field label="Treatment plan" htmlFor="treatment">
            <Textarea
              id="treatment"
              rows={3}
              value={treatmentPlan}
              onChange={(event) => setTreatmentPlan(event.target.value)}
            />
          </Field>
          <Field label="Notes" htmlFor="record-notes">
            <Textarea
              id="record-notes"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          <Field label="Follow-up" htmlFor="follow-up">
            <Textarea
              id="follow-up"
              rows={2}
              value={followUpNotes}
              onChange={(event) => setFollowUpNotes(event.target.value)}
              placeholder="When to review, and what to check"
            />
          </Field>

          {error && (
            <p role="alert" className="pop-in text-sm font-medium text-critical">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <Button disabled={empty || busy} loading={busy} onClick={() => void submit()}>
              {busy ? "Saving…" : "File this record"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Expand>
    </Card>
  );
}

function NewPrescriptionForm({
  patientId,
  onSaved,
}: {
  patientId: string;
  onSaved: () => void;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const [medication, setMedication] = useState("");
  const [dosage, setDosage] = useState("");
  const [frequency, setFrequency] = useState("");
  const [duration, setDuration] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A brief drawn checkmark on the button before the form folds away.
  const [saved, setSaved] = useState(false);
  const settle = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(settle.current), []);

  const complete = medication && dosage && frequency && duration;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await prescriptionsApi.create({
        patientId,
        medication,
        dosage,
        frequency,
        duration,
        instructions: instructions || undefined,
      });
      setMedication("");
      setDosage("");
      setFrequency("");
      setDuration("");
      setInstructions("");
      setSaved(true);
      onSaved();
      settle.current = window.setTimeout(() => {
        setSaved(false);
        setOpen(false);
      }, 1100);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save the prescription.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Prescribe"
      description="Check the current medication above first."
      icon="prescriptions"
      action={
        !open && (
          <Button onClick={() => setOpen(true)}>
            <Icon name="add" className="text-[20px]" />
            New prescription
          </Button>
        )
      }
    >
      {!open && (
        <p className="text-sm text-muted">
          Prescriptions are never deleted — stopping one keeps it in the patient&rsquo;s history.
        </p>
      )}
      <Expand open={open}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Medication" htmlFor="medication">
              <Input
                id="medication"
                value={medication}
                maxLength={200}
                onChange={(event) => setMedication(event.target.value)}
              />
            </Field>
            <Field label="Dosage" htmlFor="dosage">
              <Input
                id="dosage"
                value={dosage}
                maxLength={100}
                onChange={(event) => setDosage(event.target.value)}
                placeholder="e.g. 10 mg"
              />
            </Field>
            <Field label="Frequency" htmlFor="frequency">
              <Input
                id="frequency"
                value={frequency}
                maxLength={100}
                onChange={(event) => setFrequency(event.target.value)}
                placeholder="e.g. Twice daily"
              />
            </Field>
            <Field label="Duration" htmlFor="duration">
              <Input
                id="duration"
                value={duration}
                maxLength={100}
                onChange={(event) => setDuration(event.target.value)}
                placeholder="e.g. 14 days"
              />
            </Field>
          </div>
          <Field label="Instructions for the patient" htmlFor="instructions">
            <Textarea
              id="instructions"
              rows={2}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="e.g. Take after food"
            />
          </Field>

          {error && (
            <p role="alert" className="pop-in text-sm font-medium text-critical">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={!complete || busy || saved}
              loading={busy}
              className={cx(saved && "disabled:opacity-100")}
              onClick={() => void submit()}
            >
              {saved ? (
                <>
                  <DrawnCheck />
                  {tr("Prescribed", "Likh diya gaya")}
                </>
              ) : busy ? (
                "Saving…"
              ) : (
                "Prescribe"
              )}
            </Button>
            <Button variant="ghost" disabled={busy || saved} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Expand>
    </Card>
  );
}

function DiscontinueButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Stop
      </Button>
    );
  }

  return (
    <div className="pop-in flex gap-2">
      <Button
        variant="danger"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void prescriptionsApi
            .discontinue(id)
            .then(onDone)
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Stopping…" : "Confirm stop"}
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </div>
  );
}

function AmendControl({
  record,
  onSaved,
}: {
  record: MedicalRecord;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [diagnosis, setDiagnosis] = useState(record.diagnosis ?? "");
  const [notes, setNotes] = useState(record.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Icon name="edit" className="text-[18px]" />
        Amend
      </Button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await records.amend(record.id, { diagnosis, notes });
      setOpen(false);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not amend the record.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pop-in w-full space-y-3 rounded-2xl border border-line bg-sunken/60 p-4">
      <p className="flex items-start gap-2 text-sm text-muted">
        <Icon name="info" className="mt-px shrink-0 text-[16px]" />
        The amendment is recorded — the entry will be marked as amended.
      </p>
      <Field label="Diagnosis" htmlFor={`amend-diagnosis-${record.id}`}>
        <Textarea
          id={`amend-diagnosis-${record.id}`}
          rows={2}
          value={diagnosis}
          onChange={(event) => setDiagnosis(event.target.value)}
        />
      </Field>
      <Field label="Notes" htmlFor={`amend-notes-${record.id}`}>
        <Textarea
          id={`amend-notes-${record.id}`}
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </Field>

      {error && (
        <p role="alert" className="pop-in text-sm font-medium text-critical">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} loading={busy} onClick={() => void submit()}>
          {busy ? "Saving…" : "Save amendment"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
