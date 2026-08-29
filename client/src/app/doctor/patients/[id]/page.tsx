"use client";

/**
 * One patient's chart, and the forms that add to it.
 *
 * Authoring is deliberately explicit — a record is filed under the doctor who
 * wrote it and can only be amended by them, so the "Amend" control appears on
 * their own notes and nowhere else. The API enforces this regardless; the UI
 * just avoids offering a button that would be refused.
 */

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { AppShell } from "@/components/AppShell";
import { DocumentsCard } from "@/components/DocumentsCard";
import { PrescriptionRow, RecordTimeline } from "@/components/records";
import { RecordVitals, ThresholdsPanel, VitalsTable } from "@/components/vitals";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Loading,
  cx,
} from "@/components/ui";
import {
  ApiError,
  patients,
  prescriptions as prescriptionsApi,
  records,
  type MedicalRecord,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsync } from "@/lib/useAsync";

function Textarea({
  id,
  value,
  onChange,
  rows = 3,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={cx(
        "block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base",
        "text-slate-900 focus:outline-2 focus:outline-teal-600",
        "dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100",
      )}
    />
  );
}

export default function PatientChart() {
  const params = useParams<{ id: string }>();
  const patientId = params.id;
  const { user } = useSession();

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
      <div id="main">
        <Link
          href="/doctor/patients"
          className="text-sm font-medium text-teal-800 hover:underline dark:text-teal-300"
        >
          ← Back to my patients
        </Link>

        {(profile.loading || history.loading) && <Loading label="Loading the chart" />}

        {denied && (
          <ErrorState
            title="You do not have access to this patient"
            message="Charts are reachable only through a care relationship — an assignment, or a consultation you are treating."
          />
        )}

        {!denied && profile.error && (
          <ErrorState message={profile.error.message} onRetry={profile.reload} />
        )}

        {profile.data && !denied && (
          <div className="mt-4 space-y-6">
            <header>
              <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
                {profile.data.name}
              </h1>
              <p className="mt-1 tabular-nums text-slate-600 dark:text-slate-400">
                {profile.data.medicalRecordNumber}
                {profile.data.bloodGroup ? ` · ${profile.data.bloodGroup}` : ""}
                {profile.data.dateOfBirth ? ` · born ${profile.data.dateOfBirth}` : ""}
              </p>
              {profile.data.allergies && (
                <p
                  role="alert"
                  className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                >
                  Allergies: {profile.data.allergies}
                </p>
              )}
              {profile.data.chronicConditions && (
                <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
                  Chronic conditions: {profile.data.chronicConditions}
                </p>
              )}
            </header>

            <NewRecordForm patientId={patientId} onSaved={reloadAll} />

            <Card
              title="Current medication"
              description="Check this before prescribing."
            >
              {active.length === 0 ? (
                <EmptyState title="No active prescriptions" />
              ) : (
                <ul className="divide-y divide-slate-200 dark:divide-slate-700">
                  {active.map((prescription) => (
                    <PrescriptionRow
                      key={prescription.id}
                      prescription={prescription}
                      action={
                        <DiscontinueButton id={prescription.id} onDone={reloadAll} />
                      }
                    />
                  ))}
                </ul>
              )}
            </Card>

            <NewPrescriptionForm patientId={patientId} onSaved={reloadAll} />

            {/* Observations sit with the chart because that is where a doctor
                reads a trend — beside the history that explains it. */}
            <RecordVitals patientId={patientId} onRecorded={reloadAll} />
            <VitalsTable key={`vitals-${refresh}`} patientId={patientId} />
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

            <Card title="History" description="Most recent first.">
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
      action={
        !open && (
          <Button onClick={() => setOpen(true)}>Write a note</Button>
        )
      }
    >
      {!open ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Records are permanent clinical history. Write what the next clinician needs to know.
        </p>
      ) : (
        <div className="space-y-4">
          <Field label="Symptoms" htmlFor="symptoms">
            <Textarea
              id="symptoms"
              value={symptoms}
              onChange={setSymptoms}
              placeholder="What the patient reports"
            />
          </Field>
          <Field label="Diagnosis" htmlFor="diagnosis">
            <Textarea id="diagnosis" value={diagnosis} onChange={setDiagnosis} rows={2} />
          </Field>
          <Field label="Treatment plan" htmlFor="treatment">
            <Textarea id="treatment" value={treatmentPlan} onChange={setTreatmentPlan} />
          </Field>
          <Field label="Notes" htmlFor="record-notes">
            <Textarea id="record-notes" value={notes} onChange={setNotes} />
          </Field>
          <Field label="Follow-up" htmlFor="follow-up">
            <Textarea
              id="follow-up"
              value={followUpNotes}
              onChange={setFollowUpNotes}
              rows={2}
              placeholder="When to review, and what to check"
            />
          </Field>

          {error && (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <Button disabled={empty || busy} onClick={() => void submit()}>
              {busy ? "Saving…" : "File this record"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
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
  const [open, setOpen] = useState(false);
  const [medication, setMedication] = useState("");
  const [dosage, setDosage] = useState("");
  const [frequency, setFrequency] = useState("");
  const [duration, setDuration] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setOpen(false);
      onSaved();
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
      action={!open && <Button onClick={() => setOpen(true)}>New prescription</Button>}
    >
      {!open ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Prescriptions are never deleted — stopping one keeps it in the patient&rsquo;s history.
        </p>
      ) : (
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
              value={instructions}
              onChange={setInstructions}
              rows={2}
              placeholder="e.g. Take after food"
            />
          </Field>

          {error && (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <Button disabled={!complete || busy} onClick={() => void submit()}>
              {busy ? "Saving…" : "Prescribe"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
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
    <div className="flex gap-2">
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
    <div className="w-full space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        The amendment is recorded — the entry will be marked as amended.
      </p>
      <Field label="Diagnosis" htmlFor={`amend-diagnosis-${record.id}`}>
        <Textarea
          id={`amend-diagnosis-${record.id}`}
          value={diagnosis}
          onChange={setDiagnosis}
          rows={2}
        />
      </Field>
      <Field label="Notes" htmlFor={`amend-notes-${record.id}`}>
        <Textarea id={`amend-notes-${record.id}`} value={notes} onChange={setNotes} />
      </Field>

      {error && (
        <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void submit()}>
          {busy ? "Saving…" : "Save amendment"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
