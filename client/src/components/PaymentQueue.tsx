"use client";

/**
 * The queue where somebody decides whether the money actually arrived.
 *
 * This screen is the only thing standing between a hospital's bills and anybody
 * who can take a screenshot, so it is built to be *checked against something
 * else* rather than to look convincing on its own. The reviewer is expected to
 * have their banking app open beside it; everything here exists to make that
 * comparison quick — the amount, the reference, and the picture, side by side
 * and large enough to read.
 *
 * **Confirming pays the bill.** The button says so, because a reviewer who
 * thinks they are filing a note rather than settling a debt will be careless
 * with it exactly once.
 *
 * A refusal requires a sentence. The patient reads it, and somebody who has
 * genuinely paid needs to know whether to re-upload, transfer again, or come to
 * the desk — "rejected" on its own tells them none of that.
 */

import { useCallback, useState } from "react";

import { Icon } from "@/components/Icon";
import { Dialog, useToast } from "@/components/overlays";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SkeletonRows,
  cx,
} from "@/components/ui";
import {
  ApiError,
  paymentReview,
  type PendingPayment,
  type ReceiptConcern,
  type ReceiptReading,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync, QUEUE_REFRESH_MS } from "@/lib/useAsync";

/**
 * What was read off the screenshot, beside what the patient typed.
 *
 * This is the only part of the queue that is not evidence, and it says so. A
 * model read the picture when it was uploaded; it can be wrong about a blurry
 * screenshot, and it has certainly not watched money arrive in anybody's
 * account. What it is reliably better than a tired person at is noticing that
 * two long reference numbers differ in the middle, or that a receipt is from
 * three weeks ago.
 *
 * So concerns are stated as questions for the reviewer, never as verdicts, and
 * a field the model could not read produces nothing at all rather than a
 * warning with no evidence behind it.
 */
