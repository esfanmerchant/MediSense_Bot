/**
 * The schedule editor, as a doctor meets it.
 *
 * `schedule.test.tsx` pins the rules; this pins that they reach the screen. The
 * failure it exists to catch is the original bug in a new form — a doctor who
 * is invisible to the booking screen and is not told, or who is told and has no
 * way to fix it from here.
 *
 * The API is stubbed at `@/lib/api`, so what is under test is what this screen
 * *sends* and *says*, never the endpoint.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// The session hook is read for the doctor's own id, which the timezone lookup
// needs. Neither Next's router nor a real session exists in jsdom.
vi.mock("next/navigation", () => ({
  usePathname: () => "/doctor/availability",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

import { WeeklySchedule } from "@/components/availability/WeeklySchedule";
import * as api from "@/lib/api";
import * as session from "@/lib/session";

function signedInAsDoctor() {
  vi.spyOn(session, "useSession").mockReturnValue({
    user: { id: "u1", name: "Dr Ayesha", email: "a@b.c", role: "DOCTOR", doctorId: "d1" },
    loading: false,
  } as unknown as ReturnType<typeof session.useSession>);
}

function doctorProfile(
  availability: api.AvailabilityWindow[] = [],
  acceptingPatients = true,
): api.DoctorProfile {
  return {
    id: "d1",
    name: "Dr Ayesha",
    avatarUrl: null,
    specialization: "Cardiology",
    qualifications: null,
    yearsExperience: 8,
    consultationFee: 2500,
    acceptingPatients,
    availability,
    department: null,
  };
}

/** Signs in, stubs the profile, and answers the timezone lookup. */
function mount(profile: api.DoctorProfile, timezone: string | null = "Asia/Karachi") {
  signedInAsDoctor();
  vi.spyOn(api.doctors, "me").mockResolvedValue(profile);
  if (timezone === null) {
    vi.spyOn(api.appointments, "availability").mockRejectedValue(
      new api.ApiError("NETWORK_ERROR", "unreachable", 0),
    );
  } else {
    vi.spyOn(api.appointments, "availability").mockResolvedValue({
      doctorId: "d1",
      timezone,
      days: [],
    });
  }
  const updateMe = vi
    .spyOn(api.doctors, "updateMe")
    .mockImplementation(async (input) =>
      doctorProfile(
        (input.availability ?? profile.availability) as api.AvailabilityWindow[],
        input.acceptingPatients ?? profile.acceptingPatients,
      ),
    );
  render(<WeeklySchedule />);
  return updateMe;
}

describe("a doctor who has never set their hours", () => {
  it("is told plainly that nobody can book them, and why", async () => {
    // The whole bug in one sentence. An approved doctor with empty availability
    // produced no slots, appeared on no calendar, and was told none of it.
    mount(doctorProfile());

    expect(await screen.findByText(/Patients cannot book you at the moment/)).toBeInTheDocument();
    expect(screen.getByText(/no appointment slots exist/)).toBeInTheDocument();
  });

  it("is offered a whole working week in one press", async () => {
    const updateMe = mount(doctorProfile());

    await userEvent.click(
      await screen.findByRole("button", { name: /Mon–Fri, 09:00–17:00, 30 min/ }),
    );

    // Five identical days, each saying what it produces.
    expect(screen.getAllByText("09:00–17:00 · 30 min · 16 slots")).toHaveLength(5);
    expect(screen.getByText("80 slots a week")).toBeInTheDocument();
    // Filled, not saved: patients still see nothing until Save is pressed.
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
    expect(updateMe).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Save schedule/ }));
    await waitFor(() => expect(updateMe).toHaveBeenCalledOnce());
    expect(updateMe.mock.calls[0][0].availability).toEqual([
      { dayOfWeek: 1, startTime: "09:00", endTime: "17:00", slotMinutes: 30 },
      { dayOfWeek: 2, startTime: "09:00", endTime: "17:00", slotMinutes: 30 },
      { dayOfWeek: 3, startTime: "09:00", endTime: "17:00", slotMinutes: 30 },
      { dayOfWeek: 4, startTime: "09:00", endTime: "17:00", slotMinutes: 30 },
      { dayOfWeek: 5, startTime: "09:00", endTime: "17:00", slotMinutes: 30 },
    ]);
  });

  it("offers every day of the week, Monday first, even the closed ones", async () => {
    mount(doctorProfile());

    const days = await screen.findAllByRole("heading", { level: 3 });
    expect(days.map((day) => day.textContent)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
  });
});

