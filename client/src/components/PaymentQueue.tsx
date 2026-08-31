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
} from "@/components/ui";
import { ApiError, paymentReview, type PendingPayment } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync, QUEUE_REFRESH_MS } from "@/lib/useAsync";

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

          {rejecting ? (
            <div className="space-y-3 rounded-xl border border-line bg-sunken p-3">
              <Field
                label={tr("Why is this being rejected?", "Yeh kyun mustard ho raha hai?")}
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
                  {tr("Reject payment", "Adaigi mustard karein")}
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
