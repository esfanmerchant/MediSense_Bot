/**
 * What the weekly schedule editor decides before it asks the server.
 *
 * Three of these answers are load-bearing in a way a screenshot cannot show:
 *
 *  - **The slot count** is the only number on the screen a doctor cannot work
 *    out by looking. "09:00–17:00, 30 min" is 16 appointments, not 17, because
 *    the server drops the trailing partial slot — and a doctor who published 16
 *    while believing 17 finds out from a patient.
 *  - **Overlap detection** has to agree with `validate_windows` exactly. Too
 *    strict and a legal schedule cannot be saved with no way to tell why; too
 *    loose and the save is refused after the fact by a message about a day the
 *    screen said was fine.
 *  - **The day copy** replaces rather than appends. Appending is the one edit
 *    that reliably manufactures the overlaps this screen exists to prevent.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  copyDay,
  draftFrom,
  isSendable,
  issuesById,
  nextWindowFor,
  overlaps,
  resetIds,
  sameSchedule,
  slotCount,
  slotStarts,
  standardWeek,
  toMinutes,
  toPayload,
  totalSlots,
  windowIssue,
  windowSummary,
  windowsOn,
  type DraftWindow,
} from "@/components/availability/schedule";

beforeEach(() => {
  resetIds();
});

function win(overrides: Partial<DraftWindow> = {}): DraftWindow {
  return {
    id: overrides.id ?? "w",
    dayOfWeek: 1,
    startTime: "09:00",
    endTime: "17:00",
    slotMinutes: 30,
    ...overrides,
  };
}

describe("reading a clock time", () => {
  it("reads a 24-hour time as minutes past midnight", () => {
    expect(toMinutes("00:00")).toBe(0);
    expect(toMinutes("09:30")).toBe(570);
    expect(toMinutes("23:59")).toBe(1439);
  });

  it("refuses anything the server's own pattern would refuse", () => {
    // The server field carries ^([01]\d|2[0-3]):[0-5]\d$. A string it rejects
    // must not be quietly accepted here and sent anyway.
    for (const bad of ["", "9:00", "24:00", "23:60", "09:0", "0900", "09:00:00", "nine"]) {
      expect(toMinutes(bad), bad).toBeNull();
    }
  });
});

describe("how many appointments a window creates", () => {
  it("counts the whole hours of a standard clinic", () => {
    expect(slotCount(win({ startTime: "09:00", endTime: "17:00", slotMinutes: 30 }))).toBe(16);
  });

  it("drops the trailing partial slot, exactly as the server does", () => {
    // 09:00–17:20 in 30-minute slots ends at 17:00: a 20-minute consultation is
    // not the appointment that was published.
    expect(slotCount(win({ startTime: "09:00", endTime: "17:20", slotMinutes: 30 }))).toBe(16);
    expect(slotCount(win({ startTime: "09:00", endTime: "09:59", slotMinutes: 60 }))).toBe(0);
  });

  it("counts each allowed slot length", () => {
    const hour = { startTime: "09:00", endTime: "10:00" };
    expect(slotCount(win({ ...hour, slotMinutes: 10 }))).toBe(6);
    expect(slotCount(win({ ...hour, slotMinutes: 15 }))).toBe(4);
    expect(slotCount(win({ ...hour, slotMinutes: 20 }))).toBe(3);
    expect(slotCount(win({ ...hour, slotMinutes: 45 }))).toBe(1);
    expect(slotCount(win({ ...hour, slotMinutes: 60 }))).toBe(1);
  });

  it("counts nothing for a window the server would not store", () => {
    expect(slotCount(win({ startTime: "17:00", endTime: "09:00" }))).toBe(0);
    expect(slotCount(win({ startTime: "09:00", endTime: "25:00" }))).toBe(0);
    expect(slotCount(win({ slotMinutes: 25 }))).toBe(0);
  });

  it("names the times those slots start at", () => {
    expect(slotStarts(win({ startTime: "09:00", endTime: "10:30", slotMinutes: 30 }))).toEqual([
      "09:00",
      "09:30",
      "10:00",
    ]);
    expect(slotStarts(win({ startTime: "17:00", endTime: "09:00" }))).toEqual([]);
  });

  it("adds the week up", () => {
    expect(totalSlots(standardWeek())).toBe(80);
  });
});

describe("the line under a window", () => {
  it("reads as start, end, slot length, and what that produces", () => {
    expect(windowSummary(win())).toBe("09:00–17:00 · 30 min · 16 slots");
  });

  it("says slot, singular, when the window holds exactly one", () => {
    expect(windowSummary(win({ startTime: "09:00", endTime: "10:00", slotMinutes: 60 }))).toBe(
      "09:00–10:00 · 60 min · 1 slot",
    );
  });

  it("says plainly that a broken window produces nothing", () => {
    expect(windowSummary(win({ startTime: "17:00", endTime: "09:00" }))).toContain("no slots");
  });

  it("can be read in the other language", () => {
    const words = { minutes: "min", slot: "slot", slots: "slots", invalid: "koi slot nahi" };
    expect(windowSummary(win({ startTime: "17:00", endTime: "09:00" }), words)).toContain(
      "koi slot nahi",
    );
  });
});

/**
 * One window at a time — the four validators on the server's
 * `AvailabilityWindow`. Each has to be caught here for the same input, or the
 * doctor is sent to a 400 for something the form could have said.
 */
