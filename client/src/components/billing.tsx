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

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  PAID: "Paid",
  ISSUED: "Due",
  OVERDUE: "Overdue",
  VOID: "Cancelled",
  REFUNDED: "Credited",
  DRAFT: "Draft",
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
  return (
    <div className="space-y-4">
      {invoice.amendsInvoiceId && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          This is a credit note correcting an earlier invoice. The original is kept as issued.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[24rem] text-sm">
          <caption className="sr-only">Invoice {invoice.invoiceNumber} line items</caption>
          <thead>
            <tr className="border-b border-slate-200 text-left dark:border-slate-700">
              <th scope="col" className="py-2 pr-4 font-medium">Description</th>
              <th scope="col" className="py-2 pr-4 font-medium">Qty</th>
              <th scope="col" className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lineItems.map((line, index) => (
              <tr key={index} className="border-b border-slate-100 dark:border-slate-800">
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
              <td colSpan={2} className="py-1 pr-4 text-right text-slate-600 dark:text-slate-400">
                Subtotal
              </td>
              <td className="py-1 text-right tabular-nums">
                {money(invoice.amount, invoice.currency)}
              </td>
            </tr>
            <tr>
              <td colSpan={2} className="py-1 pr-4 text-right text-slate-600 dark:text-slate-400">
                Tax
              </td>
              <td className="py-1 text-right tabular-nums">
                {money(invoice.taxAmount, invoice.currency)}
              </td>
            </tr>
            <tr className="border-t border-slate-300 dark:border-slate-600">
              <td colSpan={2} className="py-2 pr-4 text-right font-semibold">
                Total
              </td>
              <td className="py-2 text-right font-semibold tabular-nums">
                {money(invoice.totalAmount, invoice.currency)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-slate-600 dark:text-slate-400">Issued</dt>
        <dd className="tabular-nums">{when(invoice.issuedAt)}</dd>
        <dt className="text-slate-600 dark:text-slate-400">Due</dt>
        <dd className="tabular-nums">{when(invoice.dueAt)}</dd>
        {invoice.paidAt && (
          <>
            <dt className="text-slate-600 dark:text-slate-400">Paid</dt>
            <dd className="tabular-nums">{when(invoice.paidAt)}</dd>
          </>
        )}
        {invoice.voidedAt && (
          <>
            <dt className="text-slate-600 dark:text-slate-400">Cancelled</dt>
            <dd className="tabular-nums">{when(invoice.voidedAt)}</dd>
          </>
        )}
      </dl>

      {invoice.notes && (
        <p className="text-sm text-slate-600 dark:text-slate-400">{invoice.notes}</p>
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
    <div className="mt-4 space-y-3 border-t border-slate-200 pt-4 dark:border-slate-700">
      {error && <ErrorState message={error} />}

      {pending === null && !settled && (
        <div className="flex flex-wrap gap-2">
          {invoice.status !== "PAID" && (
            <Button disabled={busy} onClick={() => void run("pay")}>
              Record payment
            </Button>
          )}
          {invoice.status !== "PAID" && (
            <Button variant="secondary" onClick={() => setPending("void")}>
              Cancel invoice
            </Button>
          )}
          {invoice.status === "PAID" && (
            // A paid invoice cannot be voided: money has moved, and pretending
            // the document never existed would leave the payment unexplained.
            <Button variant="secondary" onClick={() => setPending("credit")}>
              Issue credit note
            </Button>
          )}
        </div>
      )}

      {pending !== null && (
        <div className="space-y-3">
          <Field
            label={pending === "void" ? "Why is this cancelled?" : "Why is this being credited?"}
            htmlFor={`reason-${invoice.id}`}
            hint="Stored on the invoice, so the accounts explain themselves later."
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
              {busy ? "Saving…" : pending === "void" ? "Cancel invoice" : "Issue credit note"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPending(null);
                setReason("");
                setError(null);
              }}
            >
              Back
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
  const [open, setOpen] = useState(false);

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
          {invoice.invoiceNumber}
        </span>
        <Badge tone={STATUS_TONE[invoice.status]}>{STATUS_LABEL[invoice.status]}</Badge>
        <span className="ml-auto font-semibold tabular-nums">
          {money(invoice.totalAmount, invoice.currency)}
        </span>
      </div>

      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Issued {when(invoice.issuedAt)}
        {invoice.status === "OVERDUE" && ` · was due ${when(invoice.dueAt)}`}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide detail" : "View detail"}
        </Button>
        {open && (
          // Honest label: this opens the print dialogue, from which a browser
          // can save a PDF. There is no server-side PDF generator.
          <Button variant="ghost" onClick={() => window.print()}>
            Print
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
  title = "Invoices",
  description = "Your billing history.",
}: {
  canManage?: boolean;
  title?: string;
  description?: string;
}) {
  const fetched = useAsync(() => invoicesApi.list({ limit: 50 }), []);
  const [edited, setEdited] = useState<Record<string, Invoice>>({});

  const rows = (fetched.data?.data ?? []).map((invoice) => edited[invoice.id] ?? invoice);
  const outstanding = fetched.data?.meta.outstanding;

  return (
    <Card
      title={title}
      description={description}
      action={
        outstanding !== undefined && (
          <div className="text-right">
            <p className="text-xs text-slate-600 dark:text-slate-400">Outstanding</p>
            <p className="text-lg font-semibold tabular-nums">{outstanding}</p>
          </div>
        )
      }
    >
      {fetched.loading && <Loading label="Loading invoices" />}
      {fetched.error && <ErrorState message={fetched.error.message} onRetry={fetched.reload} />}

      {!fetched.loading && !fetched.error && rows.length === 0 && (
        <EmptyState
          title="No invoices"
          description="An invoice is created automatically when a consultation is completed."
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
