"use client";

/**
 * The heading every portal page opens with.
 *
 * One component rather than seventeen hand-rolled `<h1>` blocks, so the
 * hierarchy is a decision made once: a mono-caps eyebrow that names the
 * section, a display-face title, a subtitle held to a readable measure, and an
 * actions slot that sits *on the title line* where the eye expects the verb to
 * be — not below the subtitle, where it reads as a footnote.
 *
 * The spacing is deliberately tight (6px eyebrow→title, 8px title→subtitle):
 * the three lines are one object, and a header that breathes as much as a card
 * pushes the page's actual content below the fold.
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
    <header ref={ref} className="w-full">
      {eyebrow && <p className="mono-caps text-[0.68rem] text-accent">{eyebrow}</p>}

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="min-w-0 font-display text-[1.75rem] font-bold leading-tight text-strong">
          {title}
        </h1>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>

      {subtitle && (
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">{subtitle}</p>
      )}
    </header>
  );
}