describe("what makes a single window unsendable", () => {
  it("accepts a window the server would store", () => {
    expect(windowIssue(win())).toBeNull();
    expect(windowIssue(win({ startTime: "00:00", endTime: "23:59", slotMinutes: 10 }))).toBeNull();
  });

  it("objects to a time that is not a clock time", () => {
    expect(windowIssue(win({ startTime: "" }))?.[0]).toMatch(/HH:MM/);
    expect(windowIssue(win({ endTime: "24:00" }))?.[0]).toMatch(/HH:MM/);
  });

  it("objects to a slot length the scheduler does not offer", () => {
    // ALLOWED_SLOT_MINUTES is {10, 15, 20, 30, 45, 60}; 25 is not in it.
    expect(windowIssue(win({ slotMinutes: 25 }))?.[0]).toMatch(/10, 15, 20, 30, 45, 60/);
  });

  it("objects when the window does not run forwards", () => {
    expect(windowIssue(win({ startTime: "17:00", endTime: "09:00" }))?.[0]).toMatch(/later than/);
    expect(windowIssue(win({ startTime: "09:00", endTime: "09:00" }))?.[0]).toMatch(/later than/);
  });

  it("objects to a window too short to hold one slot", () => {
    const issue = windowIssue(win({ startTime: "09:00", endTime: "09:20", slotMinutes: 30 }));
    expect(issue?.[0]).toMatch(/shorter than one slot/);
    // Exactly one slot long is fine — that is one appointment, not none.
    expect(windowIssue(win({ startTime: "09:00", endTime: "09:30", slotMinutes: 30 }))).toBeNull();
  });

  it("reports the first problem the server would hit, in its order", () => {
    // Both the slot length and the direction are wrong; the server validates
    // the field before the model, so the slot length is what it names.
    const issue = windowIssue(win({ startTime: "17:00", endTime: "09:00", slotMinutes: 25 }));
    expect(issue?.[0]).toMatch(/Slot length/);
  });
});

/**
 * Two windows at a time — `validate_windows`. Overlapping windows generate the
 * same slot twice, and the two patients who booked "09:00" from different
 * windows collide on one appointment with nothing to say which was wrong.
 */
