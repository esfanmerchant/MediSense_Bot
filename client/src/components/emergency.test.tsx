/**
 * Break-glass, in the browser (R3, Phase 14 "UI tests").
 *
 * This screen has an unusual double job: it has to make a clinician comfortable
 * using it in a genuine emergency, and uncomfortable using it otherwise. Both
 * halves are failures if missed. A screen that feels like a violation to open
 * will not be used when someone is dying; one that feels like an ordinary
 * button will be used to read a colleague's chart.
 *
 * So what is tested is the honesty of the interface: that it says what will be
 * recorded *before* the request rather than after, that it will not accept a
 * reason too short to explain anything, and that handing access back is as easy
 * as taking it.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EmergencyAccessPanel, EmergencyReviewPanel } from "@/components/emergency";
import * as api from "@/lib/api";
import type { EmergencyGrant, GrantedAccess } from "@/lib/api";

const REASON = "Unresponsive patient in resus, no assigned clinician available.";

function grant(overrides: Partial<EmergencyGrant> = {}): EmergencyGrant {
  return {
    id: "g1",
    requesterId: "u-nurse",
    requesterName: "Nurse Rao",
    patientId: "p1",
    reason: REASON,
    status: "ACTIVE",
    grantedAt: "2026-09-01T09:00:00Z",
    expiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
    revokedAt: null,
    accessCount: 3,
    reviewedAt: null,
    reviewedById: null,
    reviewNotes: null,
    live: true,
    ...overrides,
  };
}

function granted(overrides: Partial<GrantedAccess> = {}): GrantedAccess {
  return {
    ...grant(),
    created: true,
    expiresInMinutes: 30,
    notice:
      "This access is limited to this patient, expires automatically, and every record you open is logged and reviewed.",
    ...overrides,
  };
}

describe("before requesting", () => {
  it("states what will be recorded, unprompted", async () => {
    // Consent theatre would be a checkbox. A clinician who knows exactly what
    // the trail will say is the one this control is designed for.
    vi.spyOn(api.emergency, "active").mockResolvedValue([]);
    render(<EmergencyAccessPanel />);

    expect(await screen.findByText(/what happens when you do this/i)).toBeInTheDocument();
    expect(screen.getByText(/this patient only/i)).toBeInTheDocument();
    expect(screen.getByText(/expires automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/the patient is told/i)).toBeInTheDocument();
    expect(screen.getByText(/an administrator reviews it/i)).toBeInTheDocument();
  });

  it("will not accept a reason too short to explain anything", async () => {
    vi.spyOn(api.emergency, "active").mockResolvedValue([]);
    const user = userEvent.setup();
    render(<EmergencyAccessPanel />);

    await user.type(await screen.findByLabelText(/patient identifier/i), "p1");
    await user.type(screen.getByLabelText(/why do you need access/i), "urgent");

    expect(screen.getByRole("button", { name: /request emergency access/i })).toBeDisabled();
  });

  it("enables the request once there is a real reason", async () => {
    vi.spyOn(api.emergency, "active").mockResolvedValue([]);
    const user = userEvent.setup();
    render(<EmergencyAccessPanel />);

    await user.type(await screen.findByLabelText(/patient identifier/i), "p1");
    await user.type(screen.getByLabelText(/why do you need access/i), REASON);

    expect(screen.getByRole("button", { name: /request emergency access/i })).toBeEnabled();
  });

  it("does not dress the action up as a mistake", async () => {
    // This is a legitimate clinical action. Styling it as destructive would
    // discourage the very use it exists for.
    vi.spyOn(api.emergency, "active").mockResolvedValue([]);
    render(<EmergencyAccessPanel />);

    const button = await screen.findByRole("button", { name: /request emergency access/i });
    expect(button.className).not.toMatch(/bg-red/);
  });
});

describe("after requesting", () => {
  it("repeats the terms it is granting under", async () => {
    vi.spyOn(api.emergency, "active").mockResolvedValue([]);
    vi.spyOn(api.emergency, "request").mockResolvedValue(granted());
    const user = userEvent.setup();
    render(<EmergencyAccessPanel />);

    await user.type(await screen.findByLabelText(/patient identifier/i), "p1");
    await user.type(screen.getByLabelText(/why do you need access/i), REASON);
    await user.click(screen.getByRole("button", { name: /request emergency access/i }));

    const confirmation = await screen.findByRole("status");
    expect(within(confirmation).getByText(/access granted/i)).toBeInTheDocument();
    expect(within(confirmation).getByText(/logged and reviewed/i)).toBeInTheDocument();
  });

  it("says so when an existing grant was reused", async () => {
    // A dropped session mid-emergency should not look like a second breach.
    vi.spyOn(api.emergency, "active").mockResolvedValue([]);
    vi.spyOn(api.emergency, "request").mockResolvedValue(granted({ created: false }));
    const user = userEvent.setup();
    render(<EmergencyAccessPanel />);

    await user.type(await screen.findByLabelText(/patient identifier/i), "p1");
    await user.type(screen.getByLabelText(/why do you need access/i), REASON);
    await user.click(screen.getByRole("button", { name: /request emergency access/i }));

    expect(await screen.findByText(/already had access/i)).toBeInTheDocument();
  });
});

describe("access currently held", () => {
  it("shows how long is left and how much has been opened", async () => {
    vi.spyOn(api.emergency, "active").mockResolvedValue([grant({ accessCount: 3 })]);
    render(<EmergencyAccessPanel />);

    expect(await screen.findByText(/expires in \d+ min/i)).toBeInTheDocument();
    expect(screen.getByText(/3 records opened/i)).toBeInTheDocument();
  });

  it("offers to hand it back", async () => {
    const revoke = vi.spyOn(api.emergency, "revoke").mockResolvedValue(
      grant({ status: "REVOKED", live: false }),
    );
    vi.spyOn(api.emergency, "active").mockResolvedValue([grant()]);
    const user = userEvent.setup();
    render(<EmergencyAccessPanel />);

    await user.click(await screen.findByRole("button", { name: /end access/i }));
    expect(revoke).toHaveBeenCalledWith("g1");
  });

  it("says plainly when nothing is open", async () => {
    vi.spyOn(api.emergency, "active").mockResolvedValue([]);
    render(<EmergencyAccessPanel />);

    expect(await screen.findByText(/no open access/i)).toBeInTheDocument();
  });
});

describe("the review queue", () => {
  function mockQueue(rows: EmergencyGrant[], unreviewed: number) {
    vi.spyOn(api.emergency, "list").mockResolvedValue({
      data: rows,
      meta: { total: rows.length, limit: 50, offset: 0, hasMore: false, unreviewed },
    });
  }

  it("puts the outstanding count in front of the reviewer", async () => {
    // The control this design rests on is that somebody looks at every grant.
    // A number only visible behind a filter is not a control.
    mockQueue([grant()], 1);
    render(<EmergencyReviewPanel />);

    expect(await screen.findByText(/awaiting review/i)).toBeInTheDocument();
  });

  it("shows the reason and how much was read", async () => {
    // One read and ninety reads are very different events, and that difference
    // is the first thing a reviewer should weigh.
    mockQueue([grant({ accessCount: 90 })], 1);
    render(<EmergencyReviewPanel />);

    expect(await screen.findByText(REASON)).toBeInTheDocument();
    expect(screen.getByText("90")).toBeInTheDocument();
  });

  it("requires notes before a review can be recorded", async () => {
    mockQueue([grant()], 1);
    const user = userEvent.setup();
    render(<EmergencyReviewPanel />);

    await user.click(await screen.findByRole("button", { name: /record review/i }));
    expect(screen.getByRole("button", { name: /save review/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/review notes/i), "Checked against the resus log.");
    expect(screen.getByRole("button", { name: /save review/i })).toBeEnabled();
  });

  it("offers no review control once one is recorded", async () => {
    mockQueue(
      [
        grant({
          reviewedAt: "2026-09-01T12:00:00Z",
          reviewedById: "u-admin",
          reviewNotes: "Appropriate.",
        }),
      ],
      0,
    );
    render(<EmergencyReviewPanel />);

    expect(await screen.findByText("Appropriate.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /record review/i })).toBeNull();
  });

  it("names a deleted requester honestly", async () => {
    // The trail outlives the account — `userId` is deliberately not a foreign
    // key (R6) — so a missing name is a fact, not a broken row.
    mockQueue([grant({ requesterName: null })], 1);
    render(<EmergencyReviewPanel />);

    expect(await screen.findByText(/deleted account/i)).toBeInTheDocument();
  });
});