describe("the clinic's time zone", () => {
  it("comes from the API, never from a constant here", async () => {
    mount(doctorProfile(), "Asia/Dubai");
    expect(await screen.findByText("Asia/Dubai")).toBeInTheDocument();
  });

  it("degrades to naming the clinic rather than guessing a zone", async () => {
    mount(doctorProfile(), null);
    expect(await screen.findByText("Clinic time")).toBeInTheDocument();
    expect(screen.queryByText(/Asia\//)).toBeNull();
  });
});

describe("two windows that cover the same minute", () => {
  it("names both of them, and the day, before the save is attempted", async () => {
    // The server would refuse this with exactly this complaint. Being told
    // after the round trip is being told too late.
    const updateMe = mount(
      doctorProfile([
        { dayOfWeek: 1, startTime: "09:00", endTime: "13:00", slotMinutes: 30 },
        { dayOfWeek: 1, startTime: "14:00", endTime: "17:00", slotMinutes: 30 },
      ]),
    );

    const [morningEnd] = await screen.findAllByDisplayValue("13:00");
    await userEvent.clear(morningEnd);
    await userEvent.type(morningEnd, "15:00");

    expect(await screen.findByText(/1 overlap to fix/)).toBeInTheDocument();
    const named = screen.getAllByText(/Monday has overlapping windows/);
    expect(named.length).toBeGreaterThan(0);
    expect(named[0].textContent).toContain("09:00–15:00");
    expect(named[0].textContent).toContain("14:00–17:00");

    expect(screen.getByRole("button", { name: /Save schedule/ })).toBeDisabled();
    expect(updateMe).not.toHaveBeenCalled();
  });

  it("renders the server's own refusal when it disagrees anyway", async () => {
    const updateMe = mount(
      doctorProfile([{ dayOfWeek: 1, startTime: "09:00", endTime: "13:00", slotMinutes: 30 }]),
    );
    updateMe.mockRejectedValue(
      new api.ApiError("BAD_REQUEST", "Monday has overlapping windows (09:00-13:00 and 12:00-17:00)", 400),
    );

    const [end] = await screen.findAllByDisplayValue("13:00");
    await userEvent.clear(end);
    await userEvent.type(end, "12:00");
    await userEvent.click(screen.getByRole("button", { name: /Save schedule/ }));

    expect(
      await screen.findByText("Monday has overlapping windows (09:00-13:00 and 12:00-17:00)"),
    ).toBeInTheDocument();
  });
});

describe("copying one day onto others", () => {
  it("applies the source day's hours to every day chosen", async () => {
    mount(doctorProfile([{ dayOfWeek: 1, startTime: "10:00", endTime: "12:00", slotMinutes: 20 }]));

    await userEvent.click(
      await screen.findByRole("button", { name: /Copy Monday to other days/ }),
    );
    await userEvent.click(await screen.findByRole("button", { name: /Rest of the working week/ }));
    await userEvent.click(screen.getByRole("button", { name: /Copy to 4 days/ }));

    expect(await screen.findAllByText("10:00–12:00 · 20 min · 6 slots")).toHaveLength(5);
  });
});

describe("pausing new bookings", () => {
  it("is saved with the hours, not separately", async () => {
    const updateMe = mount(
      doctorProfile([{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00", slotMinutes: 30 }]),
    );

    await userEvent.click(
      await screen.findByRole("switch", { name: /Accepting new bookings/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Save schedule/ }));

    await waitFor(() => expect(updateMe).toHaveBeenCalledOnce());
    expect(updateMe.mock.calls[0][0].acceptingPatients).toBe(false);
    expect(updateMe.mock.calls[0][0].availability).toHaveLength(1);
  });

  it("is distinguished from having no hours at all", async () => {
    // Two different situations with the same symptom — nobody books you — and
    // a doctor who confuses them fixes the wrong one.
    mount(
      doctorProfile([{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00", slotMinutes: 30 }], false),
    );

    expect(await screen.findByText(/New bookings are paused/)).toBeInTheDocument();
    expect(screen.getByText(/This is not the same as having no hours/)).toBeInTheDocument();
    expect(screen.queryByText(/Patients cannot book you at the moment/)).toBeNull();
  });
});

describe("unsaved work", () => {
  it("says so, and says patients are still on the old hours", async () => {
    mount(doctorProfile([{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00", slotMinutes: 30 }]));

    expect(await screen.findByText("Everything here is saved.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save schedule/ })).toBeDisabled();

    await userEvent.click(screen.getAllByRole("button", { name: /Add hours/ })[0]);
    expect(screen.getByText(/patients still see your last saved hours/)).toBeInTheDocument();
  });

  it("can be thrown away, returning to what was saved", async () => {
    mount(doctorProfile([{ dayOfWeek: 1, startTime: "09:00", endTime: "17:00", slotMinutes: 30 }]));

    await userEvent.click(await screen.findByRole("button", { name: /Clear Monday/ }));
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Discard changes/ }));
    // `getAll`, not `get`: the row that was cleared is still animating out, so
    // for a moment the collapsed old node and the restored one both exist.
    expect(screen.getAllByText("09:00–17:00 · 30 min · 16 slots").length).toBeGreaterThan(0);
    expect(screen.getByText("Everything here is saved.")).toBeInTheDocument();
  });
});
