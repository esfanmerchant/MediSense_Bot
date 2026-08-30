/**
 * Invoices, in the browser (spec §15, Phase 14 "UI tests").
 *
 * Two properties that only exist on the client and would be invisible to any
 * server-side test:
 *
 * - **Money never becomes a JavaScript number.** The API sends amounts as
 *   strings because `0.1 + 0.2` is not `0.3` in binary floating point. A client
 *   that parses them is one rounding error away from an invoice that disagrees
 *   with itself, and nothing on the server would ever notice.
 * - **An issued invoice offers no edit.** There is no endpoint behind one, and
 *   an interface implying otherwise would misrepresent the guarantee (C4).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InvoicesPanel } from "@/components/billing";
import * as api from "@/lib/api";
import type { Invoice } from "@/lib/api";

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    patientId: "patient-1",
    appointmentId: "appt-1",
    invoiceNumber: "INV-2026-000042",
    amount: "500.10",
    taxAmount: "0.20",
    totalAmount: "500.30",
    currency: "PKR",
    status: "ISSUED",
    lineItems: [
      {
        description: "Consultation — Dr Iyer (Cardiology)",
        quantity: 1,
        unitPrice: "500.10",
        amount: "500.10",
      },
    ],
    notes: null,
    issuedAt: "2026-09-01T09:00:00Z",
    dueAt: "2026-10-01T09:00:00Z",
    paidAt: null,
    voidedAt: null,
    amendsInvoiceId: null,
    createdAt: "2026-09-01T09:00:00Z",
    ...overrides,
  };
}

function mockList(rows: Invoice[], outstanding = "500.30") {
  vi.spyOn(api.invoices, "list").mockResolvedValue({
    data: rows,
    meta: { total: rows.length, limit: 50, offset: 0, hasMore: false, outstanding },
  });
}

describe("amounts", () => {
  it("renders exactly what the server sent", async () => {
    // 500.10 + 0.20 is 500.30000000000007 in binary floating point. If any of
    // these had been through Number(), this assertion is what would catch it.
    mockList([invoice()]);
    const user = userEvent.setup();
    render(<InvoicesPanel />);

    await user.click(await screen.findByRole("button", { name: /view detail/i }));

    // 500.10 appears twice — as the line item and as the subtotal — which is
    // correct, so both are matched rather than asserting a single occurrence.
    expect(screen.getAllByText("PKR 500.10")).toHaveLength(2);
    expect(screen.getByText("PKR 0.20")).toBeInTheDocument();
    expect(screen.getAllByText("PKR 500.30").length).toBeGreaterThan(0);
  });

  it("does not compute a total of its own", async () => {
    // The server's total is authoritative even when it looks wrong to the
    // client: a discount or a correction lives there, not here.
    mockList([invoice({ amount: "100.00", taxAmount: "0.00", totalAmount: "80.00" })], "80.00");
    const user = userEvent.setup();
    render(<InvoicesPanel />);

    await user.click(await screen.findByRole("button", { name: /view detail/i }));
    expect(screen.getAllByText("PKR 80.00").length).toBeGreaterThan(0);
  });

  it("shows a credit note as negative", async () => {
    mockList([
      invoice({
        id: "inv-2",
        totalAmount: "-500.30",
        amount: "-500.10",
        taxAmount: "-0.20",
        amendsInvoiceId: "inv-1",
        status: "ISSUED",
      }),
    ]);
    render(<InvoicesPanel />);
    // The minus sign is a real one, not a hyphen, and it is not dropped.
    expect(await screen.findByText("−PKR 500.30")).toBeInTheDocument();
  });
});

describe("an issued invoice", () => {
  it("offers no way to edit it", async () => {
    // Corrections are a void or a credit note. There is no edit endpoint, so
    // there must be no edit control (C4).
    mockList([invoice()]);
    const user = userEvent.setup();
    render(<InvoicesPanel canManage />);

    await user.click(await screen.findByRole("button", { name: /view detail/i }));

    const editors = screen
      .getAllByRole("button")
      .filter((button) => /^edit|change amount|amend/i.test(button.textContent ?? ""));
    expect(editors).toHaveLength(0);
  });

  it("cannot be cancelled once paid", async () => {
    // Money has moved; voiding the document would leave the payment
    // unexplained. The server refuses it, and the UI does not offer it.
    mockList([invoice({ status: "PAID", paidAt: "2026-09-02T10:00:00Z" })], "0.00");
    const user = userEvent.setup();
    render(<InvoicesPanel canManage />);

    await user.click(await screen.findByRole("button", { name: /view detail/i }));

    expect(screen.queryByRole("button", { name: /cancel invoice/i })).toBeNull();
    expect(screen.getByRole("button", { name: /credit note/i })).toBeInTheDocument();
  });

  it("requires a reason before cancelling", async () => {
    // "Why is this cancelled" is the first question anyone reconciling the
    // accounts will ask, so the button stays disabled until there is an answer.
    mockList([invoice()]);
    const user = userEvent.setup();
    render(<InvoicesPanel canManage />);

    await user.click(await screen.findByRole("button", { name: /view detail/i }));
    await user.click(screen.getByRole("button", { name: /cancel invoice/i }));

    const confirm = screen.getAllByRole("button", { name: /cancel invoice/i }).at(-1)!;
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/why is this cancelled/i), "Billed in error");
    expect(screen.getAllByRole("button", { name: /cancel invoice/i }).at(-1)!).toBeEnabled();
  });
});

describe("without management rights", () => {
  it("shows no administrative controls", async () => {
    // Not authorization — the API re-checks every request (§34) — but a patient
    // must not be shown a button that will only ever return 403.
    mockList([invoice()]);
    const user = userEvent.setup();
    render(<InvoicesPanel />);

    await user.click(await screen.findByRole("button", { name: /view detail/i }));

    expect(screen.queryByRole("button", { name: /record payment/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancel invoice/i })).toBeNull();
  });
});

describe("the empty state", () => {
  it("explains where invoices come from", async () => {
    mockList([], "0");
    render(<InvoicesPanel />);
    expect(await screen.findByText(/no invoices/i)).toBeInTheDocument();
    expect(screen.getByText(/automatically when a consultation is completed/i)).toBeInTheDocument();
  });
});
