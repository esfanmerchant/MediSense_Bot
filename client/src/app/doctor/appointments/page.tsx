"use client";

/**
 * The doctor's clinic list and the controls that move a consultation along.
 *
 * Only the next legal step is offered. The state machine lives on the server —
 * this mirrors it so the screen never presents a button that would be refused,
 * but the refusal is the server's to make either way (spec §34).
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  PageSectionNav,
  Section,
  type Section as SectionSpec,
} from "@/components/layout/PageSectionNav";
import { AppointmentList, AppointmentRow, formatWhen, isUpcoming } from "@/components/appointments";
import {
  Button,
  Card,
  ErrorState,
  Field,
  IconButton,
  SkeletonRows,
  SkeletonTiles,
  StatTile,
  Textarea,
  cx,
} from "@/components/ui";
import {
  ApiError,
  appointments,
  type Appointment,
  type AppointmentStatus,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync, PAGE_REFRESH_MS } from "@/lib/useAsync";

/** Mirrors the server's ALLOWED_TRANSITIONS for the actions a doctor may take. */
const NEXT_STEP: Partial<Record<AppointmentStatus, { to: AppointmentStatus; label: string }>> = {
  REQUESTED: { to: "CONFIRMED", label: "Confirm" },
  CONFIRMED: { to: "CHECKED_IN", label: "Check in" },
  CHECKED_IN: { to: "IN_PROGRESS", label: "Start consultation" },
  IN_PROGRESS: { to: "COMPLETED", label: "Complete" },
};

const CAN_MARK_ABSENT: AppointmentStatus[] = ["REQUESTED", "CONFIRMED", "CHECKED_IN"];

/** The happy path through the state machine, in order. Cancelled and no-show
    leave it, and carry their own badge instead of a step. */
const STEPS: { status: AppointmentStatus; label: [string, string] }[] = [
  { status: "REQUESTED", label: ["Requested", "Darkhwast"] },
  { status: "CONFIRMED", label: ["Confirmed", "Confirm"] },
  { status: "CHECKED_IN", label: ["Checked in", "Check-in"] },
  { status: "IN_PROGRESS", label: ["In progress", "Jari"] },
  { status: "COMPLETED", label: ["Completed", "Mukammal"] },
];

const EASE = [0.16, 1, 0.3, 1] as const;

/** A checkmark that draws itself, for the moment something is done. */
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

/**
 * Where a consultation sits on its path. The gradient fills the track up to
 * the current step, and the current circle carries a slow halo.
 */
