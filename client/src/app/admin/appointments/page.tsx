"use client";

/**
 * Hospital-wide appointment oversight.
 *
 * An administrator schedules and unblocks — they confirm bookings, cancel on a
 * patient's behalf and mark absences. What they cannot do is complete a
 * consultation: that is a clinical act, and the permission catalogue withholds
 * it from admins on purpose (R2). The buttons below reflect that rather than
 * offering an action the server would refuse.
 */

import { useCallback, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { AppointmentRow } from "@/components/appointments";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SkeletonRows,
  cx,
} from "@/components/ui";
import {
  ApiError,
  appointments,
  type Appointment,
  type AppointmentStatus,
} from "@/lib/api";
import { DATE_BOUNDS } from "@/lib/dates";
import { useTr } from "@/lib/lang";
import { useAsync, PAGE_REFRESH_MS } from "@/lib/useAsync";

const FILTERS: Array<{
  label: string;
  icon: string;
  status?: AppointmentStatus;
  upcomingOnly?: boolean;
}> = [
  { label: "Upcoming", icon: "event_upcoming", upcomingOnly: true },
  { label: "Awaiting confirmation", icon: "hourglass_top", status: "REQUESTED" },
  { label: "Confirmed", icon: "check_circle", status: "CONFIRMED" },
  { label: "Completed", icon: "task_alt", status: "COMPLETED" },
  { label: "Cancelled", icon: "cancel", status: "CANCELLED" },
  { label: "Did not attend", icon: "person_off", status: "NO_SHOW" },
];

export default function AdminAppointments() {
  const tr = useTr();
  const [active, setActive] = useState(0);
  const [day, setDay] = useState("");
  const [refresh, setRefresh] = useState(0);
  const reloadAll = useCallback(() => setRefresh((n) => n + 1), []);

  const filter = FILTERS[active];
  const list = useAsync(
    () =>
      appointments.list({
        status: filter.status,
        upcomingOnly: filter.upcomingOnly,
        from: day || undefined,
        to: day || undefined,
        limit: 100,
      }),
    [active, day, refresh],
    { refreshMs: PAGE_REFRESH_MS },
  );

  return (
    <AppShell role="ADMIN">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Admin portal", "Intezami portal")}
          title={tr("Appointments", "Appointments")}
          subtitle={tr(
            "Every booking in the hospital.",
            "Hospital ki har booking.",
          )}
        />

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Filter appointments"
            className="inline-flex max-w-full flex-wrap gap-1 rounded-2xl border border-line bg-sunken p-1"
          >
            {FILTERS.map((option, index) => {
              const selected = index === active;
              return (
                <button
                  key={option.label}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActive(index)}
                  className={cx(
                    "inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold transition-[background-color,color,box-shadow,transform] duration-200 ease-out",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    selected
                      ? "bg-gradient-brand text-white shadow-sm"
                      : "text-muted hover:bg-card hover:text-strong hover:shadow-sm",
                  )}
                >
                  <Icon name={option.icon} filled={selected} className="text-[18px]" />
                  {option.label}
                </button>
              );
            })}
          </div>
          <div className="ml-auto w-full sm:w-60">
            <Field label="On a specific day" htmlFor="day">
              <Input
                id="day"
                type="date"
                // Without these a browser accepts a six-digit year.
                min={DATE_BOUNDS.min}
                max={DATE_BOUNDS.max}
                value={day}
                onChange={(event) => setDay(event.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="mt-6">
          {list.loading && (
            <div role="status" aria-live="polite">
              <span className="sr-only">Loading appointments…</span>
              <SkeletonRows rows={4} />
            </div>
          )}
          {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}

          {list.data && (
            <Card
              icon={filter.icon}
              title={filter.label}
              description={`${list.data.meta.total} appointment${list.data.meta.total === 1 ? "" : "s"}`}
              action={
                day ? (
                  <Button variant="ghost" className="!min-h-9 px-3 text-sm" onClick={() => setDay("")}>
                    <Icon name="close" className="text-[18px]" />
                    {tr("Clear day", "Din hatayein")}
                  </Button>
                ) : undefined
              }
            >
              {list.data.data.length === 0 ? (
                <EmptyState
                  icon="event_busy"
                  title="Nothing matches that filter"
                  description={tr(
                    "Try another status, or clear the day to see every booking.",
                    "Koi aur haalat chunein, ya din hata kar saari bookings dekhein.",
                  )}
                />
              ) : (
                <ul className="stagger divide-y divide-line">
                  {list.data.data.map((appointment) => (
                    <AdminRow
                      key={appointment.id}
                      appointment={appointment}
                      onChanged={reloadAll}
                    />
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function AdminRow({
  appointment,
  onChanged,
}: {
  appointment: Appointment;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update the appointment.");
      setBusy(false);
    }
  };

  const canConfirm = appointment.status === "REQUESTED";
  const canCancel = ["REQUESTED", "CONFIRMED", "CHECKED_IN"].includes(appointment.status);

  return (
    <>
      <AppointmentRow
        appointment={appointment}
        counterparty={appointment.patientName ?? "Patient"}
        detail={
          appointment.doctorName
            ? `${appointment.doctorName}${appointment.specialization ? ` · ${appointment.specialization}` : ""}`
            : appointment.medicalRecordNumber
        }
        actions={
          <>
            {canConfirm && (
              <Button
                disabled={busy}
                loading={busy}
                onClick={() =>
                  void run(() => appointments.setStatus(appointment.id, "CONFIRMED"))
                }
              >
                <Icon name="check" className="text-[20px]" />
                Confirm
              </Button>
            )}
            {canCancel && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    appointments.cancel(appointment.id, "Cancelled by the hospital"),
                  )
                }
              >
                Cancel
              </Button>
            )}
          </>
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
