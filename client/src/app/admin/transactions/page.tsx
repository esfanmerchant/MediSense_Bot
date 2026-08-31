"use client";

/**
 * Every transfer the platform has been told about.
 *
 * The payment queue answers "what needs me now" and shows nothing else, which
 * is right for a queue and left a gap: once a payment was confirmed it vanished
 * from that screen and appeared nowhere. The money existed in an invoice's
 * status and a doctor's balance, and the transfer itself — the thing anyone
 * reconciling against a bank statement actually looks for — had no page.
 *
 * So each row carries both ends and the split. **From** the patient, by name.
 * **To** the wallet, with the receiving account where the screenshot showed
 * one. And what the money is made of, taken from the invoice as it was issued
 * rather than recomputed from today's rates: the consultation fee belongs to
 * the doctor, the platform fee and the tax to MediSense. A bill from March must
 * still explain March's numbers after somebody edits the rates in April.
 */

import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { Segmented } from "@/components/forms";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  SkeletonRows,
} from "@/components/ui";
import { paymentReview, type LedgerPayment, type PaymentClaimStatus } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { PAGE_REFRESH_MS, useAsync } from "@/lib/useAsync";

type Tab = "all" | PaymentClaimStatus;

const TONE: Record<PaymentClaimStatus, "info" | "good" | "critical"> = {
  SUBMITTED: "info",
  SUCCEEDED: "good",
  FAILED: "critical",
};

function money(amount: string, currency: string) {
  return `${currency} ${amount}`;
}

/**
 * One transfer.
 *
 * Laid out as a statement line rather than a card of controls: nothing here is
 * decided, and anything that still needs deciding belongs in the queue where a
 * reviewer has the screenshot in front of them.
 */
function Row({ payment }: { payment: LedgerPayment }) {
  const tr = useTr();
  const LABEL: Record<PaymentClaimStatus, [string, string]> = {
    SUBMITTED: ["Awaiting review", "Tasdeeq baqi"],
    SUCCEEDED: ["Confirmed", "Tasdeeq shuda"],
    FAILED: ["Rejected", "Mustarad"],
  };

  return (
    <tr>
      <td className="whitespace-nowrap text-muted">
        {payment.createdAt ? new Date(payment.createdAt).toLocaleDateString() : "—"}
      </td>
      <td>
        <span className="font-semibold text-strong">{payment.payerName}</span>
        <span className="mt-0.5 block text-xs text-muted">{payment.invoiceNumber}</span>
      </td>
      <td>
        <span className="text-strong">{payment.method}</span>
        {payment.receiverAccount && (
          <span className="mt-0.5 block font-mono text-xs text-muted">
            {payment.receiverAccount}
          </span>
        )}
      </td>
      <td className="select-all font-mono text-sm">{payment.reference ?? "—"}</td>
      <td className="text-right font-semibold tabular-nums text-strong">
        {money(payment.amount, payment.currency)}
      </td>
      {/* The split, as the invoice recorded it. */}
      <td className="text-right tabular-nums text-muted">{payment.doctorShare}</td>
      <td className="text-right tabular-nums text-muted">
        {(Number(payment.platformFee) + Number(payment.tax)).toFixed(2)}
      </td>
      <td>
        <Badge tone={TONE[payment.status]}>{tr(...LABEL[payment.status])}</Badge>
        {payment.reviewedBy && (
          <span className="mt-0.5 block text-xs text-muted">{payment.reviewedBy}</span>
        )}
        {payment.receipt && payment.receipt.concerns.length > 0 && (
          <span className="mt-1 flex items-center gap-1 text-xs font-medium text-warning">
            <Icon name="warning" className="text-[14px]" />
            {tr(
              `${payment.receipt.concerns.length} flagged`,
              `${payment.receipt.concerns.length} nishan-zad`,
            )}
          </span>
        )}
      </td>
    </tr>
  );
}

export default function TransactionsPage() {
  const tr = useTr();
  const [tab, setTab] = useState<Tab>("all");

  const ledger = useAsync(
    () => paymentReview.ledger({ status: tab === "all" ? undefined : tab, limit: 100 }),
    [tab],
    { refreshMs: PAGE_REFRESH_MS },
  );

  const rows = useMemo(() => ledger.data?.data ?? [], [ledger.data]);

  // What has actually been received, which is not the same as what has been
  // claimed — a submitted transfer is somebody's word, and a rejected one is
  // money that never arrived. Only confirmed payments count toward a total.
  const received = useMemo(
    () =>
      rows
        .filter((row) => row.status === "SUCCEEDED")
        .reduce((sum, row) => sum + Number(row.amount), 0),
    [rows],
  );

  const options: { value: Tab; label: string; icon?: string }[] = [
    { value: "all", label: tr("All", "Sab") },
    { value: "SUCCEEDED", label: tr("Confirmed", "Tasdeeq shuda"), icon: "task_alt" },
    { value: "SUBMITTED", label: tr("Awaiting review", "Tasdeeq baqi"), icon: "hourglass_top" },
    { value: "FAILED", label: tr("Rejected", "Mustarad"), icon: "cancel" },
  ];

  return (
    <AppShell role="ADMIN">
      <div id="main" className="page-enter space-y-6">
        <PageHeader
          eyebrow={tr("Administration", "Intezamia")}
          title={tr("Transactions", "Transactions")}
          subtitle={tr(
            "Every transfer patients have reported, who it came from and where it went.",
            "Har transfer jo mareezon ne bataya — kis se aaya aur kahan gaya.",
          )}
        />

        <Segmented
          options={options}
          value={tab}
          onChange={setTab}
          label={tr("Filter transactions", "Transactions chhantein")}
        />

        {ledger.loading && <SkeletonRows rows={6} />}
        {ledger.error && <ErrorState message={ledger.error.message} onRetry={ledger.reload} />}

        {ledger.data && (
          <Card
            icon="receipt_long"
            title={tr("Transfers", "Transfers")}
            description={
              tab === "SUCCEEDED" || tab === "all"
                ? tr(
                    `${received.toFixed(2)} confirmed as received on this page.`,
                    `Is page par ${received.toFixed(2)} wasool shuda tasdeeq shuda hai.`,
                  )
                : tr("Newest first.", "Sab se naya pehle.")
            }
          >
            {rows.length === 0 ? (
              <EmptyState
                icon="receipt_long"
                title={tr("Nothing here", "Yahan kuch nahi")}
                description={tr(
                  "No transfers match this filter.",
                  "Is filter par koi transfer nahi.",
                )}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="table-modern min-w-[56rem]">
                  <caption className="sr-only">
                    {tr("Payment transactions", "Adaigi ke transactions")}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{tr("Date", "Tareekh")}</th>
                      <th scope="col">{tr("From", "Kis se")}</th>
                      <th scope="col">{tr("To", "Kahan")}</th>
                      <th scope="col">{tr("Transaction ID", "Transaction ID")}</th>
                      <th scope="col" className="!text-right">
                        {tr("Amount", "Raqam")}
                      </th>
                      <th scope="col" className="!text-right">
                        {tr("Doctor", "Doctor")}
                      </th>
                      <th scope="col" className="!text-right">
                        {tr("MediSense", "MediSense")}
                      </th>
                      <th scope="col">{tr("Status", "Halat")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((payment) => (
                      <Row key={payment.id} payment={payment} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
    </AppShell>
  );
}
