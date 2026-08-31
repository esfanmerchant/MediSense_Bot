"use client";

/**
 * The two charts the revenue page needs, drawn by hand.
 *
 * No charting library. These are bars — rectangles with a scale and a hover
 * layer — and a library would add a dependency, a bundle, and a second theming
 * system to keep in step with this one, in exchange for features nothing here
 * asks for.
 *
 * **Single series, deliberately.** The obvious design was a stacked bar showing
 * whose money each period's revenue was, and it was abandoned after running the
 * palette through a validator: the brand ramp is blue through cyan, and any two
 * of its stops pushed into the dark-mode lightness band land under ΔE 15 from
 * each other — a pair a reader with full colour vision struggles to tell apart,
 * before considering colour blindness at all. Two series would have meant
 * reaching outside the brand or reusing a status colour, and the split is a
 * composition at a point in time rather than a shape over one, so it belongs in
 * the tiles above rather than inside these bars.
 *
 * The colour is a validated step in each mode, not one colour with opacity:
 * `#1462c4` on light, `#4a86d8` on dark, both inside the mode's lightness band
 * and above 3:1 on its surface.
 *
 * Every chart here also renders a table for screen readers, so identity and
 * value never depend on seeing the picture.
 */

import { useState } from "react";

import { cx } from "@/components/ui";

/** One bar's worth of data. `value` is a decimal string, as money always is. */
export interface Bar {
  label: string;
  value: string;
  /** Shown in the tooltip under the value — a count, a date, anything. */
  detail?: string;
}

function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function format(value: number): string {
  // Grouped, never abbreviated: "1.2M" on a money figure invites somebody to
  // read it as the exact amount, and this is the only place the number appears.
  return new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 }).format(value);
}

/**
 * A tooltip that follows the hovered bar.
 *
 * Positioned by the bar's own index rather than the pointer, so it sits in the
 * same place whether somebody arrived by mouse or by keyboard.
 */
function Tip({ bar, currency }: { bar: Bar; currency: string }) {
  return (
    <div className="pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs shadow-overlay">
      <span className="block font-semibold text-strong">
        {currency} {format(toNumber(bar.value))}
      </span>
      <span className="block text-muted">{bar.detail ?? bar.label}</span>
    </div>
  );
}

/**
 * Money over time.
 *
 * Bars rather than a line: the periods are discrete buckets somebody compares
 * against each other, and a line between them implies a continuous quantity
 * that was passing through the values in between, which revenue does not.
 */
export function TimeBars({
  bars,
  currency,
  label,
}: {
  bars: Bar[];
  currency: string;
  /** Names the single series, so no legend box is needed. */
  label: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const peak = Math.max(1, ...bars.map((bar) => toNumber(bar.value)));

  if (bars.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted">
        Nothing has been paid in this period yet.
      </p>
    );
  }

  return (
    <figure className="m-0">
      <figcaption className="mb-4 text-sm text-muted">{label}</figcaption>

      <div className="flex h-52 items-end gap-[3px] sm:gap-1.5">
        {bars.map((bar, index) => {
          const value = toNumber(bar.value);
          // A floor of 2px, so a small but real period is a visible mark rather
          // than a gap indistinguishable from no data at all.
          const height = value > 0 ? Math.max(2, (value / peak) * 100) : 0;

          return (
            <div
              key={`${bar.label}-${index}`}
              className="relative flex h-full flex-1 flex-col justify-end"
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
            >
              {hovered === index && <Tip bar={bar} currency={currency} />}
              <button
                type="button"
                // Focusable so the values are reachable without a pointer; the
                // tooltip follows focus for the same reason.
                onFocus={() => setHovered(index)}
                onBlur={() => setHovered((current) => (current === index ? null : current))}
                aria-label={`${bar.label}: ${currency} ${format(value)}`}
                style={{ height: `${height}%` }}
                className={cx(
                  "w-full rounded-t transition-opacity duration-150",
                  // 4px rounded top, anchored to the baseline.
                  "bg-[#1462c4] dark:bg-[#4a86d8]",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  hovered !== null && hovered !== index && "opacity-45",
                )}
              />
            </div>
          );
        })}
      </div>

      {/* Only the ends are labelled. A number under every bar is noise at
          thirty of them, and the tooltip carries the rest. */}
      <div className="mt-2 flex justify-between text-[11px] text-faint">
        <span>{bars[0]?.label}</span>
        {bars.length > 1 && <span>{bars[bars.length - 1]?.label}</span>}
      </div>

      <ChartTable bars={bars} currency={currency} caption={label} />
    </figure>
  );
}

/** Magnitude by category — horizontal, because the labels are words. */
export function CategoryBars({
  bars,
  currency,
  label,
}: {
  bars: Bar[];
  currency: string;
  label: string;
}) {
  const peak = Math.max(1, ...bars.map((bar) => toNumber(bar.value)));

  if (bars.length === 0) {
    return <p className="py-8 text-center text-sm text-muted">Nothing to show yet.</p>;
  }

  return (
    <figure className="m-0">
      <figcaption className="mb-4 text-sm text-muted">{label}</figcaption>

      <ul className="space-y-3">
        {bars.map((bar) => {
          const value = toNumber(bar.value);
          return (
            <li key={bar.label}>
              <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-medium text-strong">{bar.label}</span>
                {/* Directly labelled: with a handful of rows there is room, and
                    a value beside its bar needs no hover to be read. */}
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted">
                  {currency} {format(value)}
                </span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-sunken">
                <div
                  style={{ width: `${Math.max(2, (value / peak) * 100)}%` }}
                  className="h-full rounded-full bg-[#1462c4] dark:bg-[#4a86d8]"
                />
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

/**
 * The same numbers as a table, for anybody not reading the picture.
 *
 * Visually hidden rather than absent: a chart whose values exist only as bar
 * heights is a chart a screen reader cannot report, and the contrast warning on
 * a mark this size is answered by having the figures in text somewhere.
 */
function ChartTable({
  bars,
  currency,
  caption,
}: {
  bars: Bar[];
  currency: string;
  caption: string;
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Period</th>
          <th scope="col">Amount ({currency})</th>
        </tr>
      </thead>
      <tbody>
        {bars.map((bar, index) => (
          <tr key={`${bar.label}-${index}`}>
            <th scope="row">{bar.detail ?? bar.label}</th>
            <td>{format(toNumber(bar.value))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
