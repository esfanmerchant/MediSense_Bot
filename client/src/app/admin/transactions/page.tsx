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
 * So each row carries both ends and the split. **From** the patient, their
 * invoice, and the account their screenshot says the money left. **To** the
 * service and the account that same screenshot says it went to — including a
 * service this system has no name for, since a patient may pay from JazzCash or
 * a bank app while `method` only knows the two options they were offered.
 *
 * Both ends are read off the image, and the page never pretends otherwise: an
 * account the model could not make out prints "not read" rather than nothing,
 * because a column that goes quiet on failure looks exactly like one where no
 * account was involved.
 *
 * None of it is *asserted*. Whether the money reached the account this patient
 * was actually given is a separate question — checked against the account
 * snapshotted on the payment, and answered by the flag in the status column, so
 * a wrong destination stays visible as a wrong destination instead of being
 * silently corrected into looking right.
 *
 * And what the money is made of, taken from the invoice as it was issued rather
 * than recomputed from today's rates: the consultation fee belongs to the
 * doctor, the platform fee and the tax to MediSense. A bill from March must
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
 * An account number read off a screenshot, or an honest admission that it was
 * not.
 *
 * The blank matters. Every number in the two columns either side of this comes
 * from a model reading an image, and a column that renders nothing when the
 * reading failed looks identical to one where no account was involved. Saying
 * "not read" costs a line and stops a reviewer inferring something that was
 * never established.
 */
function Account({ value }: { value: string | null }) {
  const tr = useTr();
  if (!value) {
    return (
      <span className="mt-0.5 block text-xs italic text-faint">
        {tr("account not read", "account nahi parha gaya")}
      </span>
    );
  }
  return <span className="mt-0.5 block select-all font-mono text-xs text-muted">{value}</span>;
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
      {/* From: who, which bill, and the account their screenshot says it left. */}
      <td>
        <span className="font-semibold text-strong">{payment.payerName}</span>
        <span className="mt-0.5 block text-xs text-faint">{payment.invoiceNumber}</span>
        <Account value={payment.payerAccount} />
      </td>
      {/* To: the service and the account that same screenshot says it went to.
          Both read off the image, which is why `Account` prints "not read"
          rather than a blank when the model could not make one out — a column
          that goes quiet on failure reads as "no account was involved".
          Whether that destination is the account this patient was actually
          given is a different question, answered by the flag below. */}
      <td>
        <span className="text-strong">{payment.receiptWallet ?? payment.method}</span>
        <Account value={payment.receiptReceiverAccount} />
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
                {/* Said once, above the table, rather than repeated in every
                    cell. Both account columns are transcriptions of an image,
                    and a reviewer reading this page as a bank statement would
                    otherwise take them for facts the system had established. */}
                <p className="mb-3 flex items-start gap-2 text-xs text-muted">
                  <Icon name="document_scanner" className="mt-px shrink-0 text-[15px]" />
                  <span>
                    {tr(
                      "The account numbers under From and To are read from the uploaded screenshot, not verified. A transfer that reached the wrong account is flagged in Status.",
                      "From aur To ke account numbers upload ki gayi screenshot se parhe gaye hain, tasdeeq shuda nahi. Galat account mein gaya transfer Status mein nishan-zad hota hai.",
                    )}
                  </span>
                </p>
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
