"use client";

/**
 * Pieces shared by the patient, doctor and admin appointment screens.
 *
 * Times arrive from the API in two forms: UTC with an explicit `Z`, and a
 * clinic-local label the server already formatted. The list views use the
 * viewer's local time, which is what someone travelling expects. The booking
 * grid uses the clinic label, because a slot means "09:00 at the clinic" and
 * showing a patient in another zone their own 04:30 would be actively wrong.
 */

import { Fragment } from "react";

import { Icon } from "@/components/Icon";
import type { Appointment, AppointmentStatus } from "@/lib/api";
import { Avatar, Badge, EmptyState, cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

const STATUS_TONE: Record<AppointmentStatus, "neutral" | "good" | "warning" | "critical" | "info"> =
  {
    REQUESTED: "info",
    CONFIRMED: "good",
    CHECKED_IN: "info",
    IN_PROGRESS: "warning",
    COMPLETED: "neutral",
    CANCELLED: "neutral",
    NO_SHOW: "critical",
  };

const STATUS_LABEL: Record<AppointmentStatus, [string, string]> = {
  REQUESTED: ["Awaiting confirmation", "Tasdeeq baqi"],
  CONFIRMED: ["Confirmed", "Tasdeeq shuda"],
  CHECKED_IN: ["Checked in", "Pahunch gaye"],
  IN_PROGRESS: ["In consultation", "Consultation jari"],
  COMPLETED: ["Completed", "Mukammal"],
  CANCELLED: ["Cancelled", "Mansookh"],
  NO_SHOW: ["Did not attend", "Nahi aaye"],
};

const STATUS_ICON: Record<AppointmentStatus, string> = {
  REQUESTED: "hourglass_top",
  CONFIRMED: "check_circle",
  CHECKED_IN: "how_to_reg",
  IN_PROGRESS: "stethoscope",
  COMPLETED: "task_alt",
  CANCELLED: "cancel",
  NO_SHOW: "person_off",
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  const tr = useTr();
  return (
    <Badge tone={STATUS_TONE[status]}>
      <Icon name={STATUS_ICON[status]} filled className="text-[14px]" />
      {tr(...STATUS_LABEL[status])}
    </Badge>
  );
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDay(isoDate: string): string {
  // Parsed as UTC midnight then rendered in UTC, so the label cannot slip a day
  // for viewers behind the date line.
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function isUpcoming(appointment: Appointment): boolean {
  return (
    new Date(appointment.startTime).getTime() > Date.now() &&
    !["REQUESTED", "CANCELLED", "COMPLETED", "NO_SHOW"].includes(appointment.status)
  );
}

/**
 * Asked for, not yet accepted.
 *
 * A request used to sit under "Upcoming" beside confirmed visits, which reads
 * as a promise the clinic has not made: the patient would travel for something
 * the doctor had never agreed to. It is real and it must stay visible, so it
 * gets its own group rather than being hidden — but "upcoming" it is not.
 */
export function isAwaitingConfirmation(appointment: Appointment): boolean {
  return appointment.status === "REQUESTED";
}

/**
 * Whether the patient can still move or drop this appointment themselves.
 *
 * Check-in hands the visit to the clinic: the patient is in the waiting room
 * and the doctor's list is built around them, so rescheduling from a phone at
 * that point is not a thing the system should offer. The API agrees — it allows
 * a reschedule only from REQUESTED or CONFIRMED — and this keeps the buttons
 * from promising what the server would refuse.
 */
export function patientCanChange(appointment: Appointment): boolean {
  return appointment.status === "REQUESTED" || appointment.status === "CONFIRMED";
}

/**
 * One appointment in a list. `counterparty` is whichever side the viewer is not
 * — a patient sees the doctor, a doctor sees the patient.
 */
export function AppointmentRow({
  appointment,
  counterparty,
  detail,
  actions,
}: {
  appointment: Appointment;
  counterparty: string;
  detail?: string | null;
  actions?: React.ReactNode;
}) {
  const tr = useTr();
  const live = appointment.status === "IN_PROGRESS";
  const done = ["CANCELLED", "COMPLETED", "NO_SHOW"].includes(appointment.status);

  return (
    <li
      className={cx(
        "group -mx-3 flex flex-wrap items-start gap-x-4 gap-y-3 rounded-xl px-3 py-4 transition-colors duration-200 hover:bg-gradient-soft",
        done && "opacity-80 hover:opacity-100",
      )}
    >
      <Avatar
        name={counterparty}
        ring={live ? "active" : done ? "inactive" : undefined}
        className="mt-0.5 transition-transform duration-200 group-hover:scale-105"
      />

      <div className="min-w-0 flex-1">
        <p className="font-semibold text-strong">{counterparty}</p>
        {detail && <p className="text-sm text-muted">{detail}</p>}
        {appointment.reason && (
          <p className="mt-1 flex items-start gap-1.5 text-sm text-muted">
            <Icon name="notes" className="mt-px shrink-0 text-[16px] text-faint" />
            {appointment.reason}
          </p>
        )}
        {appointment.cancelReason && (
          <p className="mt-1 flex items-start gap-1.5 text-sm text-faint">
            <Icon name="cancel" className="mt-px shrink-0 text-[16px]" />
            <span>
              {tr("Cancelled:", "Mansookh:")} {appointment.cancelReason}
            </span>
          </p>
        )}
      </div>

      <div className="flex flex-col items-end gap-1.5">
        <span
          className={cx(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold tabular-nums",
            live ? "bg-gradient-brand text-white shadow-sm" : "bg-sunken text-strong",
          )}
        >
          <Icon name="schedule" className="text-[16px]" />
          {formatWhen(appointment.startTime)}
        </span>
        <span className="inline-flex items-center gap-1 text-xs tabular-nums text-faint">
          <Icon name="timelapse" className="text-[14px]" />
          {appointment.durationMinutes} {tr("min", "min")}
        </span>
        <StatusBadge status={appointment.status} />
      </div>

      {actions && <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:self-center">{actions}</div>}
    </li>
  );
}

export function AppointmentList({
  appointments,
  emptyTitle,
  emptyDescription,
  children,
}: {
  appointments: Appointment[];
  emptyTitle: string;
  emptyDescription?: string;
  children: (appointment: Appointment) => React.ReactNode;
}) {
  if (appointments.length === 0) {
    return <EmptyState icon="event_available" title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <ul className="stagger divide-y divide-line">
      {appointments.map((appointment) => (
        <Fragment key={appointment.id}>{children(appointment)}</Fragment>
      ))}
    </ul>
  );
}

/** One selectable time in the booking grid. Taken slots stay visible but inert. */
export function SlotButton({
  label,
  available,
  selected,
  onSelect,
}: {
  label: string;
  available: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!available}
      aria-pressed={selected}
      onClick={onSelect}
      className={cx(
        "min-h-11 rounded-xl border px-3 text-sm font-semibold tabular-nums transition-[background-color,border-color,color,transform,box-shadow] duration-200 ease-out",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        selected
          ? "border-transparent bg-gradient-brand text-white shadow-card scale-[1.04]"
          : available
            ? "border-line-strong bg-card text-strong hover:scale-[1.04] hover:border-primary hover:bg-primary-soft hover:text-primary hover:shadow-card active:scale-[0.98]"
            : "cursor-not-allowed border-line bg-sunken text-faint line-through",
      )}
    >
      {label}
    </button>
  );
}
