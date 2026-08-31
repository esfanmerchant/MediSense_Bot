"use client";

/**
 * Asking for a payout, and saying where to send it.
 *
 * The account details are collected each time rather than remembered on the
 * doctor's profile. That is deliberate: a doctor may be paid to a different
 * account from one month to the next, and the record has to say where *this*
 * money went — a remembered account silently rewrites the answer for every past
 * payment the moment it is changed.
 *
 * The amount is checked against the balance and the floor here as well as on
 * the server, so a refusal names the field rather than arriving as a red banner
 * after a round trip.
 */

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { Dialog, useToast } from "@/components/overlays";
import { Button, Field, Input, cx } from "@/components/ui";
import { ApiError, earnings, type WithdrawalMethod } from "@/lib/api";
import { useTr } from "@/lib/lang";

const METHODS: Array<{ value: WithdrawalMethod; label: string }> = [
  { value: "BANK", label: "Bank" },
  { value: "EASYPAISA", label: "EasyPaisa" },
  { value: "JAZZCASH", label: "JazzCash" },
  { value: "NAYAPAY", label: "NayaPay" },
];

export function WithdrawDialog({
  open,
  onClose,
  balance,
  currency,
  minimum,
  onRequested,
}: {
  open: boolean;
  onClose: () => void;
  balance: string;
  currency: string;
  minimum: string;
  onRequested: () => void;
}) {
  const tr = useTr();
  const toast = useToast();

  const [amount, setAmount] = useState(balance);
  const [method, setMethod] = useState<WithdrawalMethod>("EASYPAISA");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [busy, setBusy] = useState(false);

  const value = Number(amount.replace(/,/g, "").trim());
  const available = Number(balance);
  const floor = Number(minimum);

  const amountProblem =
    !Number.isFinite(value) || value <= 0
      ? tr("Enter an amount.", "Raqam likhein.")
      : value < floor
        ? tr(`The smallest withdrawal is ${currency} ${minimum}.`, `Kam az kam ${currency} ${minimum}.`)
        : value > available
          ? tr(`You have ${currency} ${balance} available.`, `Aap ke pas ${currency} ${balance} hain.`)
          : undefined;

  // A bank needs naming; a wallet is identified by its number alone.
  const needsBank = method === "BANK";
  const ready =
    !amountProblem &&
    accountName.trim().length >= 2 &&
    accountNumber.trim().length >= 5 &&
    (!needsBank || bankName.trim().length >= 2);

  async function submit() {
    if (!ready) return;
    setBusy(true);
    try {
      await earnings.request({
        amount: String(value),
        method,
        accountName: accountName.trim(),
        accountNumber: accountNumber.trim(),
        ...(needsBank ? { bankName: bankName.trim() } : {}),
      });
      onRequested();
      onClose();
    } catch (cause) {
      toast.show({
        tone: "critical",
        title: tr("Could not request", "Darkhwast nahi ho saki"),
        body: cause instanceof ApiError ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon="account_balance"
      title={tr("Withdraw your balance", "Apna balance nikaalein")}
      description={tr(
        "The hospital will transfer it and email you.",
        "Hospital raqam bheje ga aur aap ko email kare ga.",
      )}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("Cancel", "Cancel")}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!ready}>
            {tr("Request withdrawal", "Darkhwast bhejein")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field
          label={tr("Amount", "Raqam")}
          htmlFor="withdraw-amount"
          hint={tr(
            `${currency} ${balance} available · minimum ${currency} ${minimum}`,
            `${currency} ${balance} mojood · kam az kam ${currency} ${minimum}`,
          )}
          error={amount ? amountProblem : undefined}
        >
          <Input
            id="withdraw-amount"
            inputMode="decimal"
            className="tabular-nums"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>

        <div>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-faint">
            {tr("Send to", "Kahan bhejein")}
          </p>
          <div className="flex flex-wrap gap-2">
            {METHODS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={method === option.value}
                onClick={() => setMethod(option.value)}
                className={cx(
                  "min-h-10 rounded-xl px-4 text-sm font-semibold transition-colors",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  method === option.value
                    ? "bg-primary text-primary-on"
                    : "border border-line bg-card text-muted hover:text-strong",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={tr("Account holder name", "Account holder ka naam")}
            htmlFor="withdraw-name"
            hint={tr(
              "Checked against the account before sending.",
              "Bhejne se pehle account se milaya jata hai.",
            )}
          >
            <Input
              id="withdraw-name"
              maxLength={160}
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
            />
          </Field>

          <Field
            label={
              needsBank
                ? tr("Account number", "Account number")
                : tr("Mobile number", "Mobile number")
            }
            htmlFor="withdraw-number"
          >
            <Input
              id="withdraw-number"
              inputMode="tel"
              maxLength={64}
              className="tabular-nums"
              value={accountNumber}
              onChange={(event) => setAccountNumber(event.target.value)}
            />
          </Field>

          {needsBank && (
            <div className="sm:col-span-2">
              <Field label={tr("Bank name", "Bank ka naam")} htmlFor="withdraw-bank">
                <Input
                  id="withdraw-bank"
                  maxLength={120}
                  value={bankName}
                  onChange={(event) => setBankName(event.target.value)}
                />
              </Field>
            </div>
          )}
        </div>

        <p className="flex items-start gap-2 rounded-xl border border-line bg-sunken p-3 text-sm text-muted">
          <Icon name="info" className="mt-0.5 shrink-0 text-[18px] text-primary" />
          <span>
            {tr(
              "The amount is held out of your balance while the request is open. If it is not paid, it comes back.",
              "Darkhwast khuli rehne tak yeh raqam balance se alag rehti hai. Ada na hui to wapas aa jaye gi.",
            )}
          </span>
        </p>
      </div>
    </Dialog>
  );
}
