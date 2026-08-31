"use client";

/**
 * A doctor's leave: what is blocked out, and how to block out more.
 *
 * The server refuses leave that covers a booked appointment rather than
 * cancelling those patients silently, so the failure message here is worth
 * showing verbatim — it tells the doctor how many people they need to move.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useState } from "react";

import { Icon } from "@/components/Icon";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SkeletonRows,
} from "@/components/ui";
import { ApiError, doctors } from "@/lib/api";
import { DATETIME_BOUNDS } from "@/lib/dates";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

const EASE = [0.16, 1, 0.3, 1] as const;

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

/** Whether a period is still to come, current, or already behind us. */
function phaseOf(startsAt: string, endsAt: string): "upcoming" | "now" | "past" {
  const now = Date.now();
  if (Date.parse(endsAt) < now) return "past";
  if (Date.parse(startsAt) <= now) return "now";
  return "upcoming";
}

export function TimeOffCard() {
  const tr = useTr();
  const reduce = useReducedMotion();
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

  const phaseBadge = {
    upcoming: { tone: "info" as const, text: tr("Upcoming", "Aane wali") },
    now: { tone: "warning" as const, text: tr("Now", "Abhi") },
    past: { tone: "neutral" as const, text: tr("Past", "Guzri hui") },
  };

  return (
    <Card
      title={tr("Time off", "Chhutti")}
      description={tr(
        "Blocked-out periods do not appear as bookable slots.",
        "Band kiye gaye auqat booking ke liye nazar nahi aate.",
      )}
      icon="event_busy"
      action={
        !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Icon name="add" className="text-[20px]" />
            Add leave
          </Button>
        )
      }
    >
      <AnimatePresence initial={false}>
        {adding && (
          <motion.div
            key="form"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.3, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="mb-5 space-y-4 rounded-2xl border border-line bg-sunken/60 p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={tr("From", "Se")} htmlFor="time-off-from">
                  <Input
                    id="time-off-from"
                    type="datetime-local"
                    min={DATETIME_BOUNDS.min}
                    max={DATETIME_BOUNDS.max}
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </Field>
                <Field label={tr("Until", "Tak")} htmlFor="time-off-to">
                  <Input
                    id="time-off-to"
                    type="datetime-local"
                    min={DATETIME_BOUNDS.min}
                    max={DATETIME_BOUNDS.max}
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
                <p role="alert" className="pop-in text-sm font-medium text-critical">
                  {error}
                </p>
              )}

              <div className="flex flex-wrap gap-3">
                <Button disabled={!from || !to || busy} loading={busy} onClick={() => void submit()}>
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
          </motion.div>
        )}
      </AnimatePresence>

      {list.loading && (
        <div role="status" aria-live="polite">
          <span className="sr-only">{tr("Loading your leave", "Chhuttiyan load ho rahi hain")}…</span>
          <SkeletonRows rows={2} title={false} />
        </div>
      )}
      {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}

      {list.data &&
        (list.data.length === 0 ? (
          <EmptyState
            icon="beach_access"
            title={tr("No time off booked", "Koi chhutti booked nahi")}
            description={tr(
              "Your published availability applies every week.",
              "Aap ki shaya karda availability har hafte laagu hoti hai.",
            )}
          />
        ) : (
          <ul className="stagger space-y-2">
            {list.data.map((entry) => {
              const phase = phaseOf(entry.startsAt, entry.endsAt);
              return (
                <li
                  key={entry.id}
                  className="hover-lift-sm group flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3"
                >
                  <span
                    aria-hidden
                    className="icon-wiggle bg-gradient-soft grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary"
                  >
                    <Icon name="event_busy" filled className="text-[20px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium tabular-nums text-strong">
                      {formatRange(entry.startsAt, entry.endsAt)}
                    </p>
                    {entry.reason && (
                      <p className="text-sm text-muted">{entry.reason}</p>
                    )}
                  </div>
                  <Badge tone={phaseBadge[phase].tone}>{phaseBadge[phase].text}</Badge>
                  <Button variant="ghost" className="ml-auto" onClick={() => void remove(entry.id)}>
                    <Icon name="delete" className="text-[20px]" />
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        ))}

      {!adding && error && (
        <p role="alert" className="pop-in mt-3 text-sm font-medium text-critical">
          {error}
        </p>
      )}
    </Card>
  );
}
