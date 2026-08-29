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

import type { Appointment, AppointmentStatus } from "@/lib/api";
import { Badge, EmptyState, cx } from "@/components/ui";

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

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  REQUESTED: "Awaiting confirmation",
  CONFIRMED: "Confirmed",
  CHECKED_IN: "Checked in",
  IN_PROGRESS: "In consultation",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "Did not attend",
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
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
    !["CANCELLED", "COMPLETED", "NO_SHOW"].includes(appointment.status)
  );
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
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 py-4">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-strong">{counterparty}</p>
        {detail && <p className="text-sm text-muted">{detail}</p>}
        {appointment.reason && (
          <p className="mt-1 text-sm text-muted">{appointment.reason}</p>
        )}
        {appointment.cancelReason && (
          <p className="mt-1 text-sm text-faint">
            Cancelled: {appointment.cancelReason}
          </p>
        )}
      </div>

      <div className="text-right">
        <p className="text-sm font-medium tabular-nums text-strong">
          {formatWhen(appointment.startTime)}
        </p>
        <p className="text-xs text-faint">
          {appointment.durationMinutes} min
        </p>
        <div className="mt-1">
          <StatusBadge status={appointment.status} />
        </div>
      </div>

      {actions && <div className="flex w-full flex-wrap gap-2 sm:w-auto">{actions}</div>}
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
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <ul className="divide-y divide-line">
      {appointments.map((appointment) => (
        <div key={appointment.id}>{children(appointment)}</div>
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
        "min-h-11 rounded-md border px-3 text-sm font-medium tabular-nums transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        selected
          ? "border-teal-700 bg-primary text-white"
          : available
            ? "border-line-strong bg-card text-strong hover:bg-accent-soft"
            : "cursor-not-allowed border-line bg-sunken text-faint line-through dark:text-muted",
      )}
    >
      {label}
    </button>
  );
}
