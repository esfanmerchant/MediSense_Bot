"use client";

/**
 * A doctor's leave: what is blocked out, and how to block out more.
 *
 * The server refuses leave that covers a booked appointment rather than
 * cancelling those patients silently, so the failure message here is worth
 * showing verbatim — it tells the doctor how many people they need to move.
 */

import { useCallback, useState } from "react";

import { Button, Card, EmptyState, ErrorState, Field, Input, Loading } from "@/components/ui";
import { ApiError, doctors } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

function formatRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const date: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  const time: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) {
    return `${start.toLocaleDateString(undefined, date)}, ${start.toLocaleTimeString(
      undefined,
      time,
    )} – ${end.toLocaleTimeString(undefined, time)}`;
  }
  return `${start.toLocaleDateString(undefined, date)} – ${end.toLocaleDateString(undefined, date)}`;
}

export function TimeOffCard() {
  const tr = useTr();
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const list = useAsync(() => doctors.timeOff(), [refresh]);

  const [adding, setAdding] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // datetime-local gives a value with no zone; the browser's own offset is
      // the right reading of what the doctor just typed.
      await doctors.addTimeOff(
        new Date(from).toISOString(),
        new Date(to).toISOString(),
        reason || undefined,
      );
      setAdding(false);
      setFrom("");
      setTo("");
      setReason("");
      reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save that leave.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await doctors.removeTimeOff(id);
      reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not remove that leave.");
    }
  };

  return (
    <Card
      title={tr("Time off", "Chhutti")}
      description={tr(
        "Blocked-out periods do not appear as bookable slots.",
        "Band kiye gaye auqat booking ke liye nazar nahi aate.",
      )}
      action={
        !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add leave
          </Button>
        )
      }
    >
      {adding && (
        <div className="mb-5 space-y-4 rounded-md border border-line p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr("From", "Se")} htmlFor="time-off-from">
              <Input
                id="time-off-from"
                type="datetime-local"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field label={tr("Until", "Tak")} htmlFor="time-off-to">
              <Input
                id="time-off-to"
                type="datetime-local"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
          </div>
          <Field label={tr("Reason (optional)", "Wajah (ikhtiyari)")} htmlFor="time-off-reason">
            <Input
              id="time-off-reason"
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Annual leave"
            />
          </Field>

          {error && (
            <p role="alert" className="text-sm font-medium text-critical">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <Button disabled={!from || !to || busy} onClick={() => void submit()}>
              {busy ? "Saving…" : "Block out this time"}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {list.loading && <Loading label={tr("Loading your leave", "Chhuttiyan load ho rahi hain")} />}
      {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}

      {list.data &&
        (list.data.length === 0 ? (
          <EmptyState
            title={tr("No time off booked", "Koi chhutti booked nahi")}
            description={tr(
              "Your published availability applies every week.",
              "Aap ki shaya karda availability har hafte laagu hoti hai.",
            )}
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.data.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium tabular-nums text-strong">
                    {formatRange(entry.startsAt, entry.endsAt)}
                  </p>
                  {entry.reason && (
                    <p className="text-sm text-muted">{entry.reason}</p>
                  )}
                </div>
                <Button variant="ghost" className="ml-auto" onClick={() => void remove(entry.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ))}

      {!adding && error && (
        <p role="alert" className="mt-3 text-sm font-medium text-critical">
          {error}
        </p>
      )}
    </Card>
  );
}
