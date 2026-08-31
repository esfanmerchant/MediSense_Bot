"use client";

/**
 * Drawings that explain a mechanism, in place of fake screenshots of one.
 *
 * The tiles these replace each held a small imitation interface — invoice rows
 * with made-up amounts, a column of invented hashes, a moving line. That is the
 * worst of both things a picture can be here: not the real product, and not an
 * illustration either. It reads as filling a box because that is what it was.
 *
 * Each of these says one sentence instead:
 *
 *   - a reading crosses a limit, and somebody is told;
 *   - a finished visit produces one invoice, however many times it is tried;
 *   - one link opens, on a clock, inside a chain that cannot be edited.
 *
 * **Drawn in the flat, calm register the rest of the brand uses.** No gradients
 * inside the artwork, no glow, no perpetual motion: this is a health system, and
 * a page that pulses at a worried person is arguing against itself. Everything
 * animates once on arrival and then holds — `.ms-demo` replays it on hover for
 * anyone who wants to see it again, and `prefers-reduced-motion` gets the
 * finished state with nothing ever scheduled.
 *
 * Colour comes from the theme's own tokens through `currentColor` and the text
 * utilities, so both themes are handled by the same paths.
 */

import { cx } from "@/components/ui";

/** Shared frame: a fixed viewBox, so every tile's drawing sits on one grid. */
function Plate({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <svg
      viewBox="0 0 200 96"
      role="img"
      aria-label={label}
      className={cx("h-full w-full", className)}
      fill="none"
    >
      {children}
    </svg>
  );
}

/**
 * A reading goes past its limit, and the crossing is what gets noticed.
 *
 * The dashed rule is the threshold, the trace is the reading, and the ring sits
 * exactly where one meets the other. The arc leaving the ring is the only thing
 * on the page that says *and then a person is told* — which is the tile's whole
 * claim, and was previously left to the caption.
 */
export function VitalsPlate({ label }: { label: string }) {
  return (
    <Plate label={label}>
      {/* The limit. Dashed, because it is a rule rather than a measurement. */}
      <line
        x1="12"
        y1="38"
        x2="188"
        y2="38"
        className="text-critical"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="5 5"
        opacity="0.55"
      />

      {/* The reading. Drawn left to right once, so it reads as arriving. */}
      <path
        className="ms-plate-draw text-primary"
        d="M12 62 H44 l8 -6 8 12 8 -22 9 44 9 -52 10 24 h12 l7 -10 8 12 h55"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Where it crossed. */}
      <circle
        cx="94"
        cy="30"
        r="6.5"
        className="ms-plate-pop text-critical"
        fill="currentColor"
        opacity="0.16"
      />
      <circle
        cx="94"
        cy="30"
        r="3.2"
        className="ms-plate-pop text-critical"
        fill="currentColor"
      />

      {/* And then somebody is told. */}
      <path
        className="ms-plate-arc text-critical"
        d="M99 27 Q126 10 150 20"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="3 4"
      />
      <g className="ms-plate-arc text-critical">
        <circle cx="158" cy="22" r="9" fill="currentColor" opacity="0.14" />
        {/* A bell: the notification, not a person — nobody is named here. */}
        <path
          d="M158 17.5c-2.5 0-4.2 1.9-4.2 4.3 0 2.8-.9 3.6-1.4 4h11.2c-.5-.4-1.4-1.2-1.4-4 0-2.4-1.7-4.3-4.2-4.3Z"
          fill="currentColor"
        />
        <path d="M156.4 27.4a1.7 1.7 0 0 0 3.2 0" stroke="currentColor" strokeWidth="1.2" />
      </g>
    </Plate>
  );
}

/**
 * A finished visit, and the one invoice it raises.
 *
 * The two pale sheets behind the solid one are the retries. They are drawn and
 * then fade, which is the visual form of the claim the caption makes: the
 * system may try more than once, and there is still exactly one bill.
 */
export function BillingPlate({ label, currency }: { label: string; currency: string }) {
  return (
    <Plate label={label}>
      {/* The visit. */}
      <circle cx="34" cy="48" r="17" className="text-primary" fill="currentColor" opacity="0.12" />
      <path
        d="M28 48.5l4.5 4.5 9.5-10"
        className="ms-plate-draw text-primary"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <path
        d="M58 48 h26"
        className="ms-plate-arc text-muted"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="3 4"
      />
      <path
        d="M80 44 l5 4 -5 4"
        className="ms-plate-arc text-muted"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* The retries, which do not survive. */}
      <g className="ms-plate-fade text-muted">
        <rect x="118" y="24" width="42" height="52" rx="5" stroke="currentColor" strokeWidth="1.4" opacity="0.35" />
        <rect x="112" y="27" width="42" height="52" rx="5" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      </g>

      {/* The invoice. */}
      <rect
        x="104"
        y="22"
        width="46"
        height="56"
        rx="6"
        className="text-primary"
        fill="currentColor"
        opacity="0.1"
      />
      <rect
        x="104"
        y="22"
        width="46"
        height="56"
        rx="6"
        className="text-primary"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <g className="text-primary" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M113 38 h22" opacity="0.6" />
        <path d="M113 47 h28" opacity="0.6" />
        <path d="M113 56 h16" opacity="0.6" />
      </g>
      <text
        x="127"
        y="72"
        textAnchor="middle"
        className="fill-current font-mono text-[9px] font-bold text-primary"
      >
        {currency}
      </text>

      {/* Exactly one. */}
      <g className="ms-plate-pop">
        <circle cx="156" cy="26" r="11" className="text-accent" fill="currentColor" />
        <text
          x="156"
          y="30"
          textAnchor="middle"
          className="fill-white font-mono text-[11px] font-bold"
        >
          1
        </text>
      </g>
    </Plate>
  );
}

/**
 * One link opened, on a clock, in a chain nobody can edit.
 *
 * A chain is the right picture for a hash chain because it carries the property
 * that matters without a word of explanation: pull any link out and the rest
 * stop meeting. The open one is coloured and ringed by a dial; the others are
 * quiet, which is what "one chart, not the ward" looks like.
 */
export function AuditPlate({ label }: { label: string }) {
  const links = [30, 66, 102, 138, 174];

  return (
    <Plate label={label}>
      {/* The chain itself. */}
      <line
        x1="30"
        y1="48"
        x2="174"
        y2="48"
        className="text-line-strong"
        stroke="currentColor"
        strokeWidth="2"
      />

      {links.map((x, index) => {
        const opened = index === 2;
        return (
          <g key={x} className={opened ? "ms-plate-pop" : undefined}>
            <circle
              cx={x}
              cy="48"
              r={opened ? 14 : 10}
              className={opened ? "text-critical" : "text-line-strong"}
              fill="var(--color-card, #fff)"
              stroke="currentColor"
              strokeWidth={opened ? 2.4 : 1.8}
            />
            {opened && (
              <>
                {/* The dial: it expires, and the picture says so. */}
                <path
                  className="ms-plate-draw text-critical"
                  d="M118 34 a14 14 0 0 1 0 28"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
                <path
                  d={`M${x} 42 v6 l4 3`}
                  className="text-critical"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </>
            )}
          </g>
        );
      })}
    </Plate>
  );
}
