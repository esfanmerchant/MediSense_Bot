"use client";

/**
 * Today's medicines, in order, with a box against each.
 *
 * Built from the prescriptions a doctor wrote and the times the patient chose,
 * because those are two different people's decisions and neither may stand in
 * for the other: the doctor says what and how much, the patient says when they
 * are awake to take it.
 *
 * **It empties itself at midnight.** Nothing resets it — the ticks are stored
 * against a clinic-local date, so tomorrow's list is the same query returning
 * nothing ticked. A nightly job would be one more thing that can fail while
 * everybody is asleep and leave somebody looking at yesterday.
 *
 * **A tick is a note to self, not a clinical record.** It says the box was
 * pressed. Nothing here treats it as evidence a medicine was swallowed, and no
 * clinician is shown it as adherence data.
 */

import { useMemo, useState } from "react";

import { Icon } from "@/components/Icon";
import { Card, EmptyState, cx } from "@/components/ui";
import { medicationReminders, type MedicationDoseToday } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

/** Minutes past midnight, now, in the browser's own clock. */
function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

export function MedicationToday() {
  const tr = useTr();
  // Refreshed on return rather than on a timer: the list changes when the
  // person acts on it, and a poll would fight a half-pressed checkbox.
  const server = useAsync(() => medicationReminders.today(), [], { live: "on-return" });

  /** Ticks this page has made, which are newer than the fetch. */
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const doses = useMemo(() => {
    const rows = server.data?.data ?? [];
    return rows.map((row) => ({ ...row, taken: local[row.reminderId] ?? row.taken }));
  }, [server.data, local]);

  const toggle = async (dose: MedicationDoseToday & { taken: boolean }) => {
    const next = !dose.taken;
    // Optimistic: it is the person's own tick, so it should land under their
    // finger, not after a round trip.
    setLocal((m) => ({ ...m, [dose.reminderId]: next }));
    setBusy(dose.reminderId);
    try {
      if (next) await medicationReminders.markTaken(dose.reminderId);
      else await medicationReminders.unmarkTaken(dose.reminderId);
    } catch {
      setLocal((m) => ({ ...m, [dose.reminderId]: dose.taken }));
    } finally {
      setBusy(null);
    }
  };

  if (server.loading || doses.length === 0) {
    // Nothing prescribed, or no times set yet. The prompt to set them lives on
    // the prescription itself, where the medicine it belongs to is in view.
    if (server.loading) return null;
    return (
      <Card title={tr("Today's medicines", "Aaj ki dawaiyan")} icon="pill" flush>
        <EmptyState
          icon="pill_off"
          title={tr("Nothing due today", "Aaj kuch nahi")}
          description={tr(
            "Set reminder times on a prescription and its doses appear here.",
            "Kisi nuskhe par reminder ka waqt muqarrar karein, uski doses yahan aa jayengi.",
          )}
        />
      </Card>
    );
  }

  const taken = doses.filter((d) => d.taken).length;
  const now = nowMinutes();

  return (
    <Card
      title={tr("Today's medicines", "Aaj ki dawaiyan")}
      description={tr(
        `${taken} of ${doses.length} taken. The list starts again at midnight.`,
        `${doses.length} mein se ${taken} li gayin. Yeh fehrist raat 12 baje se dobara shuru hoti hai.`,
      )}
      icon="pill"
      flush
    >
      {/* A progress rail rather than a number alone: the point of a checklist
          is seeing how much of it is left without counting. */}
      <div className="px-6 pb-1 pt-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
          <div
            className="bg-gradient-brand h-full rounded-full transition-[width] duration-500"
            style={{ width: `${Math.round((taken / doses.length) * 100)}%` }}
          />
        </div>
      </div>

      <ul className="divide-y divide-line">
        {doses.map((dose) => {
          // "Late" is only meaningful for something not yet ticked; a dose
          // taken at 09:05 is not late, it is done.
          const late = !dose.taken && dose.atMinutes < now - 30;
          return (
            <li key={dose.reminderId}>
              <label
                className={cx(
                  "flex cursor-pointer items-start gap-3.5 px-6 py-4 transition-colors",
                  "hover:bg-sunken",
                  busy === dose.reminderId && "opacity-60",
                )}
              >
                <input
                  type="checkbox"
                  checked={dose.taken}
                  disabled={busy === dose.reminderId}
                  onChange={() => void toggle(dose)}
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className={cx(
                    "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 transition-colors",
                    dose.taken
                      ? "border-primary bg-primary text-primary-on"
                      : "border-line-strong",
                  )}
                >
                  {dose.taken && <Icon name="check" className="text-[16px]" />}
                </span>

                <span className="min-w-0 flex-1">
                  <span
                    className={cx(
                      "block font-semibold text-strong",
                      dose.taken && "line-through opacity-60",
                    )}
                  >
                    {dose.medication}{" "}
                    <span className="font-normal text-muted">· {dose.dosage}</span>
                  </span>
                  {dose.instructions && (
                    <span className="mt-0.5 block text-sm text-muted">{dose.instructions}</span>
                  )}
                </span>

                <span
                  className={cx(
                    "mono-caps shrink-0 rounded-lg px-2 py-1 text-xs tabular-nums",
                    dose.taken
                      ? "bg-sunken text-faint"
                      : late
                        ? "bg-warning-soft text-warning"
                        : "bg-gradient-soft text-primary",
                  )}
                >
                  {dose.time}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <p className="border-t border-line px-6 py-3 text-xs leading-relaxed text-faint">
        {tr(
          "This is your own checklist. It is not shared with your doctor and is not a record that a medicine was taken.",
          "Yeh aap ki apni fehrist hai. Yeh doctor ko nahi dikhti aur na hi is ka matlab hai ke dawa li gayi.",
        )}
      </p>
    </Card>
  );
}
