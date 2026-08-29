"use client";

/**
 * The heading every portal page opens with.
 *
 * One component rather than seventeen hand-rolled `<h1>` blocks, so the
 * hierarchy is a decision made once: an uppercase eyebrow that names the
 * section, a display-face title, a subtitle held to a readable measure, and an
 * actions slot that stays on the title line where the eye expects it.
 */

import type { ReactNode } from "react";

import { useReveal } from "@/lib/useReveal";

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  const ref = useReveal<HTMLElement>();

  return (
    <header ref={ref} className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-2xl">
        {eyebrow && (
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-accent">{eyebrow}</p>
        )}
        <h1 className="mt-1.5 font-display text-[1.9rem] font-bold leading-tight text-strong">
          {title}
        </h1>
        {subtitle && <p className="mt-2 text-[15px] leading-relaxed text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </header>
  );
}
