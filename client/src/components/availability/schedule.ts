/**
 * The rules behind the weekly schedule editor, with no React in them.
 *
 * Every one of these mirrors something the server already decides in
 * `api/app/modules/appointments/schedule.py` — the slot grid a window produces
 * (`slots_for_day`), the four ways a single window can be malformed
 * (`AvailabilityWindow`'s validators), and the one way a *set* of windows can
 * be (`validate_windows`). They are here so the doctor is told before the
 * request, not after it; the server stays the authority either way, and the
 * screen renders its refusal verbatim when the two ever disagree.
 *
 * Times are wall-clock at the clinic, never the browser's zone. Nothing in
 * this file touches `Date` for that reason: "09:00" is a string the clinic
 * reads, and converting it through the viewer's offset would move a Karachi
 * morning list into somebody else's afternoon.
 */

import { SLOT_MINUTES, type AvailabilityWindow } from "@/lib/api";

/** `[English, Roman Urdu]`, the shape `tr()` is spread into. */
export type Bilingual = [en: string, ur: string];

/** ISO weekday numbering, matching the server: Monday is 1, Sunday is 7. */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 7] as const;

/** Monday to Friday — what "the working week" fills in. */
export const WEEKDAYS = [1, 2, 3, 4, 5] as const;

export const DAY_NAMES: Record<number, Bilingual> = {
  1: ["Monday", "Peer"],
  2: ["Tuesday", "Mangal"],
  3: ["Wednesday", "Budh"],
  4: ["Thursday", "Jumeraat"],
  5: ["Friday", "Juma"],
  6: ["Saturday", "Hafta"],
  7: ["Sunday", "Itwaar"],
};

export const DAY_SHORT: Record<number, Bilingual> = {
  1: ["Mon", "Peer"],
  2: ["Tue", "Mangal"],
  3: ["Wed", "Budh"],
  4: ["Thu", "Jumeraat"],
  5: ["Fri", "Juma"],
  6: ["Sat", "Hafta"],
  7: ["Sun", "Itwaar"],
};

/**
 * A window while it is being edited.
 *
 * The `id` exists only on the client: it is what lets a row animate out when
 * *that* row is removed rather than the last one, and what an overlap points
 * at when it names the two windows that clash. It is stripped before the save.
 */
export interface DraftWindow {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
}

/**
 * Row identity, from a counter rather than `crypto.randomUUID`.
 *
 * Ids are only ever minted in an event handler or from a fetched payload —
 * never during render — so a counter is stable across a re-render and
 * deterministic in a test, which a random id is not.
 */
let sequence = 0;

export function newId(): string {
  sequence += 1;
  return `w${sequence}`;
}