describe("windows that clash", () => {
  it("says nothing about a day whose windows do not touch", () => {
    expect(
      overlaps([
        win({ id: "a", startTime: "09:00", endTime: "13:00" }),
        win({ id: "b", startTime: "14:00", endTime: "17:00" }),
      ]),
    ).toEqual([]);
  });

  it("treats back-to-back windows as legal, not overlapping", () => {
    // Half-open, like the server: a window ending at 13:00 does not cover 13:00.
    expect(
      overlaps([
        win({ id: "a", startTime: "09:00", endTime: "13:00" }),
        win({ id: "b", startTime: "13:00", endTime: "17:00" }),
      ]),
    ).toEqual([]);
  });

  it("names both windows, and the day", () => {
    const [clash] = overlaps([
      win({ id: "a", startTime: "09:00", endTime: "13:00" }),
      win({ id: "b", startTime: "12:00", endTime: "17:00" }),
    ]);
    expect(clash.dayOfWeek).toBe(1);
    expect(clash.earlierId).toBe("a");
    expect(clash.laterId).toBe("b");
    expect(clash.message[0]).toContain("Monday");
    expect(clash.message[0]).toContain("09:00–13:00");
    expect(clash.message[0]).toContain("12:00–17:00");
  });

  it("catches a window swallowed whole by another", () => {
    expect(
      overlaps([
        win({ id: "a", startTime: "09:00", endTime: "17:00" }),
        win({ id: "b", startTime: "10:00", endTime: "11:00" }),
      ]),
    ).toHaveLength(1);
  });

  it("catches the same window entered twice", () => {
    expect(overlaps([win({ id: "a" }), win({ id: "b" })])).toHaveLength(1);
  });

  it("reports every clashing pair, not just the first the server would hit", () => {
    // The server raises on the first neighbouring pair and stops. A doctor
    // fixing a schedule wants to see all three rows that are wrong at once.
    const found = overlaps([
      win({ id: "a", startTime: "09:00", endTime: "12:00" }),
      win({ id: "b", startTime: "10:00", endTime: "13:00" }),
      win({ id: "c", startTime: "11:00", endTime: "14:00" }),
    ]);
    expect(found).toHaveLength(3);
  });

  it("keeps days apart — the same hours on Monday and Tuesday are fine", () => {
    expect(overlaps([win({ id: "a", dayOfWeek: 1 }), win({ id: "b", dayOfWeek: 2 })])).toEqual([]);
  });

  it("ignores a window that is already broken on its own", () => {
    // A backwards window has no span to compare, and it already carries a
    // message of its own; two complaints about one row is noise.
    expect(
      overlaps([
        win({ id: "a", startTime: "09:00", endTime: "17:00" }),
        win({ id: "b", startTime: "17:00", endTime: "09:00" }),
      ]),
    ).toEqual([]);
  });

  it("agrees with the server on whether a schedule is sendable", () => {
    expect(isSendable(standardWeek())).toBe(true);
    expect(isSendable([win({ id: "a" }), win({ id: "b" })])).toBe(false);
    expect(isSendable([win({ slotMinutes: 25 })])).toBe(false);
  });

  it("marks both rows of a clash so neither looks innocent", () => {
    const issues = issuesById([
      win({ id: "a", startTime: "09:00", endTime: "13:00" }),
      win({ id: "b", startTime: "12:00", endTime: "17:00" }),
      win({ id: "c", dayOfWeek: 3, startTime: "09:00", endTime: "10:00" }),
    ]);
    expect(issues.has("a")).toBe(true);
    expect(issues.has("b")).toBe(true);
    expect(issues.has("c")).toBe(false);
  });

  it("prefers a window's own problem over the clash it is part of", () => {
    const issues = issuesById([win({ id: "a", slotMinutes: 25 })]);
    expect(issues.get("a")?.[0]).toMatch(/Slot length/);
  });
});

describe("copying one day onto others", () => {
  it("makes the target days look exactly like the source", () => {
    const monday = [
      win({ id: "a", dayOfWeek: 1, startTime: "09:00", endTime: "13:00" }),
      win({ id: "b", dayOfWeek: 1, startTime: "14:00", endTime: "17:00" }),
    ];
    const copied = copyDay(monday, 1, [2, 3]);

    for (const day of [1, 2, 3]) {
      expect(
        windowsOn(copied, day).map((w) => [w.startTime, w.endTime, w.slotMinutes]),
        `day ${day}`,
      ).toEqual([
        ["09:00", "13:00", 30],
        ["14:00", "17:00", 30],
      ]);
    }
  });

  it("replaces what the target day had rather than adding to it", () => {
    // Appending is the one edit that reliably manufactures an overlap.
    const week = [
      win({ id: "a", dayOfWeek: 1, startTime: "09:00", endTime: "13:00" }),
      win({ id: "b", dayOfWeek: 2, startTime: "10:00", endTime: "18:00" }),
    ];
    const copied = copyDay(week, 1, [2]);
    expect(windowsOn(copied, 2)).toHaveLength(1);
    expect(overlaps(copied)).toEqual([]);
  });

  it("gives every copy an id of its own, so removing one removes one", () => {
    const copied = copyDay([win({ id: "a", dayOfWeek: 1 })], 1, [2, 3, 4]);
    expect(new Set(copied.map((w) => w.id)).size).toBe(copied.length);
  });

  it("never copies a day onto itself, even when asked to", () => {
    const monday = [win({ id: "a", dayOfWeek: 1 })];
    expect(copyDay(monday, 1, [1])).toEqual(monday);
    expect(windowsOn(copyDay(monday, 1, [1, 2]), 1)).toHaveLength(1);
  });

  it("clears a target day when the source has no hours", () => {
    // "Make Sunday look like Monday" when Monday is empty means an empty
    // Sunday. Leaving the old hours would be the opposite of what was asked.
    const week = [win({ id: "b", dayOfWeek: 2, startTime: "10:00", endTime: "18:00" })];
    expect(copyDay(week, 1, [2])).toEqual([]);
  });

  it("leaves days nobody named alone", () => {
    const week = [
      win({ id: "a", dayOfWeek: 1, startTime: "09:00", endTime: "13:00" }),
      win({ id: "z", dayOfWeek: 7, startTime: "11:00", endTime: "12:00" }),
    ];
    const copied = copyDay(week, 1, [2]);
    expect(windowsOn(copied, 7).map((w) => w.id)).toEqual(["z"]);
  });
});