function ReceiptReadout({
  receipt,
  typed,
  payeeAccount,
}: {
  receipt: ReceiptReading | null;
  typed: string | null;
  /** The account the patient was told to pay into, for the comparison below. */
  payeeAccount: string | null;
}) {
  const tr = useTr();
  if (!receipt) return null;

  const CONCERNS: Record<ReceiptConcern, [string, string]> = {
    NOT_A_RECEIPT: [
      "This image does not look like a payment receipt.",
      "Yeh tasveer adaigi ki raseed nahi lagti.",
    ],
    REFERENCE_MISMATCH: [
      `The receipt shows ${receipt.reference ?? "—"}, not ${typed ?? "—"}.`,
      `Raseed par ${receipt.reference ?? "—"} hai, ${typed ?? "—"} nahi.`,
    ],
    AMOUNT_MISMATCH: [
      `The receipt shows ${receipt.amount ?? "—"}, not the amount owed.`,
      `Raseed par ${receipt.amount ?? "—"} hai, jo waajib raqam nahi.`,
    ],
    STALE_RECEIPT: [
      `This transfer is more than ${receipt.maxAgeDays} days older than the submission.`,
      `Yeh transfer submission se ${receipt.maxAgeDays} din se zyada purana hai.`,
    ],
    WRONG_DESTINATION: [
      `The money went to ${receipt.receiverAccount ?? "another account"}, not to ${
        payeeAccount ?? "the account this patient was given"
      }.`,
      `Paisa ${receipt.receiverAccount ?? "kisi aur account"} mein gaya, ${
        payeeAccount ?? "us account"
      } mein nahi jo is mareez ko diya gaya tha.`,
    ],
    PAID_FROM_A_HOSPITAL_ACCOUNT: [
      "The sender is one of the hospital's own accounts — this receipt shows money leaving, not arriving.",
      "Bhejne wala hospital ka apna account hai — yeh raseed paisa jaate hue dikhati hai, aata hua nahi.",
    ],
  };

  const clean = receipt.concerns.length === 0;

  return (
    <div
      className={cx(
        "rounded-xl border p-3",
        clean ? "border-line bg-sunken" : "border-warning/50 bg-warning-soft",
      )}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-faint">
        <Icon name="document_scanner" className="text-[15px]" />
        {tr("Read from the screenshot", "Screenshot se parha gaya")}
      </p>

      <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
        {receipt.reference && (
          <div className="flex gap-2">
            <dt className="text-muted">{tr("Reference", "Reference")}</dt>
            <dd className="select-all font-mono font-semibold text-strong">{receipt.reference}</dd>
          </div>
        )}
        {receipt.amount && (
          <div className="flex gap-2">
            <dt className="text-muted">{tr("Amount", "Raqam")}</dt>
            <dd className="font-semibold tabular-nums text-strong">{receipt.amount}</dd>
          </div>
        )}
        {receipt.paidAt && (
          <div className="flex gap-2">
            <dt className="text-muted">{tr("Transferred", "Transfer hua")}</dt>
            <dd className="text-strong">{new Date(receipt.paidAt).toLocaleString()}</dd>
          </div>
        )}
        {receipt.senderAccount && (
          <div className="flex gap-2">
            <dt className="text-muted">{tr("From", "Kis se")}</dt>
            <dd className="font-mono text-strong">{receipt.senderAccount}</dd>
          </div>
        )}
        {receipt.receiverAccount && (
          <div className="flex gap-2">
            <dt className="text-muted">{tr("Into", "Kis account mein")}</dt>
            <dd className="font-mono text-strong">{receipt.receiverAccount}</dd>
          </div>
        )}
      </dl>

      {receipt.concerns.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {receipt.concerns.map((concern) => (
            <li key={concern} className="flex items-start gap-1.5 text-sm font-medium text-warning">
              <Icon name="warning" className="mt-px shrink-0 text-[16px]" />
              {tr(...CONCERNS[concern])}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2.5 text-xs text-faint">
        {tr(
          "Read automatically. Check the receiving account before confirming — this has not seen the money arrive.",
          "Khud-ba-khud parha gaya. Tasdeeq se pehle apna account khud dekh lein — is ne paisa aata nahi dekha.",
        )}
      </p>
    </div>
  );
}

function Claim({
  payment,
  onDecided,
}: {
  payment: PendingPayment;
  onDecided: () => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [zoomed, setZoomed] = useState(false);

  async function decide(action: "confirm" | "reject") {
    setBusy(true);
    try {
      if (action === "confirm") {
        await paymentReview.confirm(payment.id);
        toast.show({
          tone: "success",
          title: tr("Payment confirmed", "Adaigi tasdeeq ho gayi"),
          body: tr(
            `Invoice ${payment.invoiceNumber} is now marked paid.`,
            `Invoice ${payment.invoiceNumber} ab ada shuda hai.`,
          ),
        });
      } else {
        await paymentReview.reject(payment.id, reason.trim());
        toast.show({
          tone: "success",
          title: tr("Payment rejected", "Adaigi mustard ho gayi"),
          body: tr("The patient will see your reason.", "Mareez ko aap ki wajah dikhegi."),
        });
      }
      setRejecting(false);
      onDecided();
    } catch (cause) {
      toast.show({
        tone: "critical",
        title: tr("That did not work", "Yeh nahi ho saka"),
        body: cause instanceof ApiError ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-2xl border border-line bg-card p-4 shadow-card">
      <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
        {/* The picture, big enough to read a reference off without opening it,
            and openable when it is not. */}
        {payment.proofUrl ? (
          <button
            type="button"
            onClick={() => setZoomed(true)}
            className="group relative h-36 w-36 shrink-0 overflow-hidden rounded-xl border border-line bg-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={payment.proofUrl}
              alt={tr("Payment screenshot", "Adaigi ka screenshot")}
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
            />
            <span className="absolute inset-x-0 bottom-0 bg-black/55 py-1 text-center text-[11px] font-semibold text-white">
              {tr("Open", "Kholein")}
            </span>
          </button>
        ) : (
          <div className="grid h-36 w-36 shrink-0 place-items-center rounded-xl border border-line bg-sunken text-center text-xs text-muted">
            {tr("No screenshot", "Koi screenshot nahi")}
          </div>
        )}

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-display text-lg font-bold text-strong">
              {payment.currency} {payment.amount}
            </span>
            <Badge tone="neutral">{payment.method}</Badge>
            <span className="text-sm text-muted">
              {payment.patientName} · {payment.invoiceNumber}
            </span>
          </div>

          {/* The two things being compared with the banking app. Monospaced
              and selectable, because the reviewer will copy the reference. */}
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-wider text-faint">
                {tr("Transaction ID", "Transaction ID")}
              </dt>
              <dd className="select-all font-mono text-sm font-semibold text-strong">
                {payment.reference ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-wider text-faint">
                {tr("Submitted", "Bheja gaya")}
              </dt>
              <dd className="text-sm text-muted">
                {payment.createdAt ? new Date(payment.createdAt).toLocaleString() : "—"}
              </dd>
            </div>
          </dl>

          <ReceiptReadout
            receipt={payment.receipt}
            typed={payment.reference}
            payeeAccount={payment.payeeAccount}
          />

          {rejecting ? (
            <div className="space-y-3 rounded-xl border border-line bg-sunken p-3">
              <Field
                label={tr("Why is this being rejected?", "Yeh kyun mustarad ho raha hai?")}
                htmlFor={`reject-${payment.id}`}
                hint={tr(
                  "The patient reads this, so tell them what to do next.",
                  "Mareez yeh parhega — usse batayein ke ab kya kare.",
                )}
              >
                <Input
                  id={`reject-${payment.id}`}
                  value={reason}
                  maxLength={500}
                  autoFocus
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  loading={busy}
                  disabled={reason.trim().length < 3}
                  onClick={() => decide("reject")}
                >
                  {tr("Reject payment", "Adaigi mustarad karein")}
                </Button>
                <Button variant="ghost" onClick={() => setRejecting(false)}>
                  {tr("Cancel", "Cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button loading={busy} onClick={() => decide("confirm")}>
                <Icon name="check" className="text-[20px]" />
                {/* Names the consequence. A reviewer who thinks this files a
                    note rather than settling a debt is careless with it once. */}
                {tr("Confirm and mark paid", "Tasdeeq karein aur ada shuda karein")}
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(true)}>
                {tr("Reject", "Mustard karein")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={zoomed}
        onClose={() => setZoomed(false)}
        size="lg"
        title={tr("Payment screenshot", "Adaigi ka screenshot")}
        description={`${payment.patientName} · ${payment.currency} ${payment.amount}`}
      >
        {payment.proofUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={payment.proofUrl}
            alt={tr("Payment screenshot", "Adaigi ka screenshot")}
            className="mx-auto max-h-[70vh] w-auto rounded-xl border border-line"
          />
        )}
      </Dialog>
    </li>
  );
}

export function PaymentQueue() {
  const tr = useTr();
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const queue = useAsync(() => paymentReview.pending({ limit: 50 }), [refresh], {
    refreshMs: QUEUE_REFRESH_MS,
  });

  const rows = queue.data?.data ?? [];

  return (
    <Card
      icon="fact_check"
      title={tr("Payments to confirm", "Tasdeeq talab adaigiyan")}
      description={tr(
        "Check each transfer in your banking app before confirming it.",
        "Tasdeeq se pehle har transfer apni banking app mein dekh lein.",
      )}
    >
      {queue.loading && <SkeletonRows rows={2} />}
      {queue.error && <ErrorState message={queue.error.message} onRetry={queue.reload} />}
      {queue.data && rows.length === 0 && (
        <EmptyState
          icon="check_circle"
          title={tr("Nothing waiting", "Kuch zer-e-intezar nahi")}
          description={tr(
            "Payments patients send appear here for you to check.",
            "Mareez jo adaigiyan bhejenge woh yahan tasdeeq ke liye aayengi.",
          )}
        />
      )}
      {rows.length > 0 && (
        <ul className="space-y-4">
          {rows.map((payment) => (
            <Claim key={payment.id} payment={payment} onDecided={reload} />
          ))}
        </ul>
      )}
    </Card>
  );
}
