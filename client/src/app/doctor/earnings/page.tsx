"use client";

/**
 * What a doctor has earned, and getting it out.
 *
 * The balance and the statement are on one screen because they are one thing: a
 * number with no movements behind it is a figure to be argued with, and the
 * first question anybody has about money owed to them is *where did that come
 * from*.
 *
 * Two facts the page states rather than implies. **Held money is already out of
 * the balance** — a pending request has been debited, so the figure shown is
 * what can be asked for now, not what has been earned. And a **rejected**
 * request has come back: the reversing entry is in the statement, so a doctor
 * watching their balance move twice can see why.
 */

import { useCallback, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { PageHeader } from "@/components/PageHeader";
import {
  PageSectionNav,
  Section,
  type Section as SectionSpec,
} from "@/components/layout/PageSectionNav";
import { WithdrawDialog } from "@/components/WithdrawDialog";
import { useToast } from "@/components/overlays";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  SkeletonRows,
  cx,
} from "@/components/ui";
import { earnings, type LedgerEntry, type Withdrawal } from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

function money(amount: string, currency: string): string {
  return `${currency} ${amount}`;
}

/** Signed amounts read better with the sign made explicit than inferred. */
function Movement({ entry }: { entry: LedgerEntry }) {
  const tr = useTr();
  const credit = !entry.amount.startsWith("-");

  const label =
    entry.kind === "EARNING"
      ? tr("Consultation", "Consultation")
      : entry.kind === "WITHDRAWAL"
        ? tr("Withdrawal", "Withdrawal")
        : tr("Returned", "Wapas aaya");

  return (
    <li className="flex items-center gap-3 border-b border-line py-3 last:border-0">
      <span
        aria-hidden
        className={cx(
          "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
          credit ? "bg-stable-soft text-stable" : "bg-sunken text-muted",
        )}
      >
        <Icon
          name={entry.kind === "EARNING" ? "payments" : credit ? "undo" : "arrow_outward"}
          className="text-[18px]"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-strong">{label}</span>
        <span className="block truncate text-xs text-muted">{entry.description}</span>
      </span>
      <span
        className={cx(
          "shrink-0 font-mono text-sm font-bold tabular-nums",
          credit ? "text-stable" : "text-strong",
        )}
      >
        {credit ? "+" : ""}
        {entry.amount}
      </span>
    </li>
  );
}

function RequestRow({ withdrawal }: { withdrawal: Withdrawal }) {
  const tr = useTr();

  const tone =
    withdrawal.status === "PAID"
      ? "good"
      : withdrawal.status === "REJECTED"
        ? "critical"
        : "warning";
  const label =
    withdrawal.status === "PAID"
      ? tr("Paid", "Ada ho gaya")
      : withdrawal.status === "REJECTED"
        ? tr("Not paid", "Ada nahi hua")
        : tr("Waiting", "Zer-e-amal");

  return (
    <li className="rounded-xl border border-line bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-base font-bold tabular-nums text-strong">
          {money(withdrawal.amount, withdrawal.currency)}
        </span>
        <Badge tone={tone}>{label}</Badge>
        <span className="text-xs text-muted">
          {withdrawal.method} · {withdrawal.accountNumber}
        </span>
      </div>

      {withdrawal.status === "REJECTED" && withdrawal.rejectionReason && (
        <p className="mt-2 text-sm text-muted">
          {withdrawal.rejectionReason}{" "}
          <span className="text-strong">
            {tr(
              "The amount is back in your balance.",
              "Raqam aap ke balance mein wapas aa gayi hai.",
            )}
          </span>
        </p>
      )}

      {withdrawal.status === "PAID" && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted">
          {withdrawal.reference && (
            <span className="font-mono">
              {tr("Ref", "Ref")} {withdrawal.reference}
            </span>
          )}
          {withdrawal.proofUrl && (
            <a
              href={withdrawal.proofUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
            >
              <Icon name="receipt_long" className="text-[16px]" />
              {tr("View receipt", "Receipt dekhein")}
            </a>
          )}
        </div>
      )}
    </li>
  );
}

