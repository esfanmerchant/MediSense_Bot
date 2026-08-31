"use client";

/**
 * How a patient pays: transfer, then show what you did.
 *
 * There is no gateway behind this and none is pretended. The hospital publishes
 * a NayaPay or EasyPaisa number, the patient sends the money in their own
 * banking app, and then tells us the reference and uploads the screenshot. An
 * administrator opens the receiving account and confirms it.
 *
 * **The screen has to be honest that uploading is not paying.** Somebody who
 * presses a button labelled "Pay" and sees a success message will reasonably
 * believe the bill is settled; it is not, until a person has checked. So the
 * button says what it does, the confirmation says what happens next, and the
 * bill stays visibly unpaid in the meantime. Overstating this by one word would
 * have patients arriving at appointments believing they were paid up.
 *
 * The QR is `public/brand/nayapay-qr.png`, and it simply does not render if the
 * file is absent — the number below it is what actually carries the payment,
 * and a broken image icon on a payment screen is worse than no picture.
 */

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useToast } from "@/components/overlays";
import { Badge, Button, Field, Input, cx } from "@/components/ui";
import { Dialog } from "@/components/overlays";
import {
  ApiError,
  invoices as invoicesApi,
  type Invoice,
  type PaymentClaim,
  type PaymentInstructions,
  type PaymentWallet,
} from "@/lib/api";
import { useTr } from "@/lib/lang";

const QR_SRC = "/brand/nayapay-qr.png";
const MAX_PROOF_MB = 5;

/** One account, with the number a person actually has to copy. */
function Account({
  wallet,
  number,
  selected,
  onSelect,
  label,
}: {
  wallet: PaymentWallet;
  number: string;
  selected: boolean;
  onSelect: (wallet: PaymentWallet) => void;
  label: string;
}) {
  const tr = useTr();
  const [copied, setCopied] = useState(false);

  return (
    <div
      className={cx(
        "rounded-xl border p-4 transition-colors",
        selected ? "border-primary bg-gradient-soft" : "border-line bg-card",
      )}
    >
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="radio"
          name="wallet"
          checked={selected}
          onChange={() => onSelect(wallet)}
          className="h-4 w-4 accent-[var(--color-primary)]"
        />
        <span className="font-display text-sm font-bold text-strong">{label}</span>
      </label>

      <div className="mt-2 flex items-center gap-2 pl-7">
        <span className="font-mono text-base font-bold tabular-nums text-strong">{number}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(number);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
          className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-primary transition-colors hover:bg-gradient-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Icon name={copied ? "check" : "content_copy"} className="text-[15px]" />
          {copied ? tr("Copied", "Copy ho gaya") : tr("Copy", "Copy")}
        </button>
      </div>
    </div>
  );
}

