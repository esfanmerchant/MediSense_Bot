"use client";

/**
 * The pieces every landing section shares.
 *
 * Three of them, and each exists for a reason the page would otherwise pay
 * for twice:
 *
 * `LandingStyles` is the one place this page is allowed to add CSS. The design
 * system in `globals.css` owns the vocabulary; a marketing page still needs a
 * handful of keyframes nothing else in the product wants — a word rising out
 * of a mask, a chat line typing itself. They are declared once, through React
 * 19's stylesheet hoisting, so the rules land in `<head>` exactly once however
 * many sections render. Every value in them is a token: no colour is invented
 * here.
 *
 * `useInView` is the "start when it is seen" primitive. Its honest failure is
 * *finished*, never *hidden*: no IntersectionObserver, or reduced motion, and
 * the caller is told the element is in view immediately, so the count-ups show
 * their number and the drawn lines show their shape.
 *
 * `Reveal` and `SectionHead` are the rhythm — an eyebrow, a heading, a lede,
 * at one size on every section, so the page reads as one document.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { cx } from "@/components/ui";
import { useReveal } from "@/lib/useReveal";

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const LANDING_CSS = `
/* A word rising out of its line's mask. The transform is on the element that
   owns it — never on a child of a gradient-clipped span — so a headline set in
   the brand ramp animates without the clip losing its text. */
@keyframes ms-word-rise {
  from { transform: translateY(110%); }
  to { transform: translateY(0); }
}
.ms-line {
  display: block;
  overflow: hidden;
  padding-bottom: 0.12em;
  margin-bottom: -0.12em;
}
.ms-word {
  display: inline-block;
  animation: ms-word-rise 0.85s var(--ease-out-soft) backwards;
}

/* The quiet CTA: a plain hairline that becomes the brand ramp under the
   cursor, rather than wearing the gradient before it has been earned. */
.ms-ghost-cta {
  border: 1.5px solid var(--line-strong);
  background: var(--surface-card);
  transition:
    border-color 0.25s ease,
    background 0.25s ease,
    transform 0.2s var(--ease-out-soft),
    box-shadow 0.25s ease;
}
.ms-ghost-cta:hover {
  border-color: transparent;
  background:
    linear-gradient(var(--surface-card), var(--surface-card)) padding-box,
    var(--ms-gradient) border-box;
  transform: translateY(-1px);
  box-shadow: var(--shadow-card);
}

/* A line of chat typing itself out, for a tile's hover demo. */
@keyframes ms-type {
  from { width: 0; }
  to { width: 100%; }
}
.ms-type {
  display: block;
  width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.group:hover .ms-type,
.group:focus-within .ms-type {
  animation: ms-type 1.6s steps(34) 0.1s forwards;
}

/* A demo only runs while its tile is under the cursor: six looping animations
   at rest would be a fairground, not a product. Descendants are paused too,
   because animation-play-state does not inherit. */
.ms-demo,
.ms-demo * { animation-play-state: paused; }
.group:hover .ms-demo,
.group:hover .ms-demo *,
.group:focus-within .ms-demo,
.group:focus-within .ms-demo * { animation-play-state: running; }

/* A row of ledger lines sliding by, for the admin preview. */
@keyframes ms-slide-rows {
  from { transform: translateY(0); }
  to { transform: translateY(-33.333%); }
}
.ms-rows { animation: ms-slide-rows 6s linear infinite; }

/* A bar chart growing from its baseline. */
@keyframes ms-bar-grow {
  from { transform: scaleY(0.2); }
  to { transform: scaleY(1); }
}
.ms-bar { transform-origin: bottom; animation: ms-bar-grow 1.4s var(--ease-out-soft) infinite alternate; }

/* The sparkline's travelling highlight inside the hero's device card. */
@keyframes ms-spark {
  to { stroke-dashoffset: -220; }
}
.ms-spark {
  stroke-dasharray: 30 190;
  animation: ms-spark 2.6s linear infinite;
}
`;

/**
 * One `<style>` for the whole page.
 *
 * `precedence` is React 19's stylesheet hoisting: the rules move into `<head>`
 * and are de-duplicated by `href`, so rendering this from every section — or
 * none — is equally safe.
 */
export function LandingStyles() {
  return (
    <style href="medisense-landing" precedence="default">
      {LANDING_CSS}
    </style>
  );
}

/* ------------------------------------------------------------------ */
/* Seen-yet?                                                           */
/* ------------------------------------------------------------------ */

/**
 * True once the element has been scrolled into view — and true immediately
 * when we cannot or should not wait.
 *
 * The starting value is `false` on the server and in the first client render,
 * which is what lets a count-up start from zero. Anything that must never be
 * blank while `false` is the caller's job: every user of this hook renders its
 * finished state, not an empty one.
 */
export function useInView<T extends HTMLElement = HTMLDivElement>(
  threshold = 0.25,
  /** Positive values arm the caller *before* the element is on screen, which
      is what a count-up wants: the reset to zero must not be watchable. */
  rootMargin = "0px 0px -10% 0px",
) {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (
      !("IntersectionObserver" in window) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      // A frame later rather than synchronously: a setState in an effect body
      // is the cascading-render bug React 19 warns about, and this path is
      // "there is nothing to wait for", not "render again immediately".
      const frame = requestAnimationFrame(() => setSeen(true));
      return () => cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setSeen(true);
            observer.disconnect();
          }
        }
      },
      { threshold, rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold, rootMargin]);

  return [ref, seen] as const;
}

/* ------------------------------------------------------------------ */
/* Rhythm                                                              */
/* ------------------------------------------------------------------ */

export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useReveal<HTMLDivElement>(delay);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/** The small gradient-dotted label that opens a section. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mono-caps inline-flex items-center gap-2 text-[0.7rem] text-accent">
      <span aria-hidden className="bg-gradient-brand h-1.5 w-1.5 rounded-full" />
      {children}
    </p>
  );
}

export function SectionHead({
  eyebrow,
  title,
  lede,
  align = "left",
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: string;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <Reveal className={cx(align === "center" && "flex flex-col items-center text-center", className)}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-4 max-w-2xl font-display text-[2rem] font-bold leading-[1.12] text-strong sm:text-[2.6rem]">
        {title}
      </h2>
      {lede && (
        <p className="mt-4 max-w-[52ch] text-[17px] leading-relaxed text-muted">{lede}</p>
      )}
    </Reveal>
  );
}

/** The container every section shares, so the page has one column. */
export function Shell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-[1180px] px-5", className)}>{children}</div>;
}
