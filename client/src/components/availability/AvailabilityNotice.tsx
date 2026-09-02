"use client";

/**
 * One line on the doctor's dashboard, when there is something to say.
 *
 * A doctor whose availability is empty is invisible to the booking screen and
 * has no way of knowing it: their dashboard shows nothing scheduled, no
 * patients booking, and no reason for either. That silence is the bug this
 * line exists to break — so it points at the editor rather than merely
 * reporting the state.
 *
 * It renders nothing at all when there is nothing wrong, and nothing when the
 * request fails: a dashboard is not the place to report that a secondary
 * lookup did not load, and the availability page says the same thing properly.
 */

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { cx } from "@/components/ui";
import { doctors } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

export function AvailabilityNotice() {
  const tr = useTr();
  const profile = useAsync(() => doctors.me());

  if (!profile.data) return null;

  const noHours = profile.data.availability.length === 0;
  const paused = !profile.data.acceptingPatients;
  if (!noHours && !paused) return null;

  const message = noHours
    ? tr(
        "Patients cannot book you: you have not set any available days or times yet.",
        "Mareez aap ki appointment book nahi kar sakte: aap ne abhi tak koi din ya waqt set nahi kiya.",
      )
    : tr(
        "New bookings are paused. Your hours are published, but nobody can book them.",
        "Nayi bookings roki gayi hain. Aap ke auqat shaya hain, magar koi book nahi kar sakta.",
      );

  return (
    <div
      role="status"
      className={cx(
        "pop-in flex flex-wrap items-center gap-3 rounded-2xl border p-4",
        noHours ? "border-critical/40 bg-critical-soft" : "border-warning/40 bg-warning-soft",
      )}
    >
      <Icon
        name={noHours ? "event_busy" : "pause_circle"}
        filled
        className={cx("shrink-0 text-[22px]", noHours ? "text-critical" : "text-warning")}
      />
      <p className="min-w-0 flex-1 text-sm font-medium text-strong">{message}</p>
      <Link
        href="/doctor/availability"
        className="inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-sm font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {noHours
          ? tr("Set your availability", "Apni dastyabi set karein")
          : tr("Manage availability", "Dastyabi sanbhalein")}
        <Icon name="arrow_forward" className="text-[18px]" />
      </Link>
    </div>
  );
}
