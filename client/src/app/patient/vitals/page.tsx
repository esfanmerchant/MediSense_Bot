"use client";

/**
 * The patient's own readings.
 *
 * Read-only: a patient holds `vital:read:own` and no write permission, because
 * a self-reported observation would be indistinguishable from a measured one
 * once stored and the threshold engine would alert on it.
 */

import { AppShell } from "@/components/AppShell";
import { ErrorState, Loading } from "@/components/ui";
import { ThresholdsPanel, VitalsTable } from "@/components/vitals";
import { useSession } from "@/lib/session";

export default function PatientVitals() {
  const { user, loading } = useSession();

  return (
    <AppShell role="PATIENT">
      <div id="main">
        <h1 className="text-2xl font-semibold text-strong">Vitals</h1>
        <p className="mt-1 max-w-2xl text-muted">
          Observations recorded by your care team. If a reading crosses a threshold, the doctor
          responsible for you is notified automatically.
        </p>

        {loading && <Loading label="Loading your readings" />}

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
