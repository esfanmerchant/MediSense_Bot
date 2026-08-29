"use client";

/**
 * The patient's own readings.
 *
 * Read-only: a patient holds `vital:read:own` and no write permission, because
 * a self-reported observation would be indistinguishable from a measured one
 * once stored and the threshold engine would alert on it.
 */

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, Loading } from "@/components/ui";
import { ThresholdsPanel, VitalsTable } from "@/components/vitals";
import { useTr } from "@/lib/lang";
import { useSession } from "@/lib/session";

export default function PatientVitals() {
  const { user, loading } = useSession();
  const tr = useTr();

  return (
    <AppShell role="PATIENT">
      <div id="main">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Vitals", "Vitals")}
          subtitle={tr(
            "Observations recorded by your care team. If a reading crosses a threshold, the doctor responsible for you is notified automatically.",
            "Aap ki care team ki darj ki hui readings. Koi reading had paar kare to aap ke zimmedar doctor ko khud-ba-khud ittila milti hai.",
          )}
        />

        {loading && <Loading label={tr("Loading your readings", "Readings load ho rahi hain")} />}

        {!loading && !user?.patientId && (
          <ErrorState
            title="No patient record"
            message="This account is not linked to a patient record. Contact an administrator."
          />
        )}

        {user?.patientId && (
          <div className="mt-6 space-y-6">
            <VitalsTable patientId={user.patientId} />
            <ThresholdsPanel patientId={user.patientId} />
          </div>
        )}
      </div>
    </AppShell>
  );
}
