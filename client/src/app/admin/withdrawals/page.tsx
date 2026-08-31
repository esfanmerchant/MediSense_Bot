"use client";

/**
 * Doctors waiting to be paid.
 *
 * The mirror of the payment queue, and built to be used the same way: with a
 * banking app open beside it. Everything a transfer needs — name, number, bank,
 * amount — is on the card in a form somebody can copy, because a payout typed
 * out of a half-remembered screen is how money reaches the wrong account.
 *
 * Marking one paid asks for the receipt. It is not strictly required, since an
 * administrator may have paid by a route that produces no screenshot, but the
 * absence is recorded rather than hidden — this system asks a patient for proof
 * on the way in, and the way out should not be looser.
 */

import { useCallback, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/components/overlays";
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
import { ApiError, withdrawalReview, type PendingWithdrawal } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

/** A value the administrator will copy into their banking app. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-bold uppercase tracking-wider text-faint">{label}</dt>
      <dd className="select-all font-mono text-sm font-semibold text-strong">{value}</dd>
    </div>
  );
}

function Request({
  withdrawal,
  onDecided,
}: {
  withdrawal: PendingWithdrawal;
  onDecided: () => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reference, setReference] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");

  async function act(what: "paid" | "reject") {
    setBusy(true);
    try {
      if (what === "paid") {
        await withdrawalReview.markPaid(withdrawal.id, {
          reference: reference.trim(),
          file: file ?? undefined,
        });
        toast.show({
          tone: "success",
          title: tr("Marked as paid", "Ada shuda darj ho gaya"),
          body: tr("The doctor has been emailed.", "Doctor ko email chali gayi."),
        });
      } else {
        await withdrawalReview.reject(withdrawal.id, reason.trim());
        toast.show({
          tone: "success",
          title: tr("Request rejected", "Darkhwast mustard ho gayi"),
          body: tr(
            "The amount is back in the doctor's balance.",
            "Raqam doctor ke balance mein wapas chali gayi.",
          ),
        });
      }
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
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-display text-lg font-bold tabular-nums text-strong">
          {withdrawal.currency} {withdrawal.amount}
        </span>
        <Badge tone="neutral">{withdrawal.method}</Badge>
        <span className="text-sm text-muted">{withdrawal.doctorName}</span>
        <span className="ml-auto text-xs text-faint">
          {withdrawal.createdAt ? new Date(withdrawal.createdAt).toLocaleString() : ""}
        </span>
      </div>

      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        <Detail label={tr("Account name", "Account ka naam")} value={withdrawal.accountName} />
        <Detail
          label={
            withdrawal.method === "BANK"
              ? tr("Account number", "Account number")
              : tr("Mobile number", "Mobile number")
          }
          value={withdrawal.accountNumber}
        />
        {withdrawal.bankName && (
          <Detail label={tr("Bank", "Bank")} value={withdrawal.bankName} />
        )}
      </dl>

      {paying ? (
        <div className="mt-4 space-y-3 rounded-xl border border-line bg-sunken p-3">
          <Field
            label={tr("Transfer reference", "Transfer ka reference")}
            htmlFor={`ref-${withdrawal.id}`}
            hint={tr("Optional, but useful later.", "Ikhtiyari, magar baad mein kaam aata hai.")}
          >
            <Input
              id={`ref-${withdrawal.id}`}
              maxLength={120}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </Field>

          <div>
            <input
              id={`proof-${withdrawal.id}`}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <label
              htmlFor={`proof-${withdrawal.id}`}
              className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border border-line bg-card px-4 text-sm font-semibold text-strong hover:border-primary"
            >
              <Icon name="image" className="text-[18px]" />
              {file ? file.name : tr("Attach the receipt", "Receipt lagayein")}
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={() => act("paid")}>
              {tr("Confirm sent", "Bhej diya — tasdeeq")}
            </Button>
            <Button variant="ghost" onClick={() => setPaying(false)}>
              {tr("Cancel", "Cancel")}
            </Button>
          </div>
        </div>
      ) : rejecting ? (
        <div className="mt-4 space-y-3 rounded-xl border border-line bg-sunken p-3">
          <Field
            label={tr("Why is this being rejected?", "Yeh kyun mustard ho raha hai?")}
            htmlFor={`reason-${withdrawal.id}`}
            hint={tr(
              "The doctor reads this, and the amount returns to their balance.",
              "Doctor yeh parhega, aur raqam us ke balance mein wapas chali jaye gi.",
            )}
          >
            <Input
              id={`reason-${withdrawal.id}`}
              maxLength={500}
              autoFocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              loading={busy}
              disabled={reason.trim().length < 3}
              onClick={() => act("reject")}
            >
              {tr("Reject request", "Darkhwast mustard karein")}
            </Button>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              {tr("Cancel", "Cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => setPaying(true)}>
            <Icon name="send" className="text-[20px]" />
            {tr("I have sent this", "Maine bhej diya hai")}
          </Button>
          <Button variant="ghost" onClick={() => setRejecting(true)}>
            {tr("Reject", "Mustard karein")}
          </Button>
        </div>
      )}
    </li>
  );
}

export default function AdminWithdrawals() {
  const tr = useTr();
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const queue = useAsync(() => withdrawalReview.pending({ limit: 50 }), [refresh]);

  const rows = queue.data?.data ?? [];

  return (
    <AppShell role="ADMIN">
      <div id="main" className="page-enter space-y-6">
        <PageHeader
          eyebrow={tr("Admin portal", "Intezami portal")}
          title={tr("Withdrawals", "Withdrawals")}
          subtitle={tr(
            "Doctors waiting to be paid what they have earned.",
            "Woh doctors jinhein un ki kamai ada honi hai.",
          )}
        />

        <Card icon="account_balance" title={tr("Requests", "Darkhwastein")}>
          {queue.loading && <SkeletonRows rows={2} />}
          {queue.error && <ErrorState message={queue.error.message} onRetry={queue.reload} />}
          {queue.data && rows.length === 0 && (
            <EmptyState
              icon="check_circle"
              title={tr("Nothing waiting", "Kuch zer-e-intezar nahi")}
              description={tr(
                "Withdrawal requests from doctors appear here.",
                "Doctors ki withdrawal darkhwastein yahan aayengi.",
              )}
            />
          )}
          {rows.length > 0 && (
            <ul className="space-y-4">
              {rows.map((withdrawal) => (
                <Request key={withdrawal.id} withdrawal={withdrawal} onDecided={reload} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
