"use client";

/**
 * The pulse from the logo, as a line that draws itself.
 *
 * One trace, one animation: `stroke-dashoffset` from the path's own length to
 * zero. `loop` keeps it running for a live indicator; without it the line draws
 * once, which is what a divider or an entrance wants.
 *
 * Under `prefers-reduced-motion` the line is simply there, complete and still —
 * the shape is the point, the drawing is the flourish.
 */

import { useId } from "react";

import { cx } from "@/components/ui";

const TRACE =
  "M0 20 H46 L52 20 L58 6 L66 34 L72 20 H108 L114 13 L119 20 H160 L166 20 L172 9 L179 31 L184 20 H240";

export function EcgLine({
  className,
  /** `gradient` uses the brand ramp; anything else is a CSS colour. */
  color = "gradient",
  /** Seconds for one pass. */
  speed = 2.4,
  loop = false,
  width = 2,
  /** Height of the drawn area in pixels; the trace scales to fit. */
  height = 40,
}: {
  className?: string;
  color?: "gradient" | string;
  speed?: number;
  loop?: boolean;
  width?: number;
  height?: number;
}) {
  const id = `ecg-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const stroke = color === "gradient" ? `url(#${id})` : color;

  return (
    <svg
      aria-hidden
      viewBox="0 0 240 40"
      preserveAspectRatio="none"
      style={{ height }}
      className={cx("w-full", className)}
      fill="none"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0B3FA8" />
          <stop offset="0.55" stopColor="#1A8FC7" />
          <stop offset="1" stopColor="#14C4C1" />
        </linearGradient>
      </defs>
      <path
        d={TRACE}
        stroke={stroke}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        className={loop ? "ecg-draw-loop" : "ecg-draw-once"}
        style={{ animationDuration: `${speed}s` }}
      />
    </svg>
  );
}

/**
 * A flat line that beats once — the illustration for an empty state.
 *
 * Deliberately calm: a flatline that never beats reads as bad news in a
 * hospital, and a constant animation next to "nothing here yet" is noise.
 */
export function EcgBeat({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 32"
      className={cx("h-8 w-28", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M0 16 H44 L50 16 L56 5 L63 27 L69 16 H120" className="ecg-beat" pathLength={1} />
    </svg>
  );
}
