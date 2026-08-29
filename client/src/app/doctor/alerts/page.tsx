"use client";

/**
 * The doctor's live alert queue (spec §16).
 *
 * Scoped by the API to this doctor's caseload; there is no patient filter here
 * to widen it.
 */

import { AppShell } from "@/components/AppShell";
import { AlertsPanel } from "@/components/vitals";

export default function DoctorAlerts() {
  return (
    <AppShell role="DOCTOR">
      <div id="main">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Alerts</h1>
        <p className="mt-1 max-w-2xl text-slate-600 dark:text-slate-400">
          Raised automatically when a patient&rsquo;s reading crosses its configured threshold.
          Updates arrive as they happen — this page does not poll.
        </p>

        <div className="mt-6">
          <AlertsPanel />
        </div>
      </div>
    </AppShell>
  );
}