describe("the window the add button proposes", () => {
  it("opens an empty day on the standard morning", () => {
    const proposed = nextWindowFor([], 3);
    expect(proposed).toMatchObject({
      dayOfWeek: 3,
      startTime: "09:00",
      endTime: "17:00",
      slotMinutes: 30,
    });
  });

  it("puts a second window after the first, with an hour between", () => {
    const proposed = nextWindowFor(
      [win({ id: "a", dayOfWeek: 1, startTime: "09:00", endTime: "13:00", slotMinutes: 15 })],
      1,
    );
    expect(proposed.startTime).toBe("14:00");
    // Inherits the slot length: the afternoon clinic runs like the morning one.
    expect(proposed.slotMinutes).toBe(15);
    expect(overlaps([win({ id: "a", startTime: "09:00", endTime: "13:00" }), proposed])).toEqual(
      [],
    );
  });

  it("never proposes a window the server would reject outright", () => {
    // Even at the end of the day, when there is no room left, what comes back
    // is a window with a valid span — the clash it may cause is visible and
    // draggable, an invalid window is not.
    const late = win({ id: "a", dayOfWeek: 1, startTime: "08:00", endTime: "23:00" });
    expect(windowIssue(nextWindowFor([late], 1))).toBeNull();
  });
});

describe("the standard week the empty state offers", () => {
  it("is Monday to Friday, 09:00–17:00, in 30-minute slots", () => {
    const week = standardWeek();
    expect(week.map((w) => w.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
    expect(week.every((w) => w.startTime === "09:00" && w.endTime === "17:00")).toBe(true);
    expect(week.every((w) => w.slotMinutes === 30)).toBe(true);
  });

  it("is something the server will accept as it stands", () => {
    expect(isSendable(standardWeek())).toBe(true);
  });
});

describe("crossing the wire", () => {
  it("opens stored availability into rows with ids of their own", () => {
    const draft = draftFrom([
      { dayOfWeek: 3, startTime: "14:00", endTime: "17:00", slotMinutes: 20 },
      { dayOfWeek: 1, startTime: "09:00", endTime: "13:00", slotMinutes: 30 },
    ]);
    // Monday first, whatever order the server sent them in.
    expect(draft.map((w) => w.dayOfWeek)).toEqual([1, 3]);
    expect(new Set(draft.map((w) => w.id)).size).toBe(2);
  });

  it("sends back exactly the four fields the endpoint accepts", () => {
    const payload = toPayload([win({ id: "a" })]);
    expect(payload).toEqual([
      { dayOfWeek: 1, startTime: "09:00", endTime: "17:00", slotMinutes: 30 },
    ]);
    expect(Object.keys(payload[0])).not.toContain("id");
  });

  it("survives a round trip unchanged", () => {
    const stored = toPayload(standardWeek());
    expect(sameSchedule(toPayload(draftFrom(stored)), stored)).toBe(true);
  });
});

describe("whether there is anything to save", () => {
  it("does not call a reordering a change", () => {
    // Moving a window from Monday to Tuesday and back is not an edit. Saying
    // it is teaches the doctor to ignore the unsaved-changes warning.
    const a = toPayload([
      win({ id: "1", dayOfWeek: 2, startTime: "10:00", endTime: "12:00" }),
      win({ id: "2", dayOfWeek: 1, startTime: "09:00", endTime: "11:00" }),
    ]);
    const b = toPayload([
      win({ id: "3", dayOfWeek: 1, startTime: "09:00", endTime: "11:00" }),
      win({ id: "4", dayOfWeek: 2, startTime: "10:00", endTime: "12:00" }),
    ]);
    expect(sameSchedule(a, b)).toBe(true);
  });

  it("notices a changed time, a changed slot length, and a removed window", () => {
    const base = toPayload([win({ id: "1" })]);
    expect(sameSchedule(base, toPayload([win({ id: "1", endTime: "16:00" })]))).toBe(false);
    expect(sameSchedule(base, toPayload([win({ id: "1", slotMinutes: 15 })]))).toBe(false);
    expect(sameSchedule(base, [])).toBe(false);
  });

  it("notices an added window on a day that already had one", () => {
    const base = toPayload([win({ id: "1", startTime: "09:00", endTime: "13:00" })]);
    const grown = toPayload([
      win({ id: "1", startTime: "09:00", endTime: "13:00" }),
      win({ id: "2", startTime: "14:00", endTime: "17:00" }),
    ]);
    expect(sameSchedule(base, grown)).toBe(false);
  });

  it("calls an empty schedule the same as another empty schedule", () => {
    expect(sameSchedule([], [])).toBe(true);
  });
});
