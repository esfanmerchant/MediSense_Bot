"use client";

/**
 * The doctor's clinic list and the controls that move a consultation along.
 *
 * Only the next legal step is offered. The state machine lives on the server —
 * this mirrors it so the screen never presents a button that would be refused,
 * but the refusal is the server's to make either way (spec §34).
 */

import { useCallback, useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { AppointmentList, AppointmentRow, isUpcoming } from "@/components/appointments";
import { TimeOffCard } from "@/components/TimeOffCard";
import { Button, Card, ErrorState, Loading, StatTile, cx } from "@/components/ui";
import {
  ApiError,
  appointments,
  type Appointment,
  type AppointmentStatus,
} from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

/** Mirrors the server's ALLOWED_TRANSITIONS for the actions a doctor may take. */
const NEXT_STEP: Partial<Record<AppointmentStatus, { to: AppointmentStatus; label: string }>> = {
  REQUESTED: { to: "CONFIRMED", label: "Confirm" },
  CONFIRMED: { to: "CHECKED_IN", label: "Check in" },
  CHECKED_IN: { to: "IN_PROGRESS", label: "Start consultation" },
  IN_PROGRESS: { to: "COMPLETED", label: "Complete" },
};

const CAN_MARK_ABSENT: AppointmentStatus[] = ["REQUESTED", "CONFIRMED", "CHECKED_IN"];

export default function DoctorAppointments() {
  const [refresh, setRefresh] = useState(0);
  const reloadAll = useCallback(() => setRefresh((n) => n + 1), []);
  const list = useAsync(() => appointments.list({ limit: 100 }), [refresh]);

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
    const onToday = new Set(today.map((a) => a.id));
    const rest = rows.filter((a) => !onToday.has(a.id));
    return {
      upcoming: rest.filter(isUpcoming),
      finished: rest.filter((a) => !isUpcoming(a)),
    };
  }, [rows, today]);

  return (
    <AppShell role="DOCTOR">
      <div id="main">
        <h1 className="text-2xl font-semibold text-strong">Appointments</h1>
        <p className="mt-1 text-muted">
          Your clinic list and the consultations waiting on you.
        </p>

        {list.loading && <Loading label="Loading your schedule" />}
        {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}

        {list.data && (
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              <StatTile label="Today" value={today.length} />
              <StatTile
                label="Awaiting confirmation"
                value={awaiting.length}
                tone={awaiting.length ? "warning" : "neutral"}
              />
              <StatTile label="Upcoming" value={upcoming.length} />
            </div>

            <Card title="Today" description="Everyone you are seeing today.">
              <AppointmentList
                appointments={today}
                emptyTitle="Nothing scheduled today"
                emptyDescription="Your clinic list is clear."
              >
                {(appointment) => (
                  <ConsultationRow appointment={appointment} onChanged={reloadAll} />
                )}
              </AppointmentList>
            </Card>

            {awaiting.length > 0 && (
              <Card
                title="Awaiting your confirmation"
                description="These patients have requested a time and are waiting to hear back."
              >
                <AppointmentList appointments={awaiting} emptyTitle="Nothing waiting">
                  {(appointment) => (
                    <ConsultationRow appointment={appointment} onChanged={reloadAll} />
                  )}
                </AppointmentList>
              </Card>
            )}

            <Card title="Upcoming">
              <AppointmentList appointments={upcoming} emptyTitle="Nothing further booked">
                {(appointment) => (
                  <ConsultationRow appointment={appointment} onChanged={reloadAll} />
                )}
              </AppointmentList>
            </Card>

            <TimeOffCard />

            <Card title="Past">
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
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ConsultationRow({
  appointment,
  onChanged,
}: {
  appointment: Appointment;
  onChanged: () => void;
}) {
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
      await appointments.setStatus(appointment.id, to, withNotes || undefined);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update the appointment.");
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

      {writing && (
        <div className="pb-4">
          <label
            htmlFor={`notes-${appointment.id}`}
            className="block text-sm font-medium text-strong"
          >
            Consultation notes
          </label>
          <textarea
            id={`notes-${appointment.id}`}
            rows={3}
            maxLength={2000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className={cx(
              "mt-1.5 block w-full rounded-md border border-line-strong bg-card px-3 py-2.5 text-base",
                "text-strong focus:outline-2 focus:outline-primary",
                  "",
            )}
            placeholder="What was discussed, and what happens next."
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void advance("COMPLETED", notes)}>
              {busy ? "Saving…" : "Complete consultation"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setWriting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="pb-3 text-sm font-medium text-critical">
          {error}
        </p>
      )}
    </>
  );
}
