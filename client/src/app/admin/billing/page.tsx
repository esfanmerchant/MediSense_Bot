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
            "Every invoice in the hospital. An issued invoice is never edited — cancel it, or issue a credit note against it, and both stay on the record.",
            "Hospital ka har invoice. Jari shuda invoice kabhi badla nahi jaata — usay mansookh karein ya credit note banayein, dono record par rehte hain.",
          )}
        />

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
