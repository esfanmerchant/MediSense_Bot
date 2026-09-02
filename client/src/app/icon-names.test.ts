/**
 * The generated icon list must match the icons the source actually uses.
 *
 * The font is subsetted to these names. An icon added to a page and left out
 * of this list has no glyph, and a Material Symbol with no glyph renders its
 * own name as text — the words "monitor_heart" inside a button, sized to
 * whatever the button sets. That has already broken this interface once, and
 * it is the kind of break that looks fine in review and only shows up in a
 * browser.
 *
 * So the extraction runs again here and the two are compared. Adding an icon
 * without regenerating fails this test, and the failure names the icon.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GENERATED, iconNames, render } from "../../scripts/icon-names.mjs";

import { ICON_NAMES } from "./icon-names.generated";

describe("the subsetted icon font", () => {
  it("lists exactly the icons the source uses", () => {
    const fromSource = iconNames();
    const missing = fromSource.filter((n: string) => !ICON_NAMES.includes(n as never));
    const extra = ICON_NAMES.filter((n) => !fromSource.includes(n));

    expect(
      { missing, extra },
      "run `npm run icons` — an icon here with no glyph renders as its own name",
    ).toEqual({ missing: [], extra: [] });
  });

  it("has a file on disk identical to what the generator would write", () => {
    // Catches a hand edit as well as a stale regeneration.
    expect(readFileSync(GENERATED, "utf8").replace(/\r\n/g, "\n")).toBe(
      render(iconNames()),
    );
  });

  it("includes the icons that are hardest to trace by eye", () => {
    // Each of these reaches <Icon> through a variable rather than a literal
    // prop, which is exactly the shape a simpler extractor would miss.
    for (const name of [
      "hourglass_top", // a filter table in admin/appointments
      "event_upcoming", // the same table
      "arrow_outward", // a nested ternary in doctor/earnings
      "undo", // the other arm of it
      "record_voice_over", // a section list in patient/records
      "notifications_active", // the push toggle
      "alarm_add", // the reminder control
      "notifications_off",
    ]) {
      expect(ICON_NAMES, `${name} is used but would have no glyph`).toContain(name);
    }
  });

  it("is big enough to be plausible and small enough to be a subset", () => {
    // A collapse to a handful means the extractor broke; the full set is 3000+.
    expect(ICON_NAMES.length).toBeGreaterThan(150);
    expect(ICON_NAMES.length).toBeLessThan(600);
  });
});
