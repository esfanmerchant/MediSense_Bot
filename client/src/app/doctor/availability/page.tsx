"use client";

/**
 * When a doctor is available — recurring hours, and the days they are away.
 *
 * Its own page rather than a tab on `/doctor/settings`: that screen is
 * `AccountSettings`, one body deliberately shared by all three portals, whose
 * tabs are all facts about an *account* — the password, the second factor, the
 * theme. Availability is none of those. It is clinical configuration that
 * decides what a patient can do, it belongs to doctors alone, and putting it
 * there would mean forking a component whose whole point is that it is not
 * forked. A page of its own also gives the empty state somewhere to be linked
 * *to* — the dashboard's "patients cannot book you" line needs a destination.
 *
 * The weekly hours and the leave card sit together because they are the same
 * question asked twice: "when can somebody book me" and "except when".
 */

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { TimeOffCard } from "@/components/TimeOffCard";
import { WeeklySchedule } from "@/components/availability/WeeklySchedule";
import { PracticeLocationCard } from "@/components/doctors/PracticeLocationCard";
import { useTr } from "@/lib/lang";

export default function DoctorAvailabilityPage() {
  const tr = useTr();

  return (
    <AppShell role="DOCTOR">
      <div id="main" className="page-enter space-y-6">
        <PageHeader
          eyebrow={tr("Doctor portal", "Doctor ka portal")}
          title={tr("Availability", "Dastyabi")}
          subtitle={tr(
            "When patients can book you, and when you are away.",
            "Kab mareez aap ko book kar sakte hain, aur kab aap dastyab nahi.",
          )}
        />

        <WeeklySchedule />
        {/* Hours decide whether slots exist; a city decides whether anybody
            browsing the directory ever sees them. Both belong here. */}
        <PracticeLocationCard />
        <TimeOffCard />
      </div>
    </AppShell>
  );
}
