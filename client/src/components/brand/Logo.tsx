"use client";

/**
 * The MediSense mark, drawn from the logo.
 *
 * A rounded medical cross carrying a white ECG pulse, with circuit traces and
 * node dots leaving to the right; the wordmark sets "Medi" in deep blue and
 * "Sense" in teal. Vector rather than the PNG so it stays crisp at every size,
 * recolours for a dark ground, and costs no request.
 *
 * If `public/brand/MediSense_logo.png` is ever added to the repo, this is the
 * one place that would change.
 */

import { useId } from "react";

import { cx } from "@/components/ui";

export type LogoVariant = "full" | "mark" | "white";

export function LogoMark({
  className,
  onDark = false,
}: {
  className?: string;
  /** On a coloured ground the cross is drawn in white instead of gradient. */
  onDark?: boolean;
}) {
  const id = `ms-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const fill = onDark ? "#FFFFFF" : `url(#${id})`;
  const pulse = onDark ? "#0B3FA8" : "#FFFFFF";

  return (
    <svg aria-hidden viewBox="0 0 64 48" className={cx("block", className)} fill="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0B3FA8" />
          <stop offset="0.55" stopColor="#1A8FC7" />
          <stop offset="1" stopColor="#14C4C1" />
        </linearGradient>
      </defs>

      {/* the cross */}
      <path
        d="M17 2h10a3 3 0 0 1 3 3v9h9a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-9v9a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3v-9H5a3 3 0 0 1-3-3V17a3 3 0 0 1 3-3h9V5a3 3 0 0 1 3-3Z"
        fill={fill}
      />
      {/* the pulse through it */}
      <path
        d="M5 25h9l3-8 4 16 3-8h4"
        stroke={pulse}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* circuit traces and their nodes */}
      <g stroke={fill} strokeWidth="1.8" strokeLinecap="round">
        <path d="M42 18h8" />
        <path d="M42 25h12" />
        <path d="M42 32h8" />
        <path d="M46 18v-6h6" />
        <path d="M46 32v6h6" />
      </g>
      <g fill={fill}>
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
      <span className={onDark ? "text-white" : "text-[#0B3FA8] dark:text-[#8FB6FF]"}>Medi</span>
      <span className={onDark ? "text-[#5EEAD4]" : "text-[#0FA9B9] dark:text-[#14C4C1]"}>Sense</span>
    </span>
  );
}

/**
 * `full` is mark + wordmark, `mark` is the cross alone, `white` is the full
 * lockup drawn for a coloured or photographic ground.
 */
export function Logo({
  variant = "full",
  size = "md",
  className,
}: {
  variant?: LogoVariant;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const marks = { sm: "h-7", md: "h-[34px]", lg: "h-12" } as const;
  const words = { sm: "text-base", md: "text-xl", lg: "text-3xl" } as const;
  const onDark = variant === "white";

  if (variant === "mark") {
    return <LogoMark className={cx(marks[size], "w-auto", className)} />;
  }
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <LogoMark className={cx(marks[size], "w-auto")} onDark={onDark} />
      <Wordmark className={words[size]} onDark={onDark} />
    </span>
  );
}
