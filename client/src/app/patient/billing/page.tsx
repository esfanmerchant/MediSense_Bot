"use client";

/**
 * The patient's own invoices.
 *
 * No patient id in the route and no way to supply one: the API scopes the
 * ledger to the signed-in patient.
 */

import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { useTr } from "@/lib/lang";
import { InvoicesPanel } from "@/components/billing";

export default function PatientBilling() {
  const tr = useTr();
  return (
    <AppShell role="PATIENT">
      <div id="main" className="page-enter">
        <PageHeader
          eyebrow={tr("Patient portal", "Mareez ka portal")}
          title={tr("Billing", "Billing")}
          subtitle={tr(
            "Raised automatically when a consultation is completed.",
            "Consultation mukammal hote hi invoice khud ban jaata hai. Adaigi hospital ka billing desk darj karta hai.",
          )}
        />

        <div className="pop-in mt-6">
          <InvoicesPanel
            title={tr("Your invoices", "Aap ke invoices")}
            description={tr(
              "Newest first. Open one to see what was charged.",
              "Sab se naya pehle. Kholein aur dekhein kya charge hua.",
            )}
          />
        </div>
      </div>
    </AppShell>
  );
}
