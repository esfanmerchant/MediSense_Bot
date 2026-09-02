"use client";

/**
 * Invoices (spec §15).
 *
 * Two rules shape this file.
 *
 * **Money is never a JavaScript number.** Amounts arrive as strings because
 * `0.1 + 0.2` is not `0.3` in binary floating point. Nothing here parses them —
 * they are formatted for display and passed straight through. A total the
 * client computed would eventually disagree with the invoice.
 *
 * **An issued invoice is not editable.** There is no edit control anywhere in
 * this file, because there is no edit endpoint: a bill already shown to a
 * patient is corrected by voiding it or issuing a credit note against it
 * (conflict C4). The UI shows the correction beside the original rather than
 * replacing it.
 *
 * There is no PDF download, and none is implied. `Print` opens the browser's
 * print dialogue, which can save a PDF — honest about what it does, rather than
 * a button labelled "Download PDF" that produces something else.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/Icon";
import { PayInvoice } from "@/components/PayInvoice";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  SkeletonTable,
  cx,
} from "@/components/ui";
import {
  ApiError,
  invoices as invoicesApi,
  type Invoice,
  type InvoiceStatus,
  type PaymentClaim,
} from "@/lib/api";
import { useTr } from "@/lib/lang";
import { useAsync } from "@/lib/useAsync";

function messageOf(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

const STATUS_TONE: Record<InvoiceStatus, "good" | "warning" | "critical" | "neutral" | "info"> = {
  PAID: "good",
  ISSUED: "info",
  OVERDUE: "critical",
  AWAITING_APPROVAL: "warning",
  VOID: "neutral",
  REFUNDED: "warning",
  DRAFT: "neutral",
};

const STATUS_LABEL: Record<InvoiceStatus, [string, string]> = {
  PAID: ["Paid", "Ada shuda"],
  ISSUED: ["Due", "Wajib-ul-ada"],
  OVERDUE: ["Overdue", "Muddat guzar gayi"],
  AWAITING_APPROVAL: ["Waiting for approval", "Tasdeeq ka intezar"],
  VOID: ["Cancelled", "Mansookh"],
  REFUNDED: ["Credited", "Wapas kiya gaya"],
  DRAFT: ["Draft", "Musawwada"],
};

const STATUS_ICON: Record<InvoiceStatus, string> = {
  PAID: "check_circle",
  ISSUED: "schedule",
  OVERDUE: "error",
  AWAITING_APPROVAL: "hourglass_top",
  VOID: "block",
  REFUNDED: "undo",
  DRAFT: "edit_note",
};

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
}

/** Formats an amount without ever turning it into a number. */
function money(amount: string, currency: string): string {
  const negative = amount.startsWith("-");
  const digits = negative ? amount.slice(1) : amount;
  return `${negative ? "−" : ""}${currency} ${digits}`;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * A centred dialogue over a blurred backdrop. Rendered through a portal so a
 * transformed ancestor — a lifted row, a tilted card — cannot capture its
 * `position: fixed` and pin it inside the table.
 */
function Modal({
  open,
  title,
  titleId,
  icon,
  onClose,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  titleId: string;
  icon: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const tr = useTr();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center p-4 sm:items-center">
          <motion.div
            key="backdrop"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 bg-navy-deep/45 backdrop-blur-sm"
          />
          <motion.div
            key="panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.9 }}
            className="card-thread relative w-full max-w-lg rounded-2xl border border-line bg-card p-6 shadow-float"
          >
            <div className="flex items-start gap-4">
              <span
                aria-hidden
                className="bg-gradient-soft grid h-11 w-11 shrink-0 place-items-center rounded-xl text-primary"
              >
                <Icon name={icon} className="text-[22px]" />
              </span>
              <h2 id={titleId} className="min-w-0 flex-1 pt-2 font-display text-lg font-bold text-strong">
                {title}
              </h2>
              <IconButton
                label={tr("Close", "Band karein")}
                icon="close"
                size="sm"
                className="-mr-2 -mt-1"
                onClick={onClose}
              />
            </div>
            <div className="mt-5">{children}</div>
            <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function DateTile({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-card px-3.5 py-2.5">
      <Icon name={icon} className="text-[20px] text-faint" />
      <div className="min-w-0 leading-tight">
        <dt className="text-[11px] font-bold uppercase tracking-wider text-faint">{label}</dt>
        <dd className="mt-0.5 text-sm font-medium tabular-nums text-strong">{value}</dd>
      </div>
    </div>
  );
}

/**
 * The letterhead, on paper only.
 *
 * On screen the table row above an open invoice already says whose it is and
 * when it was issued, so the panel does not repeat it. On paper there is no row
 * — printing gave you a table of line items and no indication of who owed what
 * to whom.
 */
function PrintHeader({ invoice }: { invoice: Invoice }) {
  const tr = useTr();
  const issued = invoice.issuedAt ?? invoice.createdAt;
  return (
    <div className="print-only mb-5">
      <p className="font-display text-xl font-bold text-strong">MediSense</p>
      <p className="mt-3 text-lg font-bold text-strong">
        {tr("Invoice", "Invoice")} {invoice.invoiceNumber}
      </p>
      <p className="mt-1 text-sm text-muted">
        {tr("Issued", "Jari")} {new Date(issued).toLocaleDateString()}
        {invoice.dueAt
          ? ` · ${tr("Due", "Aakhri tareekh")} ${new Date(invoice.dueAt).toLocaleDateString()}`
          : ""}
      </p>
      {invoice.paidAt && (
        <p className="mt-1 text-sm font-semibold text-good">
          {tr("Paid", "Ada shuda")} {new Date(invoice.paidAt).toLocaleDateString()}
        </p>
      )}
    </div>
  );
}

function InvoiceDetail({ invoice }: { invoice: Invoice }) {
  const tr = useTr();
  return (
    <div className="space-y-4">
      {invoice.amendsInvoiceId && (
        <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
          <Icon name="undo" className="mt-px shrink-0 text-[18px]" />
          {tr(
            "This is a credit note correcting an earlier invoice. The original is kept as issued.",
            "Yeh credit note hai jo pichhle invoice ki islah karta hai. Asal invoice jaisa jari hua tha waisa hi mehfooz hai.",
          )}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-line bg-card">
        <table className="table-modern min-w-[24rem]">
          <caption className="sr-only">Invoice {invoice.invoiceNumber} line items</caption>
          <thead>
            <tr>
              <th scope="col">{tr("Description", "Tafseel")}</th>
              <th scope="col">{tr("Qty", "Tadaad")}</th>
              <th scope="col" className="!text-right">{tr("Amount", "Raqam")}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((line, index) => (
              <tr key={index}>
                <td className="text-strong">{line.description}</td>
                <td className="tabular-nums text-muted">{line.quantity}</td>
                <td className="text-right tabular-nums text-strong">
                  {money(line.amount, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} className="border-t border-line px-4 pt-3 pb-1 text-right text-sm text-muted">
                {tr("Subtotal", "Kul raqam")}
              </td>
              <td className="border-t border-line px-4 pt-3 pb-1 text-right text-sm tabular-nums text-strong">
                {money(invoice.amount, invoice.currency)}
              </td>
            </tr>
            {Number(invoice.platformFee) > 0 && (
              <tr>
                <td colSpan={2} className="px-4 py-1 text-right text-sm text-muted">
                  {tr("Platform fee", "Platform fee")}
                </td>
                <td className="px-4 py-1 text-right text-sm tabular-nums text-strong">
                  {money(invoice.platformFee, invoice.currency)}
                </td>
              </tr>
            )}
            <tr>
              <td colSpan={2} className="px-4 py-1 text-right text-sm text-muted">
                {/* The rate, beside the amount: an old invoice should be able to
                    explain its own tax without anyone looking up what the rate
                    was that month. */}
                {tr("Tax", "Tax")}
                {Number(invoice.taxPercent) > 0 && (
                  <span className="ml-1 text-faint">({invoice.taxPercent}%)</span>
                )}
              </td>
              <td className="px-4 py-1 text-right text-sm tabular-nums text-strong">
                {money(invoice.taxAmount, invoice.currency)}
              </td>
            </tr>
            <tr>
              <td colSpan={2} className="px-4 pt-2 pb-1 text-right font-display text-base font-bold text-strong">
                {tr("Total", "Mila kar total")}
              </td>
              <td className="px-4 pt-2 pb-1 text-right font-display text-base font-bold tabular-nums text-strong">
                {money(invoice.totalAmount, invoice.currency)}
              </td>
            </tr>

            {/* The late charge is shown *under* the total rather than folded
                into it. A patient was sent a bill for one number; a total that
                silently grew since they last looked, with no line explaining
                it, is how a bill loses somebody's trust. */}
            {Number(invoice.lateFeeCharged) > 0 && (
              <>
                <tr>
                  <td colSpan={2} className="px-4 py-1 text-right text-sm text-critical">
                    {tr("Late payment charge", "Der se adaigi ka charge")}
                  </td>
                  <td className="px-4 py-1 text-right text-sm tabular-nums text-critical">
                    {money(invoice.lateFeeCharged, invoice.currency)}
                  </td>
                </tr>
                <tr>
                  <td colSpan={2} className="px-4 pt-2 pb-4 text-right font-display text-base font-bold text-strong">
                    {tr("Amount due now", "Abhi qabil-e-adaigi")}
                  </td>
                  <td className="px-4 pt-2 pb-4 text-right font-display text-base font-bold tabular-nums text-strong">
                    {money(invoice.amountDue, invoice.currency)}
                  </td>
                </tr>
              </>
            )}
            {Number(invoice.lateFeeCharged) <= 0 && (
              <tr>
                <td colSpan={3} className="pb-4" />
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <DateTile icon="send" label={tr("Issued", "Jari hua")} value={when(invoice.issuedAt)} />
        <DateTile icon="event" label={tr("Due", "Aakhri tareekh")} value={when(invoice.dueAt)} />
        {invoice.paidAt && (
          <DateTile icon="check_circle" label={tr("Paid", "Ada hua")} value={when(invoice.paidAt)} />
        )}
        {invoice.voidedAt && (
          <DateTile icon="block" label={tr("Cancelled", "Mansookh hua")} value={when(invoice.voidedAt)} />
        )}
      </dl>

      {invoice.notes && (
        <p className="flex items-start gap-2 rounded-xl bg-sunken px-4 py-3 text-sm text-muted">
          <Icon name="sticky_note_2" className="mt-px shrink-0 text-[18px] text-faint" />
          {invoice.notes}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Administrative controls
// ---------------------------------------------------------------------------

/**
 * Void and credit note both demand a reason, because the note is stored on the
 * invoice and "why was this cancelled" is the first question anyone
 * reconciling the accounts will ask.
 */
function AdminActions({
  invoice,
  onChanged,
}: {
  invoice: Invoice;
  onChanged: (next: Invoice) => void;
}) {
  const tr = useTr();
  const [pending, setPending] = useState<"void" | "credit" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No "pay" here. Accepting a payment happens in the confirmation queue and
  // nowhere else; this branch outlived the button that called it, and a dead
  // path to the one endpoint we deliberately stopped offering is a trap for
  // whoever wires up the next control.
  const run = async (action: "void" | "credit") => {
    setBusy(true);
    setError(null);
    try {
      if (action === "void") {
        onChanged(await invoicesApi.void(invoice.id, reason.trim()));
      } else {
        const result = await invoicesApi.creditNote(invoice.id, reason.trim());
        onChanged(result.original);
      }
      setPending(null);
      setReason("");
    } catch (caught) {
      setError(messageOf(caught, "Could not update the invoice."));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    setPending(null);
    setReason("");
    setError(null);
  };

  const settled = invoice.status === "VOID" || invoice.status === "REFUNDED";
  const titleId = `invoice-action-${invoice.id}`;

  return (
    <div className="mt-5 space-y-3 border-t border-line pt-4">
      {error && pending === null && <ErrorState message={error} />}

      {pending === null && !settled && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-faint">
            <Icon name="admin_panel_settings" className="text-[16px]" />
            {tr("Administration", "Intezam")}
          </p>
          {/* Accepting a payment happens in one place: the "Payments to
              confirm" queue at the top of this page. It used to be offered
              here as well, and the two did different things — the queue
              credited the doctor and emailed the patient, this did neither. */}
          {invoice.status !== "PAID" && (
            <Button variant="secondary" onClick={() => setPending("void")}>
              {tr("Cancel invoice", "Invoice mansookh karein")}
            </Button>
          )}
          {invoice.status === "PAID" && (
            // A paid invoice cannot be voided: money has moved, and pretending
            // the document never existed would leave the payment unexplained.
            <Button variant="secondary" onClick={() => setPending("credit")}>
              {tr("Issue credit note", "Credit note banayein")}
            </Button>
          )}
        </div>
      )}

      <Modal
        open={pending !== null}
        titleId={titleId}
        icon={pending === "void" ? "block" : "undo"}
        title={
          pending === "void"
            ? tr("Cancel this invoice?", "Yeh invoice mansookh karein?")
            : tr("Issue a credit note?", "Credit note banayein?")
        }
        onClose={dismiss}
        footer={
          <>
            <Button variant="ghost" onClick={dismiss}>
              {tr("Back", "Wapas")}
            </Button>
            <Button
              disabled={busy || reason.trim().length < 3}
              onClick={() => void run(pending === "void" ? "void" : "credit")}
            >
              {busy
                ? tr("Saving…", "Save ho raha hai…")
                : pending === "void"
                  ? tr("Cancel invoice", "Invoice mansookh karein")
                  : tr("Issue credit note", "Credit note banayein")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-xl bg-sunken px-4 py-3 text-sm">
            <span className="font-semibold tabular-nums text-strong">{invoice.invoiceNumber}</span>
            <span className="font-display font-bold tabular-nums text-strong">
              {money(invoice.totalAmount, invoice.currency)}
            </span>
          </div>

          {error && <ErrorState message={error} />}

          <Field
            label={
              pending === "void"
                ? tr("Why is this cancelled?", "Yeh kyun mansookh ho raha hai?")
                : tr("Why is this being credited?", "Yeh raqam kyun wapas ho rahi hai?")
            }
            htmlFor={`reason-${invoice.id}`}
            hint={tr(
              "Stored on the invoice, so the accounts explain themselves later.",
              "Invoice par mehfooz hota hai, taake baad mein hisaab khud apni wazahat kare.",
            )}
          >
            <Input
              id={`reason-${invoice.id}`}
              value={reason}
              maxLength={500}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/**
 * Paying a bill, and what happens between transferring and being paid up.
 *
 * The two states here are deliberately different words. A claim that is
 * `SUBMITTED` says *waiting on the hospital* — the patient has transferred and
 * shown a screenshot, and nothing about the bill has changed yet. Only a
 * confirmed one settles it. Saying "paid" for the first would have people
 * arriving at appointments believing a debt was cleared that is still open.
 */
function PaySection({ invoice }: { invoice: Invoice }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const [claims, setClaims] = useState<PaymentClaim[] | null>(null);

  const payable = invoice.status === "ISSUED" || invoice.status === "OVERDUE";

  useEffect(() => {
    if (!payable) return;
    let cancelled = false;
    void invoicesApi
      .payments(invoice.id)
      .then((rows) => {
        if (!cancelled) setClaims(rows);
      })
      .catch(() => {
        // A bill you cannot see the history of is still a bill you can pay.
        if (!cancelled) setClaims([]);
      });
    return () => {
      cancelled = true;
    };
  }, [invoice.id, payable]);

  if (!payable || !(Number(invoice.amountDue) > 0)) return null;

  // The invoice already knows, and knows it on the first render. Waiting for
  // the claims fetch would flash a Pay button onto a bill that is under review.
  const waiting =
    claims?.find((claim) => claim.status === "SUBMITTED") ??
    (invoice.awaitingReview ? ({ reference: null } as Partial<PaymentClaim>) : undefined);
  const refused = claims?.find((claim) => claim.status === "FAILED");

  return (
    <div className="mt-5 space-y-3">
      {waiting ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-sunken p-4">
          <Icon name="hourglass_top" className="shrink-0 text-[20px] text-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-strong">
              {tr("Waiting for the hospital to confirm", "Hospital ki tasdeeq ka intezar")}
            </p>
            <p className="text-xs text-muted">
              {tr(
                `Sent with transaction ID ${waiting.reference ?? ""}. The bill stays unpaid until it is checked.`,
                `Transaction ID ${waiting.reference ?? ""} ke saath bheja gaya. Tasdeeq tak bill ada shuda nahi.`,
              )}
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* A refusal is shown *above* the button, because it is the reason
              somebody is about to press it again. */}
          {refused?.rejectionReason && (
            <div className="flex items-start gap-2 rounded-xl border border-critical/40 bg-critical-soft p-4">
              <Icon name="error" className="mt-0.5 shrink-0 text-[18px] text-critical" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-strong">
                  {tr("Your last payment was not accepted", "Aap ki pichhli adaigi qubool nahi hui")}
                </p>
                <p className="text-sm text-muted">{refused.rejectionReason}</p>
              </div>
            </div>
          )}

          <Button onClick={() => setOpen(true)}>
            <Icon name="payments" className="text-[20px]" />
            {tr(
              `Pay ${money(invoice.amountDue, invoice.currency)}`,
              `${money(invoice.amountDue, invoice.currency)} ada karein`,
            )}
          </Button>
        </>
      )}

      <PayInvoice
        invoice={invoice}
        open={open}
        onClose={() => setOpen(false)}
        onSubmitted={(claim) => setClaims((rows) => [claim, ...(rows ?? [])])}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function InvoiceRow({
  invoice,
  canManage,
  onChanged,
}: {
  invoice: Invoice;
  canManage: boolean;
  onChanged: (next: Invoice) => void;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const panelId = `invoice-${invoice.id}`;

  return (
    <>
      <tr className={cx(open && "bg-gradient-soft")}>
        <td>
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={cx(
                "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
                invoice.status === "OVERDUE"
                  ? "bg-critical-soft text-critical"
                  : "bg-gradient-soft text-primary",
              )}
            >
              <Icon name={invoice.amendsInvoiceId ? "undo" : "receipt_long"} className="text-[20px]" />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="font-semibold tabular-nums text-strong">{invoice.invoiceNumber}</p>
              <p className="mt-0.5 text-xs text-faint">
                {tr("Issued", "Jari hua")} {when(invoice.issuedAt)}
                {invoice.status === "OVERDUE" &&
                  ` · ${tr("was due", "aakhri tareekh thi")} ${when(invoice.dueAt)}`}
              </p>
            </div>
          </div>
        </td>
        <td>
          <Badge tone={STATUS_TONE[invoice.status]}>
            <Icon name={STATUS_ICON[invoice.status]} filled className="text-[14px]" />
            {tr(...STATUS_LABEL[invoice.status])}
          </Badge>
        </td>
        <td className="text-right">
          <span className="font-display text-base font-bold tabular-nums text-strong">
            {money(invoice.totalAmount, invoice.currency)}
          </span>
        </td>
        <td className="text-right">
          <Button
            variant="ghost"
            aria-expanded={open}
            aria-controls={panelId}
            className="!min-h-11 px-3 text-sm sm:!min-h-9"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? tr("Hide detail", "Tafseel chhupayein") : tr("View detail", "Tafseel dekhein")}
            <Icon
              name="expand_more"
              className={cx("text-[20px] transition-transform duration-300", open && "rotate-180")}
            />
          </Button>
        </td>
      </tr>
      <tr>
        <td colSpan={4} style={{ padding: 0, borderBottom: 0 }}>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                id={panelId}
                key="detail"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                {/* `invoice-print` is what the print stylesheet keeps; see
                    globals.css. Printing used to hand the printer the entire
                    administrator's screen with the bill buried inside it. */}
                <div className="invoice-print border-b border-line bg-sunken/60 px-5 py-5">
                  <div className="no-print mb-4 flex flex-wrap items-center gap-2">
                    <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-faint">
                      <Icon name="description" className="text-[16px]" />
                      {tr("Invoice detail", "Invoice ki tafseel")}
                    </p>
                    {/* Honest label: this opens the print dialogue, from which
                        a browser can save a PDF. There is no server-side PDF
                        generator. */}
                    <Button variant="ghost" className="ml-auto !min-h-9 px-3 text-sm" onClick={() => window.print()}>
                      <Icon name="print" className="text-[18px]" />
                      {tr("Print", "Print karein")}
                    </Button>
                  </div>
                  <PrintHeader invoice={invoice} />
                  <InvoiceDetail invoice={invoice} />
                  {/* A patient's own action. Administrators keep the counter
                      controls below; both can appear, because an administrator
                      looking at their own bill is not a special case. */}
                  <div className="no-print">
                    <PaySection invoice={invoice} />
                    {canManage && <AdminActions invoice={invoice} onChanged={onChanged} />}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </td>
      </tr>
    </>
  );
}

/**
 * Invoice history.
 *
 * `canManage` decides whether administrative controls render. It is not
 * authorization — the API re-checks every request, and a user who edits their
 * way past this still gets 403 (spec §34).
 */
export function InvoicesPanel({
  canManage = false,
  title,
  description,
}: {
  canManage?: boolean;
  title?: string;
  description?: string;
}) {
  const tr = useTr();
  const fetched = useAsync(() => invoicesApi.list({ limit: 50 }), []);
  const heading = title ?? tr("Invoices", "Invoices");
  const subheading = description ?? tr("Your billing history.", "Aap ki billing ki tareekh.");
  const [edited, setEdited] = useState<Record<string, Invoice>>({});

  const rows = (fetched.data?.data ?? []).map((invoice) => edited[invoice.id] ?? invoice);
  const outstanding = fetched.data?.meta.outstanding;

  return (
    <Card
      flush
      icon="receipt_long"
      title={heading}
      description={subheading}
      action={
        outstanding !== undefined && (
          <div className="flex items-center gap-3 rounded-xl border border-line bg-sunken px-3.5 py-2">
            <Icon name="account_balance_wallet" className="text-[22px] text-primary" />
            <div className="leading-tight">
              <p className="text-[11px] font-bold uppercase tracking-wider text-faint">
                {tr("Outstanding", "Baqaya")}
              </p>
              <p className="text-gradient-brand font-display text-lg font-bold tabular-nums">{outstanding}</p>
            </div>
          </div>
        )
      }
    >
      {fetched.loading && (
        <div role="status" aria-live="polite">
          <span className="sr-only">{tr("Loading invoices", "Invoices load ho rahe hain")}…</span>
          <SkeletonTable rows={4} columns={3} />
        </div>
      )}
      {fetched.error && (
        <div className="p-6">
          <ErrorState message={fetched.error.message} onRetry={fetched.reload} />
        </div>
      )}

      {!fetched.loading && !fetched.error && rows.length === 0 && (
        <EmptyState
          icon="receipt_long"
          title={tr("No invoices", "Koi invoice nahi")}
          description={tr(
            "An invoice is created automatically when a consultation is completed.",
            "Consultation mukammal hote hi invoice khud ban jaata hai.",
          )}
        />
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto px-2 pb-2 pt-2">
          <table className="table-modern min-w-[40rem]">
            <caption className="sr-only">{heading}</caption>
            <thead>
              <tr>
                <th scope="col">{tr("Invoice", "Invoice")}</th>
                <th scope="col">{tr("Status", "Haalat")}</th>
                <th scope="col" className="!text-right">{tr("Total", "Mila kar total")}</th>
                <th scope="col">
                  <span className="sr-only">{tr("Actions", "Amal")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((invoice) => (
                <InvoiceRow
                  key={invoice.id}
                  invoice={invoice}
                  canManage={canManage}
                  onChanged={(next) => setEdited((current) => ({ ...current, [next.id]: next }))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