function StatusStepper({ status }: { status: AppointmentStatus }) {
  const tr = useTr();
  const index = STEPS.findIndex((step) => step.status === status);
  if (index < 0) return null;
  const progress = index / (STEPS.length - 1);
  // Circle centres sit at 10%, 30%, … of the width with five equal columns.
  const inset = 100 / STEPS.length / 2;

  return (
    <ol
      aria-label={tr("Progress", "Pesh-raft")}
      className="relative grid w-full max-w-xl"
      style={{ gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="absolute top-3 h-0.5 -translate-y-1/2 rounded-full bg-line"
        style={{ left: `${inset}%`, right: `${inset}%` }}
      />
      <span
        aria-hidden
        className="bg-gradient-brand absolute top-3 h-0.5 -translate-y-1/2 rounded-full transition-[width] duration-500 ease-out"
        style={{ left: `${inset}%`, width: `${(100 - inset * 2) * progress}%` }}
      />
      {STEPS.map((step, position) => {
        const state = position < index ? "done" : position === index ? "current" : "todo";
        return (
          <li
            key={step.status}
            aria-current={state === "current" ? "step" : undefined}
            className="relative flex flex-col items-center gap-1.5 text-center"
          >
            <span
              className={cx(
                "grid h-6 w-6 place-items-center rounded-full border-2 transition-[background-color,border-color,box-shadow,transform] duration-300",
                state === "done" && "border-transparent bg-gradient-brand text-white",
                state === "current" &&
                  "animate-halo scale-110 border-primary bg-card text-primary shadow-[0_0_0_4px_rgb(27_79_224/0.18)]",
                state === "todo" && "border-line-strong bg-card text-faint",
              )}
            >
              {state === "done" ? (
                <Icon name="check" className="text-[14px]" />
              ) : (
                <span aria-hidden className="h-2 w-2 rounded-full bg-current" />
              )}
            </span>
            <span
              className={cx(
                "text-[11px] font-semibold leading-tight",
                state === "current" ? "text-primary" : state === "done" ? "text-strong" : "text-faint",
                "hidden sm:block",
              )}
            >
              {tr(...step.label)}
            </span>
            <span className="sr-only sm:hidden">{tr(...step.label)}</span>
          </li>
        );
      })}
    </ol>
  );
}

const SECTIONS: SectionSpec[] = [
  { id: "today", label: "Today", icon: "today" },
  { id: "awaiting", label: "Awaiting you", icon: "pending_actions", badge: "warning" },
  { id: "upcoming", label: "Upcoming", icon: "event_upcoming" },
  { id: "past", label: "Past", icon: "history" },
];

export default function DoctorAppointments() {
  const tr = useTr();
  const reduce = useReducedMotion();
  const [refresh, setRefresh] = useState(0);
  const reloadAll = useCallback(() => setRefresh((n) => n + 1), []);
  const list = useAsync(() => appointments.list({ limit: 100 }), [refresh], {
    refreshMs: PAGE_REFRESH_MS,
  });

  // The consultation most recently completed here, surfaced as a success card
  // until dismissed. The list itself is reloaded from the server as before.
  const [completed, setCompleted] = useState<Appointment | null>(null);

  // Memoised from `list.data` rather than recreated inline: a fresh array on
  // every render would invalidate every memo below it.
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);

  const today = useMemo(() => {
    const now = new Date().toDateString();
    return rows.filter(
      (a) => new Date(a.startTime).toDateString() === now && a.status !== "CANCELLED",
    );
  }, [rows]);

  const awaiting = useMemo(() => rows.filter((a) => a.status === "REQUESTED"), [rows]);

  const { upcoming, finished } = useMemo(() => {
    // Requests have their own panel above, and now that isUpcoming excludes
    // them they would otherwise fall through to "finished" — a request the
    // doctor has not answered yet, filed under things that are over.
    const shownElsewhere = new Set([...today, ...awaiting].map((a) => a.id));
    const rest = rows.filter((a) => !shownElsewhere.has(a.id));
    return {
      upcoming: rest.filter(isUpcoming),
      finished: rest.filter((a) => !isUpcoming(a)),
    };
  }, [rows, today, awaiting]);

  return (
    <AppShell role="DOCTOR">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Doctor portal", "Doctor ka portal")}
          title={tr("Appointments", "Appointments")}
          subtitle={tr(
            "Your clinic list and the consultations waiting on you.",
            "Aaj ki clinic list aur woh consultations jo aap ke intezar mein hain.",
          )}
          actions={
            // Leave moved to the availability page, beside the recurring hours
            // it interrupts. This is the trail from where it used to live.
            <Link
              href="/doctor/availability"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 font-semibold text-primary transition-colors hover:bg-gradient-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Icon name="event_available" className="text-[20px]" />
              {tr("Availability & time off", "Dastyabi aur chhutti")}
            </Link>
          }
        />

        {list.loading && (
          <div role="status" aria-live="polite" className="mt-6 space-y-6">
            <span className="sr-only">{tr("Loading your schedule", "Schedule load ho raha hai")}…</span>
            <SkeletonTiles count={3} />
            <SkeletonRows rows={3} />
          </div>
        )}
        {list.error && (
          <div className="mt-6">
            <ErrorState message={list.error.message} onRetry={list.reload} />
          </div>
        )}

        {list.data && (
          <div className="mt-6 space-y-6">
            <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-3">
              <StatTile label="Today" value={today.length} icon={<Icon name="today" filled />} />
              <StatTile
                label="Awaiting confirmation"
                value={awaiting.length}
                tone={awaiting.length ? "warning" : "neutral"}
                icon={<Icon name="pending_actions" filled />}
              />
              <StatTile label="Upcoming" value={upcoming.length} icon={<Icon name="event_upcoming" filled />} />
            </div>

            <AnimatePresence initial={false}>
              {completed && (
                <motion.div
                  key={completed.id}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.3, ease: EASE }}
                  className="overflow-hidden"
                >
                  <div
                    role="status"
                    className="border-gradient flex flex-wrap items-center gap-4 rounded-2xl p-5 shadow-card"
                  >
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-stable-soft text-stable">
                      <DrawnCheck className="h-7 w-7" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-display text-base font-bold text-strong">
                        {tr("Consultation completed", "Consultation mukammal ho gayi")}
                      </p>
                      <p className="mt-0.5 text-sm text-muted">
                        {completed.patientName ?? "Patient"} ·{" "}
                        <span className="tabular-nums">{formatWhen(completed.startTime)}</span>
                        {completed.notes
                          ? ` · ${tr("Notes filed", "Notes darj ho gaye")}`
                          : ""}
                      </p>
                    </div>
                    {/* The consultation notes on the appointment are the
                        doctor's own working record. What the patient reads in
                        their history is a filed record, and nothing files one
                        by itself — so the way to write it is offered here,
                        while the visit is still the thing on the screen. */}
                    {completed.patientId && (
                      <Link
                        href={`/doctor/patients/${completed.patientId}`}
                        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-card px-3 text-sm font-semibold text-primary transition-colors hover:bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      >
                        <Icon name="edit_note" className="text-[18px]" />
                        {tr("Write the record", "Record likhein")}
                      </Link>
                    )}
                    <IconButton
                      label={tr("Dismiss", "Band karein")}
                      icon="close"
                      size="sm"
                      onClick={() => setCompleted(null)}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <PageSectionNav mode="jump" label="Sections" sections={SECTIONS} />

            <Section id="today">
<Card title="Today" description="Everyone you are seeing today." icon="today">
              <AppointmentList
                appointments={today}
                emptyTitle="Nothing scheduled today"
                emptyDescription="Your clinic list is clear."
              >
                {(appointment) => (
                  <ConsultationRow
                    appointment={appointment}
                    onChanged={reloadAll}
                    onCompleted={setCompleted}
                  />
                )}
              </AppointmentList>
            </Card>

            
            </Section>

            <Section id="awaiting">
{awaiting.length > 0 && (
              <Card
                title="Awaiting your confirmation"
                description="These patients have requested a time and are waiting to hear back."
                icon="pending_actions"
              >
                <AppointmentList appointments={awaiting} emptyTitle="Nothing waiting">
                  {(appointment) => (
                    <ConsultationRow
                      appointment={appointment}
                      onChanged={reloadAll}
                      onCompleted={setCompleted}
                    />
                  )}
                </AppointmentList>
              </Card>
            )}

            
            </Section>

            <Section id="upcoming">
<Card title="Upcoming" icon="event_upcoming">
              <AppointmentList appointments={upcoming} emptyTitle="Nothing further booked">
                {(appointment) => (
                  <ConsultationRow
                    appointment={appointment}
                    onChanged={reloadAll}
                    onCompleted={setCompleted}
                  />
                )}
              </AppointmentList>
            </Card>

            
            </Section>

            <Section id="past">
<Card title="Past" icon="history">
              <AppointmentList appointments={finished} emptyTitle="No past appointments">
                {(appointment) => (
                  <AppointmentRow
                    appointment={appointment}
                    counterparty={appointment.patientName ?? "Patient"}
                    detail={appointment.medicalRecordNumber}
                  />
                )}
              </AppointmentList>
            </Card>
            </Section>

            
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ConsultationRow({
  appointment,
  onChanged,
  onCompleted,
}: {
  appointment: Appointment;
  onChanged: () => void;
  /** Called with the server's answer when the step taken was completion. */
  onCompleted?: (appointment: Appointment) => void;
}) {
  const reduce = useReducedMotion();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [writing, setWriting] = useState(false);

  const step = NEXT_STEP[appointment.status];
  const completing = step?.to === "COMPLETED";

  const advance = async (to: AppointmentStatus, withNotes?: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await appointments.setStatus(appointment.id, to, withNotes || undefined);
      if (to === "COMPLETED") onCompleted?.(result);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update the appointment.");
    } finally {
      // `finally`, not the catch block. Lowering this only on failure assumed
      // the row goes away on success — and for "Did not attend" it does, since
      // the appointment leaves the list it is rendered in. Confirming or
      // checking in keeps it exactly where it is, under the same React key, so
      // the component is never remounted and the flag stays raised: the button
      // spins for ever and nothing but a browser reload clears it.
      setBusy(false);
    }
  };

  return (
    <>
      <AppointmentRow
        appointment={appointment}
        counterparty={appointment.patientName ?? "Patient"}
        detail={appointment.medicalRecordNumber}
        actions={
          <>
            {step && !writing && (
              <Button
                disabled={busy}
                loading={busy}
                onClick={() => {
                  // Completing is where the doctor's note belongs, so that step
                  // opens the note field rather than firing immediately.
                  if (completing) setWriting(true);
                  else void advance(step.to);
                }}
              >
                {busy ? "Saving…" : step.label}
              </Button>
            )}
            {CAN_MARK_ABSENT.includes(appointment.status) && !writing && (
              <Button variant="ghost" disabled={busy} onClick={() => void advance("NO_SHOW")}>
                Did not attend
              </Button>
            )}
          </>
        }
      />

      <div className="-mt-1 pb-4">
        <StatusStepper status={appointment.status} />
      </div>

      <AnimatePresence initial={false}>
        {writing && (
          <motion.div
            key="notes"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.3, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="mb-4 space-y-3 rounded-2xl border border-line bg-sunken/60 p-4">
              <Field label="Consultation notes" htmlFor={`notes-${appointment.id}`}>
                <Textarea
                  id={`notes-${appointment.id}`}
                  rows={3}
                  maxLength={2000}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="What was discussed, and what happens next."
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} loading={busy} onClick={() => void advance("COMPLETED", notes)}>
                  <Icon name="task_alt" className="text-[20px]" />
                  {busy ? "Saving…" : "Complete consultation"}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setWriting(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && (
        <p role="alert" className="pop-in pb-3 text-sm font-medium text-critical">
          {error}
        </p>
      )}
    </>
  );
}
