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

import { useState } from "react";

import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading } from "@/components/ui";
import {
  ApiError,
  invoices as invoicesApi,
  type Invoice,
  type InvoiceStatus,
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
  VOID: "neutral",
  REFUNDED: "warning",
  DRAFT: "neutral",
};

const STATUS_LABEL: Record<InvoiceStatus, [string, string]> = {
  PAID: ["Paid", "Ada shuda"],
  ISSUED: ["Due", "Wajib-ul-ada"],
  OVERDUE: ["Overdue", "Muddat guzar gayi"],
  VOID: ["Cancelled", "Mansookh"],
  REFUNDED: ["Credited", "Wapas kiya gaya"],
  DRAFT: ["Draft", "Musawwada"],
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

function InvoiceDetail({ invoice }: { invoice: Invoice }) {
  const tr = useTr();
  return (
    <div className="space-y-4">
      {invoice.amendsInvoiceId && (
        <p className="rounded-md border border-warning/50 bg-warning-soft px-3 py-2 text-sm text-warning">
          {tr(
            "This is a credit note correcting an earlier invoice. The original is kept as issued.",
            "Yeh credit note hai jo pichhle invoice ki islah karta hai. Asal invoice jaisa jari hua tha waisa hi mehfooz hai.",
          )}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[24rem] text-sm">
          <caption className="sr-only">Invoice {invoice.invoiceNumber} line items</caption>
          <thead>
            <tr className="border-b border-line text-left">
              <th scope="col" className="py-2 pr-4 font-medium">{tr("Description", "Tafseel")}</th>
              <th scope="col" className="py-2 pr-4 font-medium">{tr("Qty", "Tadaad")}</th>
              <th scope="col" className="py-2 text-right font-medium">{tr("Amount", "Raqam")}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((line, index) => (
              <tr key={index} className="border-b border-line">
                <td className="py-2 pr-4">{line.description}</td>
                <td className="py-2 pr-4 tabular-nums">{line.quantity}</td>
                <td className="py-2 text-right tabular-nums">
                  {money(line.amount, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} className="py-1 pr-4 text-right text-muted">
                {tr("Subtotal", "Kul raqam")}
              </td>
              <td className="py-1 text-right tabular-nums">
                {money(invoice.amount, invoice.currency)}
              </td>
            </tr>
            <tr>
              <td colSpan={2} className="py-1 pr-4 text-right text-muted">
                {tr("Tax", "Tax")}
              </td>
              <td className="py-1 text-right tabular-nums">
                {money(invoice.taxAmount, invoice.currency)}
              </td>
            </tr>
            <tr className="border-t border-line-strong">
              <td colSpan={2} className="py-2 pr-4 text-right font-semibold">
                {tr("Total", "Mila kar total")}
              </td>
              <td className="py-2 text-right font-semibold tabular-nums">
                {money(invoice.totalAmount, invoice.currency)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-muted">{tr("Issued", "Jari hua")}</dt>
        <dd className="tabular-nums">{when(invoice.issuedAt)}</dd>
        <dt className="text-muted">{tr("Due", "Aakhri tareekh")}</dt>
        <dd className="tabular-nums">{when(invoice.dueAt)}</dd>
        {invoice.paidAt && (
          <>
            <dt className="text-muted">{tr("Paid", "Ada hua")}</dt>
            <dd className="tabular-nums">{when(invoice.paidAt)}</dd>
          </>
        )}
        {invoice.voidedAt && (
          <>
            <dt className="text-muted">{tr("Cancelled", "Mansookh hua")}</dt>
            <dd className="tabular-nums">{when(invoice.voidedAt)}</dd>
          </>
        )}
      </dl>

      {invoice.notes && (
        <p className="text-sm text-muted">{invoice.notes}</p>
      )}
    </div>
  );
}

/**
 * Administrative controls.
 *
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

  const run = async (action: "pay" | "void" | "credit") => {
    setBusy(true);
    setError(null);
    try {
      if (action === "pay") {
        onChanged(await invoicesApi.pay(invoice.id));
      } else if (action === "void") {
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

  const settled = invoice.status === "VOID" || invoice.status === "REFUNDED";

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      {error && <ErrorState message={error} />}

      {pending === null && !settled && (
        <div className="flex flex-wrap gap-2">
          {invoice.status !== "PAID" && (
            <Button disabled={busy} onClick={() => void run("pay")}>
              {tr("Record payment", "Adaigi darj karein")}
            </Button>
          )}
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

      {pending !== null && (
        <div className="space-y-3">
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
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
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
            <Button
              variant="ghost"
              onClick={() => {
                setPending(null);
                setReason("");
                setError(null);
              }}
            >
              {tr("Back", "Wapas")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function InvoiceCard({
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

  return (
    <li className="rounded-lg border border-line bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium tabular-nums text-strong">
          {invoice.invoiceNumber}
        </span>
        <Badge tone={STATUS_TONE[invoice.status]}>{tr(...STATUS_LABEL[invoice.status])}</Badge>
        <span className="ml-auto font-semibold tabular-nums">
          {money(invoice.totalAmount, invoice.currency)}
        </span>
      </div>

      <p className="mt-1 text-sm text-muted">
        {tr("Issued", "Jari hua")} {when(invoice.issuedAt)}
        {invoice.status === "OVERDUE" &&
          ` · ${tr("was due", "aakhri tareekh thi")} ${when(invoice.dueAt)}`}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? tr("Hide detail", "Tafseel chhupayein") : tr("View detail", "Tafseel dekhein")}
        </Button>
        {open && (
          // Honest label: this opens the print dialogue, from which a browser
          // can save a PDF. There is no server-side PDF generator.
          <Button variant="ghost" onClick={() => window.print()}>
            {tr("Print", "Print karein")}
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-4">
          <InvoiceDetail invoice={invoice} />
          {canManage && <AdminActions invoice={invoice} onChanged={onChanged} />}
        </div>
      )}
    </li>
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
      title={heading}
      description={subheading}
      action={
        outstanding !== undefined && (
          <div className="text-right">
            <p className="text-xs text-muted">{tr("Outstanding", "Baqaya")}</p>
            <p className="text-lg font-semibold tabular-nums">{outstanding}</p>
          </div>
        )
      }
    >
      {fetched.loading && <Loading label={tr("Loading invoices", "Invoices load ho rahe hain")} />}
      {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

      {!fetched.loading && !fetched.error && rows.length === 0 && (
        <EmptyState
          title={tr("No invoices", "Koi invoice nahi")}
          description={tr(
            "An invoice is created automatically when a consultation is completed.",
            "Consultation mukammal hote hi invoice khud ban jaata hai.",
          )}
        />
      )}

      {rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map((invoice) => (
            <InvoiceCard
              key={invoice.id}
              invoice={invoice}
              canManage={canManage}
              onChanged={(next) => setEdited((current) => ({ ...current, [next.id]: next }))}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}
