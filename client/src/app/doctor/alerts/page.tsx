"use client";

/**
 * The doctor's live alert queue (spec §16).
 *
 * Scoped by the API to this doctor's caseload; there is no patient filter here
 * to widen it.
 */

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { useTr } from "@/lib/lang";
import { AlertsPanel } from "@/components/vitals";

export default function DoctorAlerts() {
  const tr = useTr();
  return (
    <AppShell role="DOCTOR">
      <div id="main">
        <PageHeader
          eyebrow={tr("Doctor portal", "Doctor ka portal")}
          title={tr("Alerts", "Alerts")}
          subtitle={tr(
            "Raised automatically when a patient's reading crosses its configured threshold. Updates arrive as they happen — this page does not poll.",
            "Jab kisi mareez ki reading muqarrar had paar karti hai to alert khud uthta hai. Updates usi lamhe pahunchti hain.",
          )}
        />

        <div className="mt-6">
          <AlertsPanel />
        </div>
      </div>
    </AppShell>
  );
}
