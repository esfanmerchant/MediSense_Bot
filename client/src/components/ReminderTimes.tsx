"use client";

/**
 * The times a patient wants to be reminded to take one medicine.
 *
 * **The times come from the patient.** A prescription's frequency is prose —
 * "twice a day", "after meals", "SOS" — and turning that into 08:00 would be a
 * guess. A notification that says *take your Metformin now* at an hour nobody
 * chose is a confident instruction about medicine, which is the one thing this
 * app must never improvise. So there is no suggested default here; the empty
 * state asks.
 *
 * **Saving replaces the whole set**, because "I take it at 8 and at 8" is one
 * decision. That also makes a retry on a flaky connection harmless.
 */

import { useMemo, useState } from "react";

import { Icon } from "@/components/Icon";
import { TimePicker } from "@/components/TimePicker";
import { Badge, Button } from "@/components/ui";
import { medicationReminders } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

/** One reminder an hour is already more than anyone wants; the API agrees. */
const MAX_TIMES = 12;

export function ReminderTimes({ prescriptionId }: { prescriptionId: string }) {
  const tr = useTr();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Refreshing on a timer would fight the person editing it, so this is a
  // fetch once and then whatever they have since typed.
  const server = useAsync(
    () => medicationReminders.list(prescriptionId),
    [prescriptionId],
    { live: false },
  );

  /**
   * What the person last saved, when that is newer than what we fetched.
   *
   * Only ever set from a click. Mirroring the server value into state inside
   * an effect would be a second copy of the same fact, kept in step by a
   * render — which is the cascade React 19 warns about, and it is avoidable.
   */
  const [saved, setSaved] = useState<string[] | null>(null);

  const times = useMemo(() => {
    if (saved) return saved;
    if (server.loading) return null;
    // A failed read shows the empty state rather than nothing: the offer to
    // set a reminder is still true, and the save that follows would work.
    return (server.data?.data ?? []).map((row) => row.time).sort();
  }, [saved, server.loading, server.data]);

  const save = async (next: string[]) => {
    // Optimistic, then reconciled: the list is the person's own input, so
    // showing it immediately is honest, and a failure puts back what was real.
    const previous = times ?? [];
    setSaved(next);
    setSaving(true);
    setError(null);
    try {
      await medicationReminders.set(prescriptionId, next);
    } catch {
      setSaved(previous);
      setError(tr("Could not save. Try again.", "Save nahi hua. Dobara koshish karein."));
    } finally {
      setSaving(false);
    }
  };

  const add = (time?: string) => {
    const wanted = time ?? draft;
    if (!wanted) return;
    const current = times ?? [];
    if (current.includes(wanted)) {
      setDraft("");
      return;
    }
    if (current.length >= MAX_TIMES) return;
    void save([...current, wanted].sort());
    setDraft("");
  };

  const remove = (time: string) => void save((times ?? []).filter((t) => t !== time));

  if (times === null) return null;

  if (!open && times.length === 0) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary transition hover:bg-gradient-soft"
      >
        <Icon name="alarm_add" className="text-[18px]" />
        {tr("Remind me to take this", "Mujhe yaad dilayein")}
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-line bg-sunken p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-strong">
          <Icon name="alarm" className="text-[18px] text-primary" />
          {tr("Reminders", "Reminders")}
        </span>
        {times.map((time) => (
          <Badge key={time} tone="info">
            {time}
            <button
              type="button"
              onClick={() => remove(time)}
              disabled={saving}
              // The label carries the time so a screen reader announces which
              // one this removes — six identical "Remove" buttons help nobody.
              aria-label={tr(`Remove reminder at ${time}`, `${time} ka reminder hatayein`)}
              className="-mr-1 ml-0.5 grid h-5 w-5 place-items-center rounded-full transition hover:bg-card"
            >
              <Icon name="close" className="text-[14px]" />
            </button>
          </Badge>
        ))}
        {times.length === 0 && (
          <span className="text-sm text-muted">
            {tr("None set yet.", "Abhi koi nahi.")}
          </span>
        )}
      </div>

      {times.length < MAX_TIMES && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <TimePicker
            label={tr("Add a time", "Waqt shamil karein")}
            value={draft}
            onChange={setDraft}
            // Choosing a minute finishes the choice, so the reminder is added
            // there and then rather than making somebody reach for a button
            // they have already earned.
            onCommit={(time) => add(time)}
            disabled={saving}
          />
          <Button variant="secondary" onClick={() => add()} disabled={!draft || saving}>
            {tr("Add", "Shamil karein")}
          </Button>
        </div>
      )}

      <p className="mt-2 text-xs text-faint">
        {tr(
          "Sent to devices where you have turned notifications on. Stops by itself when the medicine is discontinued.",
          "Un devices par jahan aap ne notifications on ki hain. Dawa band hone par yeh khud ruk jate hain.",
        )}
      </p>

      {error && (
        <p role="alert" className="mt-2 text-xs font-medium text-critical">
          {error}
        </p>
      )}
    </div>
  );
}