/** Test seam: makes ids predictable from a known starting point. */
export function resetIds(): void {
  sequence = 0;
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/** The server's own pattern, so the same strings are rejected in both places. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes past midnight, or `null` when the string is not a clock time. */
export function toMinutes(hhmm: string): number | null {
  if (!HHMM.test(hhmm)) return null;
  const [hours, minutes] = hhmm.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Minutes past midnight back to "HH:MM". */
export function formatMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  const hours = Math.floor(clamped / 60);
  return `${String(hours).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

export function isSlotLength(minutes: number): boolean {
  return (SLOT_MINUTES as readonly number[]).includes(minutes);
}

// ---------------------------------------------------------------------------
// What one window produces
// ---------------------------------------------------------------------------

/**
 * How many appointments this window creates — the number the doctor is
 * actually publishing, and the only thing on screen they cannot work out
 * themselves.
 *
 * A trailing partial slot is dropped, exactly as `slots_for_day` does: a
 * 09:00–17:20 window in 30-minute slots ends at 17:00, because a 20-minute
 * consultation is not the appointment that was published.
 */
export function slotCount(window: Pick<DraftWindow, "startTime" | "endTime" | "slotMinutes">): number {
  const start = toMinutes(window.startTime);
  const end = toMinutes(window.endTime);
  if (start === null || end === null || !isSlotLength(window.slotMinutes)) return 0;
  return Math.max(0, Math.floor((end - start) / window.slotMinutes));
}

/** Every slot this window opens, as "HH:MM" starts. Used for the preview. */
export function slotStarts(
  window: Pick<DraftWindow, "startTime" | "endTime" | "slotMinutes">,
): string[] {
  const start = toMinutes(window.startTime);
  if (start === null) return [];
  return Array.from({ length: slotCount(window) }, (_, index) =>
    formatMinutes(start + index * window.slotMinutes),
  );
}

/** The words around the numbers, so the summary can be read in either language. */
export interface SummaryWords {
  minutes: string;
  slot: string;
  slots: string;
  /** Shown in place of a count when the window is not yet valid. */
  invalid: string;
}

const ENGLISH: SummaryWords = { minutes: "min", slot: "slot", slots: "slots", invalid: "no slots" };

/** "09:00–17:00 · 30 min · 16 slots" — the whole point of the row. */
export function windowSummary(
  window: Pick<DraftWindow, "startTime" | "endTime" | "slotMinutes">,
  words: SummaryWords = ENGLISH,
): string {
  const count = slotCount(window);
  const produced = count === 0 ? words.invalid : `${count} ${count === 1 ? words.slot : words.slots}`;
  return `${window.startTime}–${window.endTime} · ${window.slotMinutes} ${words.minutes} · ${produced}`;
}

/** Every slot across the whole week — what the card's header count reports. */
export function totalSlots(windows: DraftWindow[]): number {
  return windows.reduce((sum, window) => sum + slotCount(window), 0);
}

export function windowsOn(windows: DraftWindow[], dayOfWeek: number): DraftWindow[] {
  return windows
    .filter((window) => window.dayOfWeek === dayOfWeek)
    .sort((a, b) => (toMinutes(a.startTime) ?? 0) - (toMinutes(b.startTime) ?? 0));
}

// ---------------------------------------------------------------------------
// What the server refuses
// ---------------------------------------------------------------------------

/**
 * The four refusals a single window can earn, in the order the server checks
 * them: an unparseable time (the `pattern` on the field), an unknown slot
 * length, an end that is not after the start, and a window too short to hold
 * even one slot.
 */
export function windowIssue(
  window: Pick<DraftWindow, "startTime" | "endTime" | "slotMinutes">,
): Bilingual | null {
  const start = toMinutes(window.startTime);
  const end = toMinutes(window.endTime);

  if (start === null || end === null) {
    return ["Enter both times as HH:MM, on the 24-hour clock.", "Dono auqat HH:MM (24-ghante) mein likhein."];
  }
  if (!isSlotLength(window.slotMinutes)) {
    const allowed = SLOT_MINUTES.join(", ");
    return [
      `Slot length must be one of: ${allowed} minutes.`,
      `Slot ki lambai in mein se honi chahiye: ${allowed} minute.`,
    ];
  }
  if (end <= start) {
    return ["The end time must be later than the start time.", "Khatam hone ka waqt shuru se baad hona chahiye."];
  }
  if (end - start < window.slotMinutes) {
    return [
      "This window is shorter than one slot, so it produces no appointments.",
      "Yeh window aik slot se bhi chhoti hai, is se koi appointment nahi banti.",
    ];
  }
  return null;
}

/** Two windows on one day that cover the same minute. */
export interface Overlap {
  dayOfWeek: number;
  /** The window that starts first, and the one that starts into it. */
  earlierId: string;
  laterId: string;
  message: Bilingual;
}

/**
 * Every clashing pair, named.
 *
 * The server sorts each day by start time and compares neighbours, which is
 * complete — if no neighbouring pair overlaps then ends are increasing and no
 * distant pair can either — but it stops at the first clash it finds. This
 * reports all of them, because a doctor fixing a schedule wants to see every
 * row that is wrong, not one at a time. The verdict is identical: this returns
 * something exactly when the server would have raised.
 *
 * Windows that are individually invalid are skipped; they already carry their
 * own message, and a backwards window has no meaningful span to compare.
 */
export function overlaps(windows: DraftWindow[]): Overlap[] {
  const found: Overlap[] = [];

  for (const day of DAY_ORDER) {
    const usable = windowsOn(windows, day).filter((window) => windowIssue(window) === null);

    for (let i = 0; i < usable.length; i += 1) {
      for (let j = i + 1; j < usable.length; j += 1) {
        const earlier = usable[i];
        const later = usable[j];
        // Half-open, like the server: a window ending at 13:00 does not clash
        // with one starting at 13:00.
        if ((toMinutes(later.startTime) ?? 0) >= (toMinutes(earlier.endTime) ?? 0)) continue;
        found.push({
          dayOfWeek: day,
          earlierId: earlier.id,
          laterId: later.id,
          message: [
            `${DAY_NAMES[day][0]} has overlapping windows (${earlier.startTime}–${earlier.endTime} and ${later.startTime}–${later.endTime}). Both would open the same appointment time twice.`,
            `${DAY_NAMES[day][1]} ki windows aik doosre par charh rahi hain (${earlier.startTime}–${earlier.endTime} aur ${later.startTime}–${later.endTime}). Aik hi waqt do baar khul jaye ga.`,
          ],
        });
      }
    }
  }

  return found;
}

/** Every window the editor would refuse to send, keyed by row. */
export function issuesById(windows: DraftWindow[]): Map<string, Bilingual> {
  const issues = new Map<string, Bilingual>();
  for (const window of windows) {
    const issue = windowIssue(window);
    if (issue) issues.set(window.id, issue);
  }
  for (const clash of overlaps(windows)) {
    if (!issues.has(clash.earlierId)) issues.set(clash.earlierId, clash.message);
    if (!issues.has(clash.laterId)) issues.set(clash.laterId, clash.message);
  }
  return issues;
}

/** Nothing here would be refused, so the save is worth attempting. */
export function isSendable(windows: DraftWindow[]): boolean {
  return windows.every((window) => windowIssue(window) === null) && overlaps(windows).length === 0;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** The latest a generated window will run to, leaving room for the next one. */
const LATEST_END = 23 * 60;

/**
 * A sensible next window for a day: the standard morning when the day is
 * empty, otherwise a fresh block starting an hour after the last one ends and
 * inheriting its slot length — the second block of a split day is almost
 * always the afternoon clinic.
 *
 * At the very end of the day there is no room left and the suggestion is
 * pushed back into the existing hours. That is deliberate: an overlap the
 * doctor can see and drag off is better than a button that does nothing.
 */
export function nextWindowFor(windows: DraftWindow[], dayOfWeek: number): DraftWindow {
  const existing = windowsOn(windows, dayOfWeek);
  const last = existing[existing.length - 1];

  if (!last) {
    return { id: newId(), dayOfWeek, startTime: "09:00", endTime: "17:00", slotMinutes: 30 };
  }

  const slotMinutes = isSlotLength(last.slotMinutes) ? last.slotMinutes : 30;
  let start = (toMinutes(last.endTime) ?? 9 * 60) + 60;
  let end = start + 4 * 60;
  if (end > LATEST_END) {
    end = LATEST_END;
    start = Math.min(start, end - slotMinutes);
  }

  return {
    id: newId(),
    dayOfWeek,
    startTime: formatMinutes(start),
    endTime: formatMinutes(end),
    slotMinutes,
  };
}

/** Monday to Friday, 09:00–17:00, in 30-minute slots. The offered start. */
export function standardWeek(): DraftWindow[] {
  return WEEKDAYS.map((dayOfWeek) => ({
    id: newId(),
    dayOfWeek,
    startTime: "09:00",
    endTime: "17:00",
    slotMinutes: 30,
  }));
}

/**
 * One day's hours, applied to others.
 *
 * A replacement, not a merge: "make Tuesday look like Monday" is what the
 * button says, and appending would quietly produce the overlaps this screen
 * exists to prevent. The source day is never a target, whatever is passed.
 */
export function copyDay(
  windows: DraftWindow[],
  fromDay: number,
  toDays: readonly number[],
): DraftWindow[] {
  const targets = new Set(toDays.filter((day) => day !== fromDay));
  if (targets.size === 0) return windows;

  const source = windowsOn(windows, fromDay);
  const kept = windows.filter((window) => !targets.has(window.dayOfWeek));
  const copies = [...targets].flatMap((day) =>
    source.map((window) => ({ ...window, id: newId(), dayOfWeek: day })),
  );

  return sortWindows([...kept, ...copies]);
}

export function sortWindows<T extends { dayOfWeek: number; startTime: string }>(windows: T[]): T[] {
  return [...windows].sort(
    (a, b) =>
      a.dayOfWeek - b.dayOfWeek || (toMinutes(a.startTime) ?? 0) - (toMinutes(b.startTime) ?? 0),
  );
}

// ---------------------------------------------------------------------------
// Crossing the wire
// ---------------------------------------------------------------------------

/** Stored availability, opened into editable rows. */
export function draftFrom(windows: readonly AvailabilityWindow[]): DraftWindow[] {
  return sortWindows(windows.map((window) => ({ ...window, id: newId() })));
}

/** Editable rows, stripped back to what `PATCH /doctors/me` accepts. */
export function toPayload(windows: DraftWindow[]): AvailabilityWindow[] {
  return sortWindows(windows).map(({ dayOfWeek, startTime, endTime, slotMinutes }) => ({
    dayOfWeek,
    startTime,
    endTime,
    slotMinutes,
  }));
}

/**
 * Whether two schedules are the same set of hours.
 *
 * Order-independent, because both sides are sorted first: dragging a window
 * from Monday to Tuesday and back is not a change, and telling the doctor it
 * is would make the unsaved-changes warning something they learn to ignore.
 */
export function sameSchedule(
  a: readonly AvailabilityWindow[],
  b: readonly AvailabilityWindow[],
): boolean {
  if (a.length !== b.length) return false;
  const key = (windows: readonly AvailabilityWindow[]) =>
    sortWindows([...windows])
      .map((w) => `${w.dayOfWeek}|${w.startTime}|${w.endTime}|${w.slotMinutes}`)
      .join(",");
  return key(a) === key(b);
}
