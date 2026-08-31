/**
 * The bounds every date and time input in this application wears.
 *
 * A bare `<input type="date">` accepts a year of any length — a browser will
 * happily take `11/11/111111` and hand back a date six thousand years out,
 * which then travels to the server as a perfectly valid ISO string. `min` and
 * `max` are the only thing that stops it; there is no "four digits" rule in
 * HTML, only a range.
 *
 * The window is deliberately generous rather than clever. A clinic filter may
 * legitimately look years back, and leave may legitimately be booked a year
 * ahead; the job here is to exclude the absurd, not to second-guess the person
 * typing.
 */

/** `YYYY-MM-DD`, in the browser's own timezone rather than UTC. */
function isoDay(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function shiftYears(years: number): Date {
  const date = new Date();
  date.setFullYear(date.getFullYear() + years);
  return date;
}

/** Bounds for a `type="date"` input: five years back, two years forward. */
export const DATE_BOUNDS = {
  min: isoDay(shiftYears(-5)),
  max: isoDay(shiftYears(2)),
} as const;

/**
 * Bounds for a `type="datetime-local"` input.
 *
 * Same window, with a time part — a datetime input ignores a `max` that has no
 * time on it in some browsers, so the seconds are spelled out.
 */
export const DATETIME_BOUNDS = {
  min: `${DATE_BOUNDS.min}T00:00`,
  max: `${DATE_BOUNDS.max}T23:59`,
} as const;
