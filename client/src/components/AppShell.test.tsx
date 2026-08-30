/**
 * The application shell (spec §34, Phase 14 "UI tests").
 *
 * The shell decides what to *render*, never what is allowed. The API re-checks
 * every request, so a user who edits their way past this still gets a 403 —
 * which is exactly why these tests assert what a role is *shown* rather than
 * what it can do.
 *
 * The failure worth catching is the opposite one: showing a role a link it will
 * only ever get refused on, or hiding one it needs. A nurse with no navigation
 * to emergency access cannot break glass when it matters.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The shell reads the current path and can redirect. Neither exists outside a
// mounted App Router, so both are stubbed — what is under test is which links
// the shell chooses to render, not Next's routing.
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/patient",
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

import { AppShell } from "@/components/AppShell";
import type { AuthUser, Role } from "@/lib/api";
import * as session from "@/lib/session";

function user(role: Role): AuthUser {
  // Fully typed rather than cast: a field added to AuthUser should fail the
  // typecheck here, not be silently absent from every shell test.
  return {
    id: "u1",
    name: "Test User",
    email: "test@example.com",
    role,
    phone: null,
    status: "ACTIVE",
    permissions: [],
    patientId: role === "PATIENT" ? "p1" : null,
    doctorId: role === "DOCTOR" ? "d1" : null,
  };
}

function signedInAs(role: Role) {
  vi.spyOn(session, "useSession").mockReturnValue({
    user: user(role),
    loading: false,
    signOut: vi.fn(),
    showWarning: false,
    secondsRemaining: null,
    stayAlive: vi.fn(),
  } as unknown as ReturnType<typeof session.useSession>);
}

function navLinks(): string[] {
  const nav = screen.getByRole("navigation", { name: "Main" });
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.getAttribute("href") ?? "");
}

describe("navigation", () => {
  it("shows a patient their own areas and nothing administrative", () => {
    signedInAs("PATIENT");
    render(
      <AppShell role="PATIENT">
        <p>content</p>
      </AppShell>,
    );

    const links = navLinks();
    expect(links).toContain("/patient/records");
    expect(links).toContain("/patient/billing");
    expect(links).toContain("/patient/assistant");
    expect(links.some((href) => href.startsWith("/admin"))).toBe(false);
    expect(links.some((href) => href.startsWith("/doctor"))).toBe(false);
  });

  it("gives a doctor their alert queue", () => {
    signedInAs("DOCTOR");
    render(
      <AppShell role="DOCTOR">
        <p>content</p>
      </AppShell>,
    );

    const links = navLinks();
    expect(links).toContain("/doctor/alerts");
    expect(links).toContain("/doctor/patients");
    // Billing is administrative; doctors hold no invoice permission at all.
    expect(links.some((href) => href.includes("billing"))).toBe(false);
  });

  it("gives an administrator the audit trail and review queue", () => {
    signedInAs("ADMIN");
    render(
      <AppShell role="ADMIN">
        <p>content</p>
      </AppShell>,
    );

    const links = navLinks();
    expect(links).toContain("/admin/audit");
    expect(links).toContain("/admin/emergency");
    // R2: running the hospital is not a reason to read a chart, so there is no
    // link to one.
    expect(links.some((href) => href.includes("/records"))).toBe(false);
  });

  it("gives a nurse exactly one destination", () => {
    // Conflict C1: no standing access to patient data means no patient list to
    // link to. Emergency access is the whole of what the role can reach — and
    // it must be reachable, or break-glass is unusable when it matters.
    signedInAs("NURSE");
    render(
      <AppShell role="NURSE">
        <p>content</p>
      </AppShell>,
    );

    expect(navLinks()).toEqual(["/no-dashboard"]);
  });
});

describe("the role guard", () => {
  it("refuses to render another role's area", () => {
    signedInAs("PATIENT");
    render(
      <AppShell role="ADMIN">
        <p>secret admin content</p>
      </AppShell>,
    );

    expect(screen.queryByText("secret admin content")).toBeNull();
    expect(screen.getByText(/do not have access/i)).toBeInTheDocument();
  });

  it("says which role the area is for", () => {
    signedInAs("DOCTOR");
    render(
      <AppShell role="ADMIN">
        <p>content</p>
      </AppShell>,
    );

    expect(screen.getByText(/this area is for admins/i)).toBeInTheDocument();
  });

  it("renders the page for the matching role", () => {
    signedInAs("DOCTOR");
    render(
      <AppShell role="DOCTOR">
        <p>doctor content</p>
      </AppShell>,
    );

    expect(screen.getByText("doctor content")).toBeInTheDocument();
  });
});

describe("the inactivity warning", () => {
  it("stays out of the way until the session is nearly over", () => {
    signedInAs("PATIENT");
    render(
      <AppShell role="PATIENT">
        <p>content</p>
      </AppShell>,
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("announces itself when time is short", () => {
    // A courtesy, not a control — the server expires the session whether or not
    // this ever renders (R8). Its job is to stop a clinician losing a
    // half-written note without warning, so it has to be heard, not just seen.
    vi.spyOn(session, "useSession").mockReturnValue({
      user: user("DOCTOR"),
      loading: false,
      signOut: vi.fn(),
      showWarning: true,
      secondsRemaining: 20,
      stayAlive: vi.fn(),
    } as unknown as ReturnType<typeof session.useSession>);

    render(
      <AppShell role="DOCTOR">
        <p>content</p>
      </AppShell>,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-live", "assertive");
    expect(within(dialog).getByText(/20s/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /stay signed in/i })).toBeInTheDocument();
  });
});

describe("a doctor whose registration is not approved", () => {
  /**
   * Approval is the only thing that creates the `Doctor` row, so a doctor with
   * no `doctorId` has not been approved — and the session already carries
   * that. The shell can therefore refuse before it renders anything and
   * without asking the server, which is the difference between "sent to the
   * form" and "shown a dashboard that then says something went wrong".
   */
  function signedInAsUnapprovedDoctor() {
    vi.spyOn(session, "useSession").mockReturnValue({
      user: { ...user("DOCTOR"), doctorId: null },
      loading: false,
      signOut: vi.fn(),
      showWarning: false,
      secondsRemaining: null,
      stayAlive: vi.fn(),
    } as unknown as ReturnType<typeof session.useSession>);
  }

  it("is sent to the registration form", () => {
    replace.mockClear();
    signedInAsUnapprovedDoctor();

    render(
      <AppShell role="DOCTOR">
        <p>caseload</p>
      </AppShell>,
    );

    expect(replace).toHaveBeenCalledWith("/doctor/onboarding");
  });

  it("is shown no part of the portal on the way there", () => {
    // Not even for a frame: every request this page makes is about to be
    // refused, and an error panel about a state that is not an error is how
    // someone concludes the product is broken.
    replace.mockClear();
    signedInAsUnapprovedDoctor();

    render(
      <AppShell role="DOCTOR">
        <p>caseload</p>
      </AppShell>,
    );

    expect(screen.queryByText("caseload")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("still shows the portal to an approved doctor", () => {
    replace.mockClear();
    signedInAs("DOCTOR");

    render(
      <AppShell role="DOCTOR">
        <p>caseload</p>
      </AppShell>,
    );

    expect(screen.getByText("caseload")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalledWith("/doctor/onboarding");
  });
});
