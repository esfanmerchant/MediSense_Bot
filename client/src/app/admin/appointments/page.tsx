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
import { AppointmentRow } from "@/components/appointments";
import { Button, Card, EmptyState, ErrorState, Input, Loading } from "@/components/ui";
import {
  ApiError,
  appointments,
  type Appointment,
  type AppointmentStatus,
} from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

const FILTERS: Array<{ label: string; status?: AppointmentStatus; upcomingOnly?: boolean }> = [
  { label: "Upcoming", upcomingOnly: true },
  { label: "Awaiting confirmation", status: "REQUESTED" },
  { label: "Confirmed", status: "CONFIRMED" },
  { label: "Completed", status: "COMPLETED" },
  { label: "Cancelled", status: "CANCELLED" },
  { label: "Did not attend", status: "NO_SHOW" },
];

export default function AdminAppointments() {
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
  );

  return (
    <AppShell role="ADMIN">
      <div id="main">
        <h1 className="text-2xl font-semibold text-strong">Appointments</h1>
        <p className="mt-1 text-muted">
          Every booking in the hospital. Clinical notes and consultation outcomes stay with the
          treating doctor.
        </p>

        <div className="mt-6 flex flex-wrap items-end gap-3">
          <div role="tablist" aria-label="Filter appointments" className="flex flex-wrap gap-2">
            {FILTERS.map((option, index) => (
              <Button
                key={option.label}
                role="tab"
                aria-selected={index === active}
                variant={index === active ? "primary" : "secondary"}
                onClick={() => setActive(index)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <div className="ml-auto w-full sm:w-56">
            <label
              htmlFor="day"
              className="block text-sm font-medium text-strong"
            >
              On a specific day
            </label>
            <Input
              id="day"
              type="date"
              value={day}
              className="mt-1.5"
              onChange={(event) => setDay(event.target.value)}
            />
          </div>
        </div>

        <div className="mt-6">
          {list.loading && <Loading label="Loading appointments" />}
          {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}

          {list.data && (
            <Card
              title={filter.label}
              description={`${list.data.meta.total} appointment${list.data.meta.total === 1 ? "" : "s"}`}
            >
              {list.data.data.length === 0 ? (
                <EmptyState title="Nothing matches that filter" />
              ) : (
                <ul className="divide-y divide-line">
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
                onClick={() =>
                  void run(() => appointments.setStatus(appointment.id, "CONFIRMED"))
                }
              >
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
        <p role="alert" className="pb-3 text-sm font-medium text-critical">
          {error}
        </p>
      )}
    </>
  );
}
