"use client";

/**
 * Shared rendering for clinical content.
 *
 * One rule governs everything here: a medical record is written by a clinician,
 * and the screen must never blur that. The author's name sits on every entry,
 * amendments are marked as amendments, and a discontinued medication stays
 * visible rather than vanishing — a patient who stopped a drug last month is
 * something the next clinician needs to see.
 */

import type { MedicalRecord, Prescription } from "@/lib/api";
import { Badge, EmptyState } from "@/components/ui";

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function Section({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-faint">
        {label}
      </dt>
      <dd className="mt-0.5 whitespace-pre-wrap text-strong">{children}</dd>
    </div>
  );
}

export function RecordEntry({
  record,
  action,
}: {
  record: MedicalRecord;
  action?: React.ReactNode;
}) {
  const prescriptions = record.prescriptions ?? [];

  return (
    <article className="py-5">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold text-strong">
          {record.diagnosis || "Consultation note"}
        </h3>
        {record.amended && <Badge tone="info">Amended</Badge>}
        <p className="ml-auto text-sm tabular-nums text-muted">
          {formatDate(record.createdAt)}
        </p>
      </header>

      <p className="mt-0.5 text-sm text-muted">
        {record.doctorName ?? "Doctor"}
        {record.specialization ? ` · ${record.specialization}` : ""}
      </p>

      <dl className="mt-3 space-y-3 text-sm">
        {record.symptoms && <Section label="Symptoms">{record.symptoms}</Section>}
        {record.treatmentPlan && <Section label="Treatment">{record.treatmentPlan}</Section>}
        {record.notes && <Section label="Notes">{record.notes}</Section>}
        {record.followUpNotes && <Section label="Follow-up">{record.followUpNotes}</Section>}
        {record.followUpDate && (
          <Section label="Follow-up due">{formatDate(record.followUpDate)}</Section>
        )}
      </dl>

      {prescriptions.length > 0 && (
        <div className="mt-4 rounded-md border border-line p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-faint">
            Prescribed here
          </p>
          <ul className="mt-2 space-y-1">
            {prescriptions.map((prescription) => (
              <li key={prescription.id} className="text-sm text-strong">
                {prescription.medication} · {prescription.dosage} · {prescription.frequency}
                {!prescription.active && (
                  <span className="ml-2 text-faint">(stopped)</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {action && <div className="mt-4 flex flex-wrap gap-2">{action}</div>}
    </article>
  );
}

export function RecordTimeline({
  records,
  emptyTitle,
  emptyDescription,
  renderAction,
}: {
  records: MedicalRecord[];
  emptyTitle: string;
  emptyDescription?: string;
  renderAction?: (record: MedicalRecord) => React.ReactNode;
}) {
  if (records.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <div className="divide-y divide-line">
      {records.map((record) => (
        <RecordEntry
          key={record.id}
          record={record}
          action={renderAction?.(record)}
        />
      ))}
    </div>
  );
}

export function PrescriptionRow({
  prescription,
  action,
}: {
  prescription: Prescription;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-strong">
          {prescription.medication} · {prescription.dosage}
        </p>
        <p className="text-sm text-muted">
          {prescription.frequency} for {prescription.duration}
        </p>
        {prescription.instructions && (
          <p className="mt-0.5 text-sm text-muted">
            {prescription.instructions}
          </p>
        )}
        <p className="mt-0.5 text-xs text-faint">
          Prescribed by {prescription.doctorName ?? "a doctor"}
          {prescription.startDate ? ` on ${formatDate(prescription.startDate)}` : ""}
        </p>
      </div>

      <div className="flex flex-col items-end gap-2">
        <Badge tone={prescription.active ? "good" : "neutral"}>
          {prescription.active ? "Active" : "Stopped"}
        </Badge>
        {action}
      </div>
    </li>
  );
}
