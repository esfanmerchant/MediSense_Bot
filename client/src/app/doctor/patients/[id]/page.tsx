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

  const profile = useAsync(() => patients.get(patientId), [patientId]);
  const history = useAsync(
    () => records.list({ patientId, includePrescriptions: true, limit: 50 }),
    [patientId, refresh],
  );
  const medication = useAsync(
    () => prescriptionsApi.list({ patientId, limit: 50 }),
    [patientId, refresh],
  );

  const rows = useMemo(() => history.data?.data ?? [], [history.data]);
  const meds = useMemo(() => medication.data?.data ?? [], [medication.data]);
  const active = useMemo(() => meds.filter((m) => m.active), [meds]);

  // The API refuses a chart the caller has no care relationship with, so a 403
  // here is the expected answer for an unrelated patient rather than a bug.
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

            <NewRecordForm patientId={patientId} onSaved={reloadAll} />

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

            <NewPrescriptionForm patientId={patientId} onSaved={reloadAll} />

            {/* Observations sit with the chart because that is where a doctor
                reads a trend — beside the history that explains it. */}
            <RecordVitals patientId={patientId} onRecorded={reloadAll} />
            <VitalsTable key={`vitals-${refresh}`} patientId={patientId} snapshot />
            <ThresholdsPanel patientId={patientId} />

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

function NewRecordForm({
  patientId,
  onSaved,
}: {
  patientId: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [symptoms, setSymptoms] = useState("");
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
      });
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
