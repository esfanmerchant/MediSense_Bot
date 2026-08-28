"use client";

/**
 * The patient's appointments: what is booked, and how to book more.
 *
 * The booking flow is deliberately linear — pick a doctor, pick a day, pick a
 * time — because the people using this portal include those who find a dense
 * calendar grid hard to read (spec §39). Each step reveals the next rather than
 * showing everything at once.
 */

import { useCallback, useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import {
  AppointmentList,
  AppointmentRow,
  formatDay,
  isUpcoming,
} from "@/components/appointments";
import { SlotButton } from "@/components/appointments";
import {
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  Loading,
  cx,
} from "@/components/ui";
import { ApiError, appointments, doctors, type Appointment } from "@/lib/api";
import { useAsync } from "@/lib/useAsync";

type Mode = { kind: "idle" } | { kind: "book" } | { kind: "move"; appointment: Appointment };

export default function PatientAppointments() {
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
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

  return (
    <AppShell role="PATIENT">
      <div id="main">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
              Appointments
            </h1>
            <p className="mt-1 text-slate-600 dark:text-slate-400">
              Book a visit, or reschedule one you have already booked.
            </p>
          </div>
          {mode.kind === "idle" && (
            <Button className="ml-auto" onClick={() => setMode({ kind: "book" })}>
              Book an appointment
            </Button>
          )}
        </div>

        {mode.kind !== "idle" && (
          <div className="mt-6">
            <Booking
              moving={mode.kind === "move" ? mode.appointment : null}
              onDone={() => {
                setMode({ kind: "idle" });
                reloadAll();
              }}
              onCancel={() => setMode({ kind: "idle" })}
            />
          </div>
        )}

        {list.loading && <Loading label="Loading your appointments" />}
        {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}

        {list.data && mode.kind === "idle" && (
          <div className="mt-6 space-y-6">
            <Card title="Upcoming" description="Visits you still need to attend.">
              <AppointmentList
                appointments={upcoming}
                emptyTitle="No upcoming appointments"
                emptyDescription="Book one and it will appear here."
              >
                {(appointment) => (
                  <UpcomingRow
                    appointment={appointment}
                    onMove={() => setMode({ kind: "move", appointment })}
                    onChanged={reloadAll}
                  />
                )}
              </AppointmentList>
            </Card>

            <Card title="Past and cancelled">
              <AppointmentList appointments={past} emptyTitle="Nothing here yet">
                {(appointment) => (
                  <AppointmentRow
                    appointment={appointment}
                    counterparty={appointment.doctorName ?? "Doctor"}
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

function UpcomingRow({
  appointment,
  onMove,
  onChanged,
}: {
  appointment: Appointment;
  onMove: () => void;
  onChanged: () => void;
}) {
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
        counterparty={appointment.doctorName ?? "Doctor"}
        detail={appointment.specialization}
        actions={
          confirming ? (
            // Cancelling frees the slot for someone else, so it asks first.
            <>
              <Button variant="danger" disabled={busy} onClick={() => void cancel()}>
                {busy ? "Cancelling…" : "Yes, cancel it"}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onMove}>
                Reschedule
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(true)}>
                Cancel
              </Button>
            </>
          )
        }
      />
      {error && (
        <p role="alert" className="pb-3 text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </>
  );
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
  const [doctorId, setDoctorId] = useState(moving?.doctorId ?? "");
  const [slot, setSlot] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <Card
      title={moving ? "Choose a new time" : "Book an appointment"}
      description={
        moving
          ? `Moving your appointment with ${moving.doctorName ?? "your doctor"}. The original will be cancelled.`
          : undefined
      }
      action={
        <Button variant="ghost" onClick={onCancel}>
          Close
        </Button>
      }
    >
      <div className="space-y-6">
        <Field label="Doctor" htmlFor="doctor" hint="Choose who you would like to see.">
          {directory.loading ? (
            <Loading label="Loading doctors" />
          ) : (
            <select
              id="doctor"
              value={doctorId}
              disabled={Boolean(moving)}
              onChange={(event) => {
                setDoctorId(event.target.value);
                setSlot(null);
              }}
              className="block min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 focus:outline-2 focus:outline-teal-600 disabled:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:disabled:bg-slate-900"
            >
              <option value="">Select a doctor…</option>
              {(directory.data?.data ?? []).map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.name} — {doctor.specialization}
                </option>
              ))}
            </select>
          )}
        </Field>

        {doctorId && slots.loading && <Loading label="Loading available times" />}
        {slots.error && <ErrorState message={slots.error.message} onRetry={slots.reload} />}

        {doctorId && slots.data && (
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Times are shown in the clinic&rsquo;s local time ({slots.data.timezone}).
            </p>
            {days.every((day) => day.availableCount === 0) ? (
              <p className="text-sm text-slate-600 dark:text-slate-400">
                This doctor has no free appointments in the next two weeks.
              </p>
            ) : (
              days
                .filter((day) => day.availableCount > 0)
                .map((day) => (
                  <fieldset key={day.date}>
                    <legend className="mb-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                      {formatDay(day.date)}
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {day.slots.map((option) => (
                        <SlotButton
                          key={option.startTime}
                          label={option.label}
                          available={option.available}
                          selected={slot === option.startTime}
                          onSelect={() => setSlot(option.startTime)}
                        />
                      ))}
                    </div>
                  </fieldset>
                ))
            )}
          </div>
        )}

        {!moving && slot && (
          <Field
            label="Reason for the visit (optional)"
            htmlFor="reason"
            hint="A short note helps the doctor prepare. Do not include anything you would not want on your record."
          >
            <Input
              id="reason"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. follow-up on last month's results"
            />
          </Field>
        )}

        {error && (
          <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
            {error}
          </p>
        )}

        <div className={cx("flex flex-wrap gap-3", !slot && "opacity-60")}>
          <Button size="lg" disabled={!slot || busy} onClick={() => void submit()}>
            {busy ? "Saving…" : moving ? "Move appointment" : "Confirm booking"}
          </Button>
          <Button size="lg" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
