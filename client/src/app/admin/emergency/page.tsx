"use client";

/**
 * The break-glass review queue.
 *
 * This is the control the whole emergency-access design rests on: access is
 * granted without approval, so what keeps it honest is that somebody reads
 * every grant afterwards.
 */

import { AppShell } from "@/components/AppShell";
import { EmergencyReviewPanel } from "@/components/emergency";

export default function AdminEmergency() {
  return (
    <AppShell role="ADMIN">
      <div id="main">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
          Emergency access
        </h1>
        <p className="mt-1 max-w-2xl text-slate-600 dark:text-slate-400">
          Break-glass access is granted immediately — a clinician who cannot get in during an
          emergency is a clinician who starts sharing logins. Reviewing each grant afterwards is
          what makes that safe, so nothing here is closed until someone has read it.
        </p>

        <div className="mt-6">
          <EmergencyReviewPanel />
        </div>
      </div>
    </AppShell>
  );
}
