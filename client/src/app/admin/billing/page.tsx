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
import {
  PageSectionNav,
  Section,
  type Section as SectionSpec,
} from "@/components/layout/PageSectionNav";
import { useTr } from "@/lib/lang";
import { BillingRates } from "@/components/BillingRates";
import { PaymentAccount } from "@/components/PaymentAccount";
import { PaymentQueue } from "@/components/PaymentQueue";
import { InvoicesPanel } from "@/components/billing";

const SECTIONS: SectionSpec[] = [
  { id: "to-confirm", label: "To confirm", icon: "fact_check", badge: "warning" },
  { id: "rates", label: "Rates", icon: "percent" },
  { id: "wallets", label: "Wallets", icon: "account_balance_wallet" },
  { id: "invoices", label: "Invoices", icon: "receipt_long" },
];

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

        {/* Payments waiting on somebody come first: it is the only thing on
            this page that is *work*, and the rest is reference. */}
        <PageSectionNav mode="jump" label="Sections" sections={SECTIONS} />

        <Section id="to-confirm">
<div className="mt-6">
          <PaymentQueue />
        </div>

        {/* Then the settings that shape what the ledger below will look like. */}
        
        </Section>

        <Section id="rates">
<div className="mt-6">
          <BillingRates />
        </div>

        
        </Section>

        <Section id="wallets">
<div className="mt-6">
          <PaymentAccount />
        </div>

        
        </Section>

        <Section id="invoices">
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
        </Section>

        
      </div>
    </AppShell>
  );
}
