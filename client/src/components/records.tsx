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

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";

import { Icon } from "@/components/Icon";
import type { MedicalRecord, Prescription } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { Avatar, Badge, EmptyState, cx } from "@/components/ui";

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function Section({
  icon,
  label,
  children,
}: {
  icon: string;
  label: string;
  children: string;
}) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="bg-gradient-soft mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-primary"
      >
        <Icon name={icon} className="text-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-[11px] font-bold uppercase tracking-wider text-faint">{label}</dt>
        <dd className="mt-0.5 whitespace-pre-wrap leading-relaxed text-strong">{children}</dd>
      </div>
    </div>
  );
}

/**
 * One consultation on the timeline. The header is always visible; the notes
 * unfold beneath it. Actions sit in a footer of their own so a clinician's
 * "amend" is never hidden behind a fold.
 */
export function RecordEntry({
  record,
  action,
  defaultOpen = false,
}: {
  record: MedicalRecord;
  action?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(defaultOpen);
  const prescriptions = record.prescriptions ?? [];
  const panelId = `record-${record.id}`;
  const author = record.doctorName ?? tr("Doctor", "Doctor");
  const hasNotes = Boolean(
    record.symptoms ||
      record.treatmentPlan ||
      record.notes ||
      record.followUpNotes ||
      record.followUpDate ||
      prescriptions.length,
  );

  return (
    <article className="relative pb-6 last:pb-0">
      <span aria-hidden className={cx("timeline-node", record.amended && "is-accent")} />

      <div
        className={cx(
          "hover-lift-sm rounded-2xl border bg-card shadow-card",
          open ? "border-line-strong" : "border-line",
        )}
      >
        <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2 p-5">
          <Avatar name={author} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-base font-bold text-strong">
                {record.diagnosis || tr("Consultation note", "Consultation note")}
              </h3>
              {record.amended && <Badge tone="info">{tr("Amended", "Tarmeem shuda")}</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {author}
              {record.specialization ? ` · ${record.specialization}` : ""}
            </p>
          </div>
          <p className="inline-flex items-center gap-1.5 text-sm tabular-nums text-muted">
            <Icon name="calendar_today" className="text-[16px] text-faint" />
            {formatDate(record.createdAt)}
          </p>
          {/* The whole header is the toggle; the button stretches over it. */}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((current) => !current)}
            className="grid h-9 w-9 place-items-center rounded-full text-faint transition-[background-color,color,transform] duration-200 after:absolute after:inset-0 after:rounded-2xl hover:bg-sunken hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <span className="sr-only">
              {open ? tr("Hide details", "Tafseel chhupayein") : tr("Show details", "Tafseel dikhayein")}
            </span>
            <Icon
              name="expand_more"
              className={cx("text-[22px] transition-transform duration-300", open && "rotate-180")}
            />
          </button>
        </div>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="body"
              id={panelId}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="border-t border-line px-5 pb-5 pt-4">
                {hasNotes ? (
                  <dl className="space-y-4 text-sm">
                    {record.symptoms && (
                      <Section icon="sick" label={tr("Symptoms", "Alamat")}>{record.symptoms}</Section>
                    )}
                    {record.treatmentPlan && (
                      <Section icon="healing" label={tr("Treatment", "Ilaaj")}>{record.treatmentPlan}</Section>
                    )}
                    {record.notes && (
                      <Section icon="sticky_note_2" label={tr("Notes", "Notes")}>{record.notes}</Section>
                    )}
                    {record.followUpNotes && (
                      <Section icon="event_repeat" label={tr("Follow-up", "Agla muaina")}>
                        {record.followUpNotes}
                      </Section>
                    )}
                    {record.followUpDate && (
                      <Section icon="event" label={tr("Follow-up due", "Agla muaina kab")}>
                        {formatDate(record.followUpDate)}
                      </Section>
                    )}
                  </dl>
                ) : (
                  <p className="text-sm text-muted">
                    {tr("Nothing further was noted.", "Aur kuchh darj nahi kiya gaya.")}
                  </p>
                )}

                {prescriptions.length > 0 && (
                  <div className="bg-gradient-soft mt-4 rounded-xl p-4">
                    <p className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-primary">
                      <Icon name="pill" className="text-[16px]" />
                      {tr("Prescribed here", "Yahan likhi gayi dawa")}
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {prescriptions.map((prescription) => (
                        <li key={prescription.id} className="flex flex-wrap items-center gap-x-2 text-sm text-strong">
                          <span className="font-semibold">{prescription.medication}</span>
                          <span className="text-muted">
                            {prescription.dosage} · {prescription.frequency}
                          </span>
                          {!prescription.active && (
                            <span className="text-faint">{tr("(stopped)", "(band)")}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {action && (
          <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">{action}</div>
        )}
      </div>
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
    return <EmptyState icon="clinical_notes" title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <div className="timeline stagger">
      {records.map((record, index) => (
        <RecordEntry
          key={record.id}
          record={record}
          // The newest consultation opens by itself; the rest wait to be asked.
          defaultOpen={index === 0}
          action={renderAction?.(record)}
        />
      ))}
    </div>
  );
}

/**
 * One prescription. `row` sits in a divided list; `card` stands on its own in
 * a grid, with the drug name carrying the line.
 */
export function PrescriptionRow({
  prescription,
  action,
  variant = "row",
}: {
  prescription: Prescription;
  action?: React.ReactNode;
  variant?: "row" | "card";
}) {
  const tr = useTr();
  const who = prescription.doctorName ?? tr("a doctor", "doctor");
  const when = prescription.startDate ? formatDate(prescription.startDate) : null;
  const prescribed = when
    ? tr(`Prescribed by ${who} on ${when}`, `${who} ne ${when} ko likhi`)
    : tr(`Prescribed by ${who}`, `${who} ne likhi`);
  const status = (
    <Badge tone={prescription.active ? "good" : "neutral"}>
      {prescription.active ? tr("Active", "Jari") : tr("Stopped", "Band")}
    </Badge>
  );

  if (variant === "card") {
    return (
      <li
        className={cx(
          "hover-lift-sm relative flex flex-col gap-3 rounded-2xl border border-line bg-card p-5 shadow-card",
          prescription.active ? "card-thread" : "opacity-90",
        )}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className={cx(
              "grid h-11 w-11 shrink-0 place-items-center rounded-xl",
              prescription.active ? "bg-gradient-soft text-primary" : "bg-sunken text-faint",
            )}
          >
            <Icon name="pill" filled={prescription.active} className="text-[22px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-display text-lg font-bold leading-tight text-strong">
              {prescription.medication}
            </p>
            <p className="mt-0.5 text-sm text-muted">
              {prescription.dosage} · {tr(`${prescription.frequency} for ${prescription.duration}`, `${prescription.frequency}, ${prescription.duration} tak`)}
            </p>
          </div>
          {status}
        </div>
        {prescription.instructions && (
          <p className="rounded-xl bg-sunken px-3 py-2 text-sm text-strong">
            {prescription.instructions}
          </p>
        )}
        <p className="mt-auto inline-flex items-center gap-1.5 text-xs text-faint">
          <Icon name="stethoscope" className="text-[14px]" />
          {prescribed}
        </p>
        {action && <div className="flex flex-wrap gap-2">{action}</div>}
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 py-4">
      <span
        aria-hidden
        className={cx(
          "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
          prescription.active ? "bg-gradient-soft text-primary" : "bg-sunken text-faint",
        )}
      >
        <Icon name="pill" filled={prescription.active} className="text-[20px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-strong">
          {prescription.medication} <span className="font-normal text-muted">· {prescription.dosage}</span>
        </p>
        <p className="text-sm text-muted">
          {tr(`${prescription.frequency} for ${prescription.duration}`, `${prescription.frequency}, ${prescription.duration} tak`)}
        </p>
        {prescription.instructions && (
          <p className="mt-0.5 text-sm text-muted">{prescription.instructions}</p>
        )}
        <p className="mt-0.5 text-xs text-faint">{prescribed}</p>
      </div>

      <div className="flex flex-col items-end gap-2">
        {status}
        {action}
      </div>
    </li>
  );
}
