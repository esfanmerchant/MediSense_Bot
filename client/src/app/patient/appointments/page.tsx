"use client";

/**
 * The patient's appointments: what is booked, and how to book more.
 *
 * The booking flow is deliberately linear — pick a doctor, pick a day, pick a
 * time — because the people using this portal include those who find a dense
 * calendar grid hard to read (spec §39). Each step reveals the next rather than
 * showing everything at once.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  AppointmentList,
  AppointmentRow,
  formatDay,
  isUpcoming,
} from "@/components/appointments";
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Skeleton,
  SkeletonRows,
  cx,
} from "@/components/ui";
import {
  ApiError,
  appointments,
  doctors,
  type Appointment,
  type AvailabilityDay,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

type Mode = { kind: "idle" } | { kind: "book" } | { kind: "move"; appointment: Appointment };

/** What just happened, for the success card. */
type Celebration = "booked" | "moved" | null;

export default function PatientAppointments() {
  const tr = useTr();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [celebration, setCelebration] = useState<Celebration>(null);
  const [refresh, setRefresh] = useState(0);
  const reloadAll = useCallback(() => setRefresh((n) => n + 1), []);

  const list = useAsync(() => appointments.list({ limit: 50 }), [refresh]);

  const upcoming = useMemo(
    () => (list.data?.data ?? []).filter(isUpcoming),
    [list.data],
  );
  const past = useMemo(
    () => (list.data?.data ?? []).filter((a) => !isUpcoming(a)),
    [list.data],
  );

  // The success card takes a bow and leaves on its own.
  useEffect(() => {
    if (!celebration) return;
    const timer = window.setTimeout(() => setCelebration(null), 7000);
    return () => window.clearTimeout(timer);
  }, [celebration]);

  return (
    <AppShell role="PATIENT">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Appointments", "Appointments")}
          subtitle={tr(
            "Book a visit, or reschedule one you have already booked.",
            "Naya appointment book karein, ya pehle se booked appointment ka waqt badlein.",
          )}
          actions={
            mode.kind === "idle" && (
              <Button
                size="lg"
                onClick={() => {
                  setCelebration(null);
                  setMode({ kind: "book" });
                }}
              >
                <Icon name="calendar_add_on" className="text-[22px]" />
                {tr("Book an appointment", "Appointment book karein")}
              </Button>
            )
          }
        />

        <AnimatePresence initial={false}>
          {celebration && (
            <motion.div
              key="celebration"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="mt-6"
            >
              <div
                role="status"
                className="card-thread flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-card p-5 shadow-card"
              >
                <SuccessMark />
                <div className="min-w-0 flex-1">
                  <p className="font-display text-lg font-bold text-strong">
                    {celebration === "moved"
                      ? tr("Appointment moved!", "Appointment ka waqt badal gaya!")
                      : tr("Appointment booked!", "Appointment book ho gayi!")}
                  </p>
                  <p className="text-sm text-muted">
                    {tr(
                      "You will find it in your upcoming visits below.",
                      "Yeh neeche aap ki aane wali visits mein mil jaye gi.",
                    )}
                  </p>
                </div>
                <IconButton
                  label={tr("Dismiss", "Band karein")}
                  icon="close"
                  size="sm"
                  onClick={() => setCelebration(null)}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {mode.kind !== "idle" && (
          <div className="pop-in mt-6">
            <Booking
              moving={mode.kind === "move" ? mode.appointment : null}
              onDone={() => {
                setCelebration(mode.kind === "move" ? "moved" : "booked");
                setMode({ kind: "idle" });
                reloadAll();
              }}
              onCancel={() => setMode({ kind: "idle" })}
            />
          </div>
        )}

        {list.loading && (
          <div role="status" aria-live="polite" className="mt-6 space-y-6">
            <span className="sr-only">
              {tr("Loading your appointments", "Aap ki appointments load ho rahi hain")}…
            </span>
            <SkeletonRows rows={2} />
            <SkeletonRows rows={3} />
          </div>
        )}
        {list.error && (
          <div className="mt-6">
            <ErrorState message={list.error.message} onRetry={list.reload} />
          </div>
        )}

        {list.data && mode.kind === "idle" && (
          <div className="stagger mt-6 space-y-6">
            <Card
              icon="event_upcoming"
              title={tr("Upcoming", "Aane wali")}
              description={tr("Visits you still need to attend.", "Jin visits par aap ne abhi jana hai.")}
            >
              <AppointmentList
                appointments={upcoming}
                emptyTitle={tr("No upcoming appointments", "Koi aane wali appointment nahi")}
                emptyDescription={tr("Book one and it will appear here.", "Book karein, yahan nazar aaye gi.")}
              >
                {(appointment) => (
                  <UpcomingRow
                    appointment={appointment}
                    onMove={() => {
                      setCelebration(null);
                      setMode({ kind: "move", appointment });
                    }}
                    onChanged={reloadAll}
                  />
                )}
              </AppointmentList>
              {upcoming.length === 0 && (
                <div className="-mt-6 flex justify-center pb-4">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setCelebration(null);
                      setMode({ kind: "book" });
                    }}
                  >
                    <Icon name="calendar_add_on" className="text-[20px]" />
                    {tr("Book your first appointment", "Apni pehli appointment book karein")}
                  </Button>
                </div>
              )}
            </Card>

            <Card icon="history" title={tr("Past and cancelled", "Guzri hui aur cancel shuda")}>
              <AppointmentList
                appointments={past}
                emptyTitle={tr("Nothing here yet", "Abhi yahan kuchh nahi")}
              >
                {(appointment) => (
                  <AppointmentRow
                    appointment={appointment}
                    counterparty={appointment.doctorName ?? tr("Doctor", "Doctor")}
                    detail={appointment.specialization}
                  />
                )}
              </AppointmentList>
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/** A checkmark that draws itself inside a gradient coin. */
function SuccessMark() {
  return (
    <span
      aria-hidden
      className="pop-scale grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-brand text-white shadow-md"
    >
      <svg viewBox="0 0 32 32" className="h-7 w-7" fill="none">
        <path
          d="M8 16.5 13.5 22 24 10.5"
          className="draw-stroke"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function UpcomingRow({
  appointment,
  onMove,
  onChanged,
}: {
  appointment: Appointment;
  onMove: () => void;
  onChanged: () => void;
}) {
  const tr = useTr();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await appointments.cancel(appointment.id, "Cancelled by patient");
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not cancel the appointment.");
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <AppointmentRow
        appointment={appointment}
        counterparty={appointment.doctorName ?? tr("Doctor", "Doctor")}
        detail={appointment.specialization}
        actions={
          confirming ? (
            // Cancelling frees the slot for someone else, so it asks first.
            <>
              <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
                {busy ? tr("Cancelling…", "Cancel ho raha hai…") : tr("Yes, cancel it", "Haan, cancel karein")}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                {tr("Keep it", "Rehne dein")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onMove}>
                <Icon name="edit_calendar" className="text-[20px]" />
                {tr("Reschedule", "Waqt badlein")}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(true)}>
                {tr("Cancel", "Cancel karein")}
              </Button>
            </>
          )
        }
      />
      {error && (
        <p role="alert" className="pop-in flex items-center gap-1.5 pb-3 text-sm font-medium text-critical">
          <Icon name="error" className="text-[16px]" />
          {error}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Booking flow
// ---------------------------------------------------------------------------

type StepKey = "doctor" | "date" | "time" | "confirm";

/** Fade plus a short horizontal slide, in the direction of travel. */
const SLIDE = {
  enter: (direction: number) => ({ opacity: 0, x: 28 * direction }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: -28 * direction }),
};

/** Today's date as the same "YYYY-MM-DD" shape the availability API uses. */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Doctor -> day -> time, then confirm. Also used to move an existing booking. */
function Booking({
  moving,
  onDone,
  onCancel,
}: {
  moving: Appointment | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const tr = useTr();
  const [doctorId, setDoctorId] = useState(moving?.doctorId ?? "");
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Where the person has navigated to. A step can never show without what it
  // needs, so the step actually rendered is clamped to what has been chosen.
  const [visited, setVisited] = useState<StepKey>(moving ? "date" : "doctor");

  const directory = useAsync(() => doctors.directory({ limit: 50 }), []);
  const slots = useAsync(
    () => (doctorId ? appointments.availability(doctorId) : Promise.resolve(null)),
    [doctorId],
  );

  const submit = async () => {
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      if (moving) {
        await appointments.reschedule(moving.id, slot);
      } else {
        await appointments.book({ doctorId, startTime: slot, reason: reason || undefined });
      }
      onDone();
    } catch (caught) {
      // A lost race for the slot is the common case here, and the message the
      // server sends ("that slot has just been taken") is the right one to show.
      setError(caught instanceof ApiError ? caught.message : "Could not book the appointment.");
      setBusy(false);
      if (caught instanceof ApiError && caught.code === "SLOT_UNAVAILABLE") {
        setSlot(null);
        slots.reload();
      }
    }
  };

  const days = slots.data?.days ?? [];
  const steps: StepKey[] = moving ? ["date", "time", "confirm"] : ["doctor", "date", "time", "confirm"];
  const furthest: StepKey = !doctorId ? "doctor" : !day ? "date" : !slot ? "time" : "confirm";
  const furthestIndex = steps.indexOf(furthest);
  const current = Math.min(steps.indexOf(visited), furthestIndex);
  const step = steps[current];

  // Slide forward when advancing, back when returning. Derived from the last
  // rendered step during render, the way React asks for state-from-props.
  const [tracked, setTracked] = useState({ step: current, direction: 1 });
  if (tracked.step !== current) {
    setTracked({ step: current, direction: current > tracked.step ? 1 : -1 });
  }
  const direction = tracked.direction;

  const chosenDoctor = (directory.data?.data ?? []).find((doctor) => doctor.id === doctorId);
  const doctorName = chosenDoctor?.name ?? moving?.doctorName ?? tr("Your doctor", "Aap ka doctor");
  const doctorSpecialization = chosenDoctor?.specialization ?? moving?.specialization ?? null;
  const chosenDay = days.find((entry) => entry.date === day) ?? null;
  const chosenSlot = days.flatMap((entry) => entry.slots).find((option) => option.startTime === slot) ?? null;

  const labels: Record<StepKey, string> = {
    doctor: tr("Doctor", "Doctor"),
    date: tr("Date", "Tareekh"),
    time: tr("Time", "Waqt"),
    confirm: tr("Confirm", "Tasdeeq"),
  };

  return (
    <Card
      icon={moving ? "edit_calendar" : "calendar_add_on"}
      title={moving ? tr("Choose a new time", "Naya waqt chunein") : tr("Book an appointment", "Appointment book karein")}
      description={
        moving
          ? tr(
              `Moving your appointment with ${moving.doctorName ?? "your doctor"}. The original will be cancelled.`,
              `${moving.doctorName ?? "aap ke doctor"} ke saath appointment ka waqt badal rahe hain. Purani cancel ho jaye gi.`,
            )
          : undefined
      }
      action={
        <Button variant="ghost" onClick={onCancel}>
          {tr("Close", "Band karein")}
        </Button>
      }
    >
      <Stepper
        steps={steps.map((key) => labels[key])}
        current={current}
        reachable={furthestIndex}
        onSelect={(index) => setVisited(steps[index])}
      />

      <div className="relative mt-8 overflow-hidden">
        <AnimatePresence mode="wait" initial={false} custom={direction}>
          <motion.div
            key={step}
            custom={direction}
            variants={SLIDE}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {step === "doctor" && (
              <StepFrame
                title={tr("Who would you like to see?", "Aap kis se milna chahte hain?")}
                hint={tr("Choose a doctor to see their free times.", "Doctor chunein, un ke khali auqaat dekhein.")}
              >
                {directory.loading ? (
                  <div className="grid gap-3 sm:grid-cols-2" aria-hidden>
                    {Array.from({ length: 4 }, (_, index) => (
                      <div key={index} className="flex items-center gap-3 rounded-2xl border border-line bg-card p-4">
                        <Skeleton className="h-14 w-14 rounded-full" />
                        <div className="flex-1">
                          <Skeleton className="h-4 w-2/3" />
                          <Skeleton className="mt-2 h-3 w-1/2" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : directory.error ? (
                  <ErrorState message={directory.error.message} onRetry={directory.reload} />
                ) : (
                  <div role="radiogroup" aria-label={tr("Doctor", "Doctor")} className="stagger grid gap-3 sm:grid-cols-2">
                    {(directory.data?.data ?? []).map((doctor) => {
                      const selected = doctor.id === doctorId;
                      return (
                        <button
                          key={doctor.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => {
                            setDoctorId(doctor.id);
                            setDay(null);
                            setSlot(null);
                            setVisited("date");
                          }}
                          className={cx(
                            "group flex items-center gap-3 rounded-2xl p-4 text-left shadow-card transition-[transform,box-shadow] duration-200 ease-out hover:scale-[1.02] hover:shadow-overlay active:scale-[0.99]",
                            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                            selected ? "border-gradient-thick" : "border border-line bg-card",
                          )}
                        >
                          <Avatar name={doctor.name} size="lg" ring={selected ? "active" : undefined} />
                          <span className="min-w-0 flex-1">
                            <span className="block font-display text-base font-bold text-strong">
                              {doctor.name}
                            </span>
                            <span className="block text-sm text-muted">{doctor.specialization}</span>
                            {doctor.department && (
                              <span className="mt-1 inline-flex items-center gap-1 text-xs text-faint">
                                <Icon name="domain" className="text-[14px]" />
                                {doctor.department.name}
                              </span>
                            )}
                          </span>
                          <span
                            aria-hidden
                            className={cx(
                              "grid h-8 w-8 shrink-0 place-items-center rounded-full transition-[background-color,color,transform] duration-200",
                              selected
                                ? "bg-gradient-brand text-white"
                                : "bg-sunken text-faint group-hover:translate-x-0.5 group-hover:text-primary",
                            )}
                          >
                            <Icon name={selected ? "check" : "arrow_forward"} className="text-[18px]" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </StepFrame>
            )}

            {step === "date" && (
              <StepFrame
                title={tr("Which day suits you?", "Kaun sa din theek rahe ga?")}
                hint={
                  slots.data
                    ? tr(
                        `Times are shown in the clinic’s local time (${slots.data.timezone}).`,
                        `Auqaat clinic ke maqami waqt mein hain (${slots.data.timezone}).`,
                      )
                    : undefined
                }
              >
                {slots.loading ? (
                  <div className="grid grid-cols-4 gap-2 sm:grid-cols-7" aria-hidden>
                    {Array.from({ length: 14 }, (_, index) => (
                      <Skeleton key={index} className="h-[4.5rem] rounded-xl" />
                    ))}
                  </div>
                ) : slots.error ? (
                  <ErrorState message={slots.error.message} onRetry={slots.reload} />
                ) : days.every((entry) => entry.availableCount === 0) ? (
                  <EmptyState
                    icon="event_busy"
                    title={tr(
                      "This doctor has no free appointments in the next two weeks.",
                      "Is doctor ke paas agle do hafton mein koi khali waqt nahi.",
                    )}
                    action={
                      !moving && (
                        <Button variant="secondary" onClick={() => setVisited("doctor")}>
                          {tr("Choose another doctor", "Koi aur doctor chunein")}
                        </Button>
                      )
                    }
                  />
                ) : (
                  <DayGrid
                    days={days}
                    selected={day}
                    onSelect={(next) => {
                      setDay(next);
                      setSlot(null);
                      setVisited("time");
                    }}
                  />
                )}
              </StepFrame>
            )}

            {step === "time" && chosenDay && (
              <StepFrame
                title={tr("What time?", "Kis waqt?")}
                hint={formatDay(chosenDay.date)}
              >
                <div role="group" aria-label={formatDay(chosenDay.date)} className="flex flex-wrap gap-2.5">
                  {chosenDay.slots.map((option) => {
                    const selected = slot === option.startTime;
                    return (
                      <button
                        key={option.startTime}
                        type="button"
                        disabled={!option.available}
                        aria-pressed={selected}
                        onClick={() => {
                          setSlot(option.startTime);
                          setVisited("confirm");
                        }}
                        className={cx(
                          "min-h-11 rounded-full px-5 text-sm font-semibold tabular-nums transition-[transform,background-color,color,border-color,box-shadow] duration-200 ease-out",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                          selected
                            ? "scale-105 border border-transparent bg-gradient-brand text-white shadow-md"
                            : option.available
                              ? "border border-line-strong bg-card text-strong hover:scale-105 hover:border-primary hover:text-primary hover:shadow-card"
                              : "cursor-not-allowed border border-line bg-sunken text-faint line-through",
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </StepFrame>
            )}

            {step === "confirm" && chosenDay && chosenSlot && (
              <StepFrame
                title={tr("Does this look right?", "Kya sab theek hai?")}
                hint={
                  moving
                    ? tr("Your original appointment will be cancelled.", "Aap ki purani appointment cancel ho jaye gi.")
                    : undefined
                }
              >
                <div className="space-y-5">
                  <div className="border-gradient rounded-2xl p-5 shadow-card">
                    <dl className="grid gap-4 sm:grid-cols-3">
                      <div className="flex items-center gap-3 sm:col-span-3">
                        <Avatar name={doctorName} size="lg" />
                        <div className="min-w-0">
                          <dt className="text-[11px] font-bold uppercase tracking-wider text-faint">
                            {tr("Doctor", "Doctor")}
                          </dt>
                          <dd className="font-display text-lg font-bold text-strong">{doctorName}</dd>
                          {doctorSpecialization && (
                            <dd className="text-sm text-muted">{doctorSpecialization}</dd>
                          )}
                        </div>
                      </div>
                      <SummaryItem icon="calendar_month" label={tr("Date", "Tareekh")}>
                        {formatDay(chosenDay.date)}
                      </SummaryItem>
                      <SummaryItem icon="schedule" label={tr("Time", "Waqt")}>
                        {chosenSlot.label}
                      </SummaryItem>
                      {slots.data && (
                        <SummaryItem icon="public" label={tr("Clinic time", "Clinic ka waqt")}>
                          {slots.data.timezone}
                        </SummaryItem>
                      )}
                    </dl>
                  </div>

                  {!moving && (
                    <Field
                      label={tr("Reason for the visit (optional)", "Aane ki wajah (ikhtiyari)")}
                      htmlFor="reason"
                      hint={tr(
                        "A short note helps the doctor prepare. Do not include anything you would not want on your record.",
                        "Mukhtasar note doctor ko tayyari mein madad deta hai. Aisa kuchh na likhein jo aap record par nahi chahte.",
                      )}
                    >
                      <Input
                        id="reason"
                        value={reason}
                        maxLength={500}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder={tr(
                          "e.g. follow-up on last month's results",
                          "maslan pichhle mahine ke results ka follow-up",
                        )}
                      />
                    </Field>
                  )}

                  {error && (
                    <p
                      role="alert"
                      className="pop-in flex items-start gap-2 rounded-xl border border-critical/50 bg-critical-soft px-4 py-3 text-sm font-medium text-critical"
                    >
                      <Icon name="error" className="mt-px shrink-0 text-[18px]" />
                      {error}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-3">
                    <Button size="lg" disabled={!slot || busy} loading={busy} onClick={() => void submit()}>
                      {busy
                        ? tr("Saving…", "Save ho raha hai…")
                        : moving
                          ? tr("Move appointment", "Appointment ka waqt badlein")
                          : tr("Confirm booking", "Booking ki tasdeeq karein")}
                      {!busy && <Icon name="check" className="text-[22px]" />}
                    </Button>
                    <Button size="lg" variant="secondary" onClick={onCancel}>
                      {tr("Cancel", "Cancel karein")}
                    </Button>
                  </div>
                </div>
              </StepFrame>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </Card>
  );
}

function StepFrame({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="font-display text-xl font-bold text-strong">{title}</h3>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function SummaryItem({
  icon,
  label,
  children,
}: {
  icon: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden className="bg-gradient-soft grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary">
        <Icon name={icon} className="text-[20px]" />
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] font-bold uppercase tracking-wider text-faint">{label}</dt>
        <dd className="font-semibold tabular-nums text-strong">{children}</dd>
      </div>
    </div>
  );
}

/**
 * Circles joined by a track that fills with the brand gradient as the person
 * advances. Earlier steps are buttons — going back never loses a choice.
 */
function Stepper({
  steps,
  current,
  reachable,
  onSelect,
}: {
  steps: string[];
  current: number;
  /** The furthest step the current choices allow. */
  reachable: number;
  onSelect: (index: number) => void;
}) {
  const tr = useTr();
  const inset = `${50 / steps.length}%`;
  const progress = steps.length > 1 ? (current / (steps.length - 1)) * 100 : 0;

  return (
    <nav aria-label={tr("Booking steps", "Booking ke marahil")}>
      <ol className="relative flex items-start">
        <div
          aria-hidden
          className="absolute top-5 h-1 -translate-y-1/2 rounded-full bg-sunken"
          style={{ left: inset, right: inset }}
        >
          <div
            className="bg-gradient-brand h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        {steps.map((label, index) => {
          const done = index < current;
          const active = index === current;
          const clickable = index !== current && index <= reachable;
          const circle = (
            <span
              aria-hidden
              className={cx(
                "relative grid h-10 w-10 place-items-center rounded-full text-sm font-bold tabular-nums transition-[background-color,color,box-shadow,transform] duration-300 ease-out",
                done && "bg-gradient-brand text-white shadow-md",
                active &&
                  "bg-gradient-brand scale-110 text-white shadow-[0_0_0_6px_rgb(27_79_224/0.18),0_6px_16px_-4px_rgb(20_199_192/0.6)]",
                !done && !active && "border-2 border-line bg-card text-faint",
              )}
            >
              {done ? <Icon name="check" className="text-[20px]" /> : index + 1}
            </span>
          );
          const text = (
            <span
              className={cx(
                "mt-2 block text-center text-xs font-semibold sm:text-sm",
                active ? "text-primary" : done ? "text-strong" : "text-faint",
              )}
            >
              {label}
            </span>
          );
          return (
            <li
              key={label}
              className="relative flex flex-1 flex-col items-center"
              aria-current={active ? "step" : undefined}
            >
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onSelect(index)}
                  className="group flex flex-col items-center rounded-xl px-1 transition-transform duration-200 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {circle}
                  {text}
                </button>
              ) : (
                <span className="flex flex-col items-center px-1">
                  {circle}
                  {text}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The next two weeks as day tiles: today ringed, full days muted. */
function DayGrid({
  days,
  selected,
  onSelect,
}: {
  days: AvailabilityDay[];
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  const tr = useTr();
  const today = todayIso();

  return (
    <div role="radiogroup" aria-label={tr("Date", "Tareekh")} className="stagger grid grid-cols-4 gap-2 sm:grid-cols-7">
      {days.map((day) => {
        const date = new Date(`${day.date}T00:00:00Z`);
        const weekday = date.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
        const month = date.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
        const available = day.availableCount > 0;
        const active = day.date === selected;
        const isToday = day.date === today;
        return (
          <button
            key={day.date}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${formatDay(day.date)}${available ? "" : ` — ${tr("fully booked", "koi waqt khali nahi")}`}`}
            disabled={!available}
            onClick={() => onSelect(day.date)}
            className={cx(
              "flex flex-col items-center rounded-xl border px-1 py-2.5 transition-[transform,background-color,color,border-color,box-shadow] duration-200 ease-out",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
              active
                ? "scale-[1.04] border-transparent bg-gradient-brand text-white shadow-md"
                : available
                  ? "border-line bg-card text-strong hover:-translate-y-0.5 hover:border-primary hover:shadow-card"
                  : "cursor-not-allowed border-line bg-sunken text-faint opacity-70",
              isToday && !active && "ring-2 ring-accent-bright ring-offset-2 ring-offset-card",
            )}
          >
            <span className={cx("text-[11px] font-semibold uppercase tracking-wider", active ? "text-white/85" : "text-faint")}>
              {weekday}
            </span>
            <span className="font-display text-2xl font-bold leading-tight tabular-nums">
              {date.getUTCDate()}
            </span>
            <span className={cx("text-[11px]", active ? "text-white/85" : "text-muted")}>{month}</span>
            <span
              className={cx(
                "mt-1.5 rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums",
                active ? "bg-white/20 text-white" : available ? "bg-accent-soft text-accent" : "text-faint",
              )}
            >
              {isToday
                ? tr("Today", "Aaj")
                : available
                  ? tr(`${day.availableCount} free`, `${day.availableCount} khali`)
                  : tr("Full", "Full")}
            </span>
          </button>
        );
      })}
    </div>
  );
}
