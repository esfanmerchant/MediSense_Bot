"use client";

/**
 * The patient's own readings.
 *
 * Read-only: a patient holds `vital:read:own` and no write permission, because
 * a self-reported observation would be indistinguishable from a measured one
 * once stored and the threshold engine would alert on it.
 */

import { AppShell } from "@/components/AppShell";
import {
  PageSectionNav,
  Section,
  type Section as SectionSpec,
} from "@/components/layout/PageSectionNav";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, SkeletonRows } from "@/components/ui";
import { ThresholdsPanel, VitalsTable } from "@/components/vitals";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";

const SECTIONS: SectionSpec[] = [
  { id: "readings", label: "Readings", icon: "monitor_heart" },
  { id: "thresholds", label: "Alert thresholds", icon: "tune" },
];

export default function PatientVitals() {
  const { user, loading } = useSession();
  const tr = useTr();

  return (
    <AppShell role="PATIENT">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Vitals", "Vitals")}
          subtitle={tr(
            "Observations recorded by your care team. If a reading crosses a threshold, the doctor responsible for you is notified automatically.",
            "Aap ki care team ki darj ki hui readings. Koi reading had paar kare to aap ke zimmedar doctor ko khud-ba-khud ittila milti hai.",
          )}
        />

        {loading && (
          <div role="status" aria-live="polite" className="mt-6">
            <span className="sr-only">{tr("Loading your readings", "Readings load ho rahi hain")}…</span>
            <SkeletonRows rows={3} />
          </div>
        )}

        {!loading && !user?.patientId && (
          <div className="mt-6">
            <ErrorState
              title="No patient record"
              message="This account is not linked to a patient record. Contact an administrator."
            />
          </div>
        )}

        {user?.patientId && (
          <div className="mt-6 space-y-6">
            <PageSectionNav mode="jump" label="Sections" sections={SECTIONS} />
            {/* The snapshot — gauges and a trend — sits above the table, fed
                from the same fetch, so the two never disagree. */}
            <Section id="readings">
              <VitalsTable patientId={user.patientId} snapshot />
            </Section>
            <Section id="thresholds">
              <ThresholdsPanel patientId={user.patientId} />
            </Section>
          </div>
        )}
      </div>
    </AppShell>
  );
}
