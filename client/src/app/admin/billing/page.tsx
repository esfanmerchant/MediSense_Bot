"use client";

/**
 * The hospital ledger.
 *
 * Administrators hold `invoice:read:any` and `invoice:manage`, so this is the
 * one place payments are recorded and corrections issued. The controls render
 * here because of the role, but the API re-checks every request (spec §34).
 */

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { useTr } from "@/lib/lang";
import { BillingRates } from "@/components/BillingRates";
import { InvoicesPanel } from "@/components/billing";

export default function AdminBilling() {
  const tr = useTr();
  return (
    <AppShell role="ADMIN">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Admin portal", "Intezami portal")}
          title={tr("Billing", "Billing")}
          subtitle={tr(
            "Every invoice in the hospital. An issued one is never edited.",
            "Hospital ka har invoice. Jari shuda kabhi badla nahi jaata.",
          )}
        />

        {/* The rates first: they decide what every invoice below will look
            like, so reading them before the ledger is the right order. */}
        <div className="mt-6">
          <BillingRates />
        </div>

        <div className="mt-6">
          <InvoicesPanel
            canManage
            title={tr("All invoices", "Tamam invoices")}
            description={tr(
              "Record payments, cancel unpaid invoices, and issue credit notes.",
              "Adaigi darj karein, ghair-ada invoices mansookh karein, aur credit notes banayein.",
            )}
          />
        </div>
      </div>
    </AppShell>
  );
}
