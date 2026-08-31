/**
 * The rates screen, and the two ways it used to be wrong.
 *
 * The first is the bug that was reported: typing `15%` into a box whose own
 * hint says "percent" disabled Save and said only "Enter a number in each box".
 * People write percentages with a percent sign and money with commas, and a
 * form that refuses the notation it asked for is a form that looks broken.
 *
 * The second is what the screen exists for now: each figure can be a flat
 * amount or a share, so the mode has to travel with the value — a platform fee
 * of `2` means two rupees or two percent, and nothing else in the payload says
 * which.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BillingRates } from "@/components/BillingRates";
import * as api from "@/lib/api";

vi.mock("@/components/overlays", async () => {
  const actual = await vi.importActual<typeof import("@/components/overlays")>(
    "@/components/overlays",
  );
  return { ...actual, useToast: () => ({ show: vi.fn() }) };
});

function settings(overrides: Partial<api.BillingSettings> = {}): api.BillingSettings {
  return {
    taxPercent: "0.00",
    taxMode: "PERCENT",
    platformFee: "0.00",
    platformFeeMode: "FIXED",
    lateFee: "0.00",
    lateFeeMode: "FIXED",
    paymentTermsDays: 3,
    currency: "PKR",
    updatedAt: null,
    ...overrides,
  };
}

function mount(initial: api.BillingSettings = settings()) {
  vi.spyOn(api.billingSettings, "read").mockResolvedValue(initial);
  const update = vi
    .spyOn(api.billingSettings, "update")
    .mockImplementation(async (input) => settings(input as Partial<api.BillingSettings>));
  render(<BillingRates />);
  return update;
}

const save = () => screen.getByRole("button", { name: /Save rates/ });
const taxBox = () => screen.getByLabelText("Tax");

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("what somebody is allowed to type", () => {
  it("accepts a percentage written with a percent sign", async () => {
    // The reported bug, exactly.
    const update = mount();
    await userEvent.clear(await screen.findByLabelText("Tax"));
    await userEvent.type(taxBox(), "15%");

    expect(save()).toBeEnabled();

    await userEvent.click(save());
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    // The sign is notation, not part of the number.
    expect(update.mock.calls[0][0].taxPercent).toBe("15");
  });

  it("accepts an amount written with a thousands separator", async () => {
    const update = mount();
    await userEvent.clear(await screen.findByLabelText("Platform fee"));
    await userEvent.type(screen.getByLabelText("Platform fee"), "1,500");

    await userEvent.click(save());
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0][0].platformFee).toBe("1500");
  });

  it("still refuses something that is not a number at all", async () => {
    mount();
    await userEvent.clear(await screen.findByLabelText("Tax"));
    await userEvent.type(taxBox(), "abc");

    expect(save()).toBeDisabled();
    expect(screen.getByText("Enter a number.")).toBeInTheDocument();
  });

  it("refuses a share of a bill larger than the bill", async () => {
    mount();
    await userEvent.clear(await screen.findByLabelText("Tax"));
    await userEvent.type(taxBox(), "150");

    expect(save()).toBeDisabled();
    expect(screen.getByText("A percentage cannot be over 100.")).toBeInTheDocument();
  });

  it("allows the same number as a flat amount, because 150 rupees is ordinary", async () => {
    // The ceiling depends on the mode, which is why it cannot be a constraint
    // on the field itself.
    mount();
    await screen.findByLabelText("Tax");
    await userEvent.click(screen.getAllByRole("button", { name: "PKR" })[0]);
    await userEvent.clear(taxBox());
    await userEvent.type(taxBox(), "150");

    expect(save()).toBeEnabled();
  });
});

describe("the mode travels with the value", () => {
  it("sends the mode each figure was switched to", async () => {
    const update = mount();
    await screen.findByLabelText("Platform fee");

    // Platform fee: rupees by default, switched to a percentage.
    const platformSwitch = screen.getByRole("group", { name: "Platform fee: amount or percentage" });
    await userEvent.click(within(platformSwitch).getByRole("button", { name: "%" }));

    await userEvent.clear(screen.getByLabelText("Platform fee"));
    await userEvent.type(screen.getByLabelText("Platform fee"), "2");
    await userEvent.click(save());

    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0][0]).toMatchObject({
      platformFee: "2",
      platformFeeMode: "PERCENT",
      // Untouched figures keep the mode they arrived with.
      taxMode: "PERCENT",
      lateFeeMode: "FIXED",
    });
  });

  it("shows what the number means, and changes it with the mode", async () => {
    mount();
    await screen.findByLabelText("Late payment charge");
    expect(screen.getByText("PKR, added once.")).toBeInTheDocument();

    const lateSwitch = screen.getByRole("group", { name: "Late payment charge: amount or percentage" });
    await userEvent.click(within(lateSwitch).getByRole("button", { name: "%" }));

    expect(screen.getByText("Of the invoice total.")).toBeInTheDocument();
  });
});

describe("what the screen promises", () => {
  it("says a change does not touch invoices already issued", async () => {
    // The assumption everybody makes is the opposite one.
    mount();
    expect(
      await screen.findByText(/Invoices already issued keep the rates they were charged at/),
    ).toBeInTheDocument();
  });

  it("says the late charge lands once rather than daily", async () => {
    mount(settings({ paymentTermsDays: 3 }));
    expect(await screen.findByText(/added once — never per day/)).toBeInTheDocument();
  });
});
