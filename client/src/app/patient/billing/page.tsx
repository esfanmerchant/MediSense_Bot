"use client";

/**
 * The patient's own invoices.
 *
 * No patient id in the route and no way to supply one: the API scopes the
 * ledger to the signed-in patient.
 */

import { AppShell } from "@/components/AppShell";
import { InvoicesPanel } from "@/components/billing";

export default function PatientBilling() {
  return (
    <AppShell role="PATIENT">
      <div id="main">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">Billing</h1>
        <p className="mt-1 max-w-2xl text-slate-600 dark:text-slate-400">
          An invoice is created automatically when a consultation is completed. Payments are
          recorded by the hospital&rsquo;s billing desk.
        </p>

        <div className="mt-6">
          <InvoicesPanel
            title="Your invoices"
            description="Newest first. Open one to see what was charged."
          />
        </div>
      </div>
    </AppShell>
  );
}