export function PayInvoice({
  invoice,
  open,
  onClose,
  onSubmitted,
}: {
  invoice: Invoice;
  open: boolean;
  onClose: () => void;
  /** The claim that was just filed, so the caller can show it in the list. */
  onSubmitted: (claim: PaymentClaim) => void;
}) {
  const tr = useTr();
  const toast = useToast();

  const [instructions, setInstructions] = useState<PaymentInstructions | null>(null);
  const [wallet, setWallet] = useState<PaymentWallet | null>(null);
  const [reference, setReference] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [qrBroken, setQrBroken] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void invoicesApi
      .paymentInstructions(invoice.id)
      .then((loaded) => {
        if (cancelled) return;
        setInstructions(loaded);
        // Preselect whichever wallet exists, so the common case is one tap.
        setWallet(loaded.nayapayNumber ? "NAYAPAY" : loaded.easypaisaNumber ? "EASYPAISA" : null);
      })
      .catch(() => {
        /* The dialog renders its own "not available" state below. */
      });
    return () => {
      cancelled = true;
    };
  }, [open, invoice.id]);

  const tooBig = file !== null && file.size > MAX_PROOF_MB * 1024 * 1024;
  const ready = wallet !== null && reference.trim().length >= 3 && file !== null && !tooBig;

  async function submit() {
    if (!ready || wallet === null || file === null) return;
    setBusy(true);
    try {
      const claim = await invoicesApi.submitPaymentProof(invoice.id, {
        method: wallet,
        reference: reference.trim(),
        file,
      });
      onSubmitted(claim);
      toast.show({
        tone: "success",
        title: tr("Sent for confirmation", "Tasdeeq ke liye bhej diya"),
        // Not "paid". The distinction is the whole point of this screen.
        body: tr(
          "The hospital will check the transfer and mark the bill paid.",
          "Hospital transfer check kare ga aur phir bill ada shuda hoga.",
        ),
      });
      setReference("");
      setFile(null);
      onClose();
    } catch (cause) {
      toast.show({
        tone: "critical",
        title: tr("Could not send", "Bhej nahi saka"),
        body: cause instanceof ApiError ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  }

  const money = `${instructions?.currency ?? invoice.currency} ${instructions?.amountDue ?? invoice.amountDue}`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      icon="payments"
      title={tr("Pay this bill", "Yeh bill ada karein")}
      description={tr(
        "Transfer the amount, then upload the screenshot.",
        "Raqam transfer karein, phir screenshot upload karein.",
      )}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("Close", "Band karein")}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!ready}>
            <Icon name="upload" className="text-[20px]" />
            {/* Says what it does. "Pay" would be a lie: this files a claim. */}
            {tr("Send for confirmation", "Tasdeeq ke liye bhejein")}
          </Button>
        </>
      }
    >
      {instructions && !instructions.configured ? (
        <p className="rounded-xl border border-line bg-sunken p-4 text-sm text-muted">
          {tr(
            "Online payment is not set up yet. You can pay at the hospital billing desk.",
            "Online adaigi abhi mojood nahi. Aap hospital ke billing desk par ada kar sakte hain.",
          )}
        </p>
      ) : (
        <div className="space-y-6">
          {/* What to send. */}
          <div className="rounded-2xl border border-line bg-sunken p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-faint">
                {tr("Amount to transfer", "Transfer karne ki raqam")}
              </span>
              <span className="font-display text-2xl font-bold tabular-nums text-strong">
                {money}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {tr(
                `Invoice ${invoice.invoiceNumber}`,
                `Invoice ${invoice.invoiceNumber}`,
              )}
              {Number(invoice.lateFeeCharged) > 0 &&
                tr(" · includes the late charge", " · der ka charge shamil hai")}
            </p>
          </div>

          {/* Where to send it. */}
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="space-y-3">
              {instructions?.payeeName && (
                <p className="text-sm text-muted">
                  {tr("Account name", "Account ka naam")}:{" "}
                  <span className="font-semibold text-strong">{instructions.payeeName}</span>
                </p>
              )}

              {instructions?.nayapayNumber && (
                <Account
                  wallet="NAYAPAY"
                  label="NayaPay"
                  number={instructions.nayapayNumber}
                  selected={wallet === "NAYAPAY"}
                  onSelect={setWallet}
                />
              )}
              {instructions?.easypaisaNumber && (
                <Account
                  wallet="EASYPAISA"
                  label="EasyPaisa"
                  number={instructions.easypaisaNumber}
                  selected={wallet === "EASYPAISA"}
                  onSelect={setWallet}
                />
              )}

              {instructions?.note && (
                <p className="text-sm text-muted">{instructions.note}</p>
              )}
            </div>

            {/* The QR, for anyone who would rather scan than type a number.
                Absent file, absent picture — never a broken image icon on a
                screen where somebody is about to send money. */}
            {!qrBroken && (
              <figure className="justify-self-center text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={QR_SRC}
                  alt={tr("NayaPay QR code", "NayaPay QR code")}
                  onError={() => setQrBroken(true)}
                  className="h-40 w-40 rounded-xl border border-line bg-white object-contain p-2"
                />
                <figcaption className="mt-1.5 text-xs text-muted">
                  {tr("Or scan to pay", "Ya scan kar ke bhejein")}
                </figcaption>
              </figure>
            )}
          </div>

          {/* What to send back. */}
          <div className="space-y-4 border-t border-line pt-5">
            <p className="flex items-start gap-2 text-sm text-muted">
              <Icon name="info" className="mt-0.5 shrink-0 text-[18px] text-primary" />
              <span>
                {tr(
                  "After transferring, enter the transaction ID and upload the screenshot. The bill is marked paid once the hospital confirms it.",
                  "Transfer ke baad transaction ID likhein aur screenshot upload karein. Hospital tasdeeq kare ga to bill ada shuda hoga.",
                )}
              </span>
            </p>

            <Field
              label={tr("Transaction ID", "Transaction ID")}
              htmlFor="payment-reference"
              hint={tr(
                "From your banking app's receipt.",
                "Apni banking app ki receipt se.",
              )}
            >
              <Input
                id="payment-reference"
                maxLength={120}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            </Field>

            <div>
              <input
                ref={picker}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <Button variant="secondary" onClick={() => picker.current?.click()}>
                <Icon name="image" className="text-[20px]" />
                {file
                  ? tr("Choose a different screenshot", "Doosra screenshot chunein")
                  : tr("Upload screenshot", "Screenshot upload karein")}
              </Button>

              {file && (
                <p className="mt-2 flex items-center gap-2 text-sm">
                  <Badge tone={tooBig ? "critical" : "good"}>
                    <Icon name={tooBig ? "warning" : "check"} className="text-[14px]" />
                    {tooBig
                      ? tr(`Over ${MAX_PROOF_MB} MB`, `${MAX_PROOF_MB} MB se bara`)
                      : tr("Attached", "Lag gaya")}
                  </Badge>
                  <span className="truncate text-muted">{file.name}</span>
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