const SECTIONS: SectionSpec[] = [
  { id: "balance", label: "Balance", icon: "account_balance_wallet" },
  { id: "withdrawals", label: "Withdrawals", icon: "payments" },
  { id: "statement", label: "Statement", icon: "receipt_long" },
];

export default function DoctorEarnings() {
  const tr = useTr();
  const toast = useToast();
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const data = useAsync(() => earnings.me({ limit: 50 }), [refresh]);

  const summary = data.data;

  return (
    <AppShell role="DOCTOR">
      <div id="main" className="page-enter space-y-6">
        <PageHeader
          eyebrow={tr("Doctor portal", "Doctor ka portal")}
          title={tr("Earnings", "Kamai")}
          subtitle={tr(
            "What patients have paid you, and getting it out.",
            "Mareezon ne aap ko kya ada kiya, aur usse nikalna.",
          )}
        />

        {data.loading && <SkeletonRows rows={3} />}
        {data.error && <ErrorState message={data.error.message} onRetry={data.reload} />}

        {summary && (
          <>
            <PageSectionNav mode="jump" label="Sections" sections={SECTIONS} />

            <Section id="balance">
            <Card>
              <div className="flex flex-wrap items-end justify-between gap-5">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-faint">
                    {tr("Available to withdraw", "Nikalne ke qabil")}
                  </p>
                  <p className="font-display text-4xl font-bold tabular-nums text-strong">
                    {money(summary.balance, summary.currency)}
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    {tr(
                      `${money(summary.lifetimeEarned, summary.currency)} earned in total`,
                      `Kul kamai ${money(summary.lifetimeEarned, summary.currency)}`,
                    )}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Button onClick={() => setOpen(true)} disabled={!summary.canWithdraw}>
                    <Icon name="account_balance" className="text-[20px]" />
                    {tr("Withdraw", "Nikaalein")}
                  </Button>
                  {!summary.canWithdraw && (
                    // Says the threshold rather than leaving a disabled button
                    // with no explanation beside it.
                    <p className="text-xs text-muted">
                      {tr(
                        `Minimum ${money(summary.minimumWithdrawal, summary.currency)}`,
                        `Kam az kam ${money(summary.minimumWithdrawal, summary.currency)}`,
                      )}
                    </p>
                  )}
                </div>
              </div>
            </Card>

            </Section>

            <Section id="withdrawals">
            {summary.withdrawals.length > 0 && (
              <Card icon="account_balance" title={tr("Your withdrawals", "Aap ki withdrawals")}>
                <ul className="space-y-3">
                  {summary.withdrawals.map((row) => (
                    <RequestRow key={row.id} withdrawal={row} />
                  ))}
                </ul>
              </Card>
            )}

            </Section>

            <Section id="statement">
            <Card
              icon="receipt_long"
              title={tr("Statement", "Statement")}
              description={tr(
                "Every movement in your balance.",
                "Aap ke balance ki har tabdeeli.",
              )}
            >
              {summary.entries.length === 0 ? (
                <EmptyState
                  icon="payments"
                  title={tr("Nothing yet", "Abhi kuchh nahi")}
                  description={tr(
                    "When a patient's payment is confirmed, your share appears here.",
                    "Jab mareez ki adaigi tasdeeq hogi, aap ka hissa yahan aayega.",
                  )}
                />
              ) : (
                <ul>
                  {summary.entries.map((entry) => (
                    <Movement key={entry.id} entry={entry} />
                  ))}
                </ul>
              )}
            </Card>

            <WithdrawDialog
              open={open}
              onClose={() => setOpen(false)}
              balance={summary.balance}
              currency={summary.currency}
              minimum={summary.minimumWithdrawal}
              onRequested={() => {
                toast.show({
                  tone: "success",
                  title: tr("Withdrawal requested", "Withdrawal ki darkhwast bhej di"),
                  body: tr(
                    "The hospital will send the money and email you.",
                    "Hospital raqam bheje ga aur aap ko email kare ga.",
                  ),
                });
                reload();
              }}
            />
            </Section>
          </>
        )}
      </div>
    </AppShell>
  );
}
