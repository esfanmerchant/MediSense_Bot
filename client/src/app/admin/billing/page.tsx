"use client";

/**
 * The hospital ledger.
 *
 * Administrators hold `invoice:read:any` and `invoice:manage`, so this is the
 * one place payments are recorded and corrections issued. The controls render
 * here because of the role, but the API re-checks every request (spec §34).
 */

import { AppShell } from "@/components/AppShell";
import { InvoicesPanel } from "@/components/billing";

export default function AdminBilling() {
  return (
    <AppShell role="ADMIN">
      <div id="main">
        <h1 className="text-2xl font-semibold text-strong">Billing</h1>
        <p className="mt-1 max-w-2xl text-muted">
          Every invoice in the hospital. An issued invoice is never edited — cancel it, or issue a
          credit note against it, and both stay on the record.
        </p>

        <div className="mt-6">
          <InvoicesPanel
            canManage
            title="All invoices"
            description="Record payments, cancel unpaid invoices, and issue credit notes."
          />
        </div>
      </div>
    </AppShell>
  );
}
