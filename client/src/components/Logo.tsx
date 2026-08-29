/**
 * The MediSense mark, drawn from the logo: a rounded cross carrying an EKG
 * trace, with circuit nodes branching out of its right arm, all on the
 * blue→teal brand gradient. The wordmark sets "Medi" in blue and "Sense"
 * in teal, as the logo does.
 *
 * SVG rather than an image so it inherits size from its container, stays
 * crisp at any scale, and can be recoloured for a dark ground.
 */

"use client";

import { useId } from "react";

import { cx } from "@/components/ui";

export function LogoMark({
  className,
  onDark = false,
}: {
  className?: string;
  /** On a navy ground the cross keeps its gradient but the trace goes teal. */
  onDark?: boolean;
}) {
  // Each instance needs its own gradient id: two marks on one page sharing
  // an id means the second silently paints with the first's coordinates.
  // useId is stable across server and client, so hydration agrees.
  const id = `ms-grad-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      aria-hidden
      viewBox="0 0 64 48"
      className={cx("block", className)}
      fill="none"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1B4FE0" />
          <stop offset="1" stopColor="#14C7C0" />
        </linearGradient>
      </defs>
      {/* the cross */}
      <path
        d="M17 2h10a3 3 0 0 1 3 3v9h9a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-9v9a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3v-9H5a3 3 0 0 1-3-3V17a3 3 0 0 1 3-3h9V5a3 3 0 0 1 3-3Z"
        fill={`url(#${id})`}
      />
      {/* the EKG trace across it */}
      <path
        d="M5 25h9l3-8 4 16 3-8h4"
        stroke={onDark ? "#5EEAD4" : "#ffffff"}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* circuit nodes branching right */}
      <g stroke={`url(#${id})`} strokeWidth="1.8" strokeLinecap="round">
        <path d="M42 18h8" />
        <path d="M42 25h12" />
        <path d="M42 32h8" />
        <path d="M46 18v-6h6" />
        <path d="M46 32v6h6" />
      </g>
      <g fill={`url(#${id})`} stroke={onDark ? "#0A1128" : "#ffffff"} strokeWidth="1.2">
        <circle cx="52" cy="12" r="2.6" />
        <circle cx="56" cy="25" r="2.6" />
        <circle cx="52" cy="38" r="2.6" />
      </g>
    </svg>
  );
}

export function Wordmark({ className, onDark = false }: { className?: string; onDark?: boolean }) {
  return (
    <span className={cx("font-display font-bold tracking-tight", className)}>
      <span className={onDark ? "text-white" : "text-[#1B4FE0]"}>Medi</span>
      <span className={onDark ? "text-[#5EEAD4]" : "text-[#14C7C0]"}>Sense</span>
    </span>
  );
}

/** Mark and wordmark together, the way the logo is set. */
export function Logo({
  className,
  onDark = false,
  size = "md",
}: {
  className?: string;
  onDark?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const marks = { sm: "h-7", md: "h-9", lg: "h-12" } as const;
  const words = { sm: "text-base", md: "text-xl", lg: "text-3xl" } as const;
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <LogoMark className={cx(marks[size], "w-auto")} onDark={onDark} />
      <Wordmark className={words[size]} onDark={onDark} />
    </span>
  );
}
