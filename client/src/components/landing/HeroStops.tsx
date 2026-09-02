"use client";

/**
 * The hospital's six rooms, on a phone, told rather than shown.
 *
 * The desktop hero walks a camera through the building. A phone cannot have
 * that — so this walks the *words* through it instead: one room at a time,
 * advancing on its own, with six taps to steer. Same journey, same order, same
 * six claims; the medium is type instead of geometry.
 *
 * **It replaced a picture, deliberately.** The still that used to sit here was
 * a screenshot of the 3D scene, cropped from a desktop render. At 390px it is
 * a postage stamp of a building in which no room, screen or person is legible
 * — half a screen of scrolling that argues nothing. A line of type that says
 * "a reading out of range alerts the doctor" argues the whole thing.
 *
 * **Reduced motion gets all six at once, statically.** Not a stripped version:
 * somebody who has asked for less movement should get the argument in full,
 * immediately, rather than be made to wait through a rotation they did not ask
 * for. That path is also what a reader gets if JavaScript never arrives.
 *
 * **Any tap stops the rotation for good.** Once somebody has said which room
 * they want, moving it out from under them is the app disagreeing with them.
 */

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useTr } from "@/lib/lang";

export interface HeroStop {
  label: [string, string];
  chip: [string, string];
  lead: [string, string];
  accent: [string, string];
  short: [string, string];
  icon: string;
}

/** How long one room holds. Long enough to read the two lines, twice over. */
const DWELL_MS = 4200;

export function HeroStops({ stops }: { stops: HeroStop[] }) {
  const tr = useTr();
  const calm = useReducedMotion();
  const [index, setIndex] = useState(0);
  /** Set by the first tap, and never unset. */
  const [steered, setSteered] = useState(false);

  // A tab hidden behind another app should not be burning a timer, and coming
  // back to five rooms having silently gone past is worse than resuming.
  const paused = useRef(false);
  useEffect(() => {
    const watch = () => {
      paused.current = document.hidden;
    };
    document.addEventListener("visibilitychange", watch);
    return () => document.removeEventListener("visibilitychange", watch);
  }, []);

  useEffect(() => {
    if (calm || steered) return;
    const timer = window.setInterval(() => {
      if (!paused.current) setIndex((i) => (i + 1) % stops.length);
    }, DWELL_MS);
    return () => window.clearInterval(timer);
  }, [calm, steered, stops.length]);

  const choose = (next: number) => {
    setSteered(true);
    setIndex(next);
  };

  /* Everything at once, for a reader who has asked for less movement — and for
     one whose JavaScript never arrived, since this is what renders first. */
  if (calm) {
    return (
      <ul className="mt-8 divide-y divide-line overflow-hidden rounded-2xl border border-line">
        {stops.map((stop) => (
          <li key={stop.label[0]} className="flex items-start gap-3.5 p-4">
            <span
              aria-hidden
              className="bg-gradient-soft grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary"
            >
              <Icon name={stop.icon} className="text-[20px]" />
            </span>
            <div className="min-w-0">
              <p className="font-display text-[1.0625rem] font-bold leading-snug text-strong">
                {tr(...stop.lead)}{" "}
                <span className="text-gradient-brand">{tr(...stop.accent)}</span>
              </p>
              <p className="mt-1 text-[0.9375rem] leading-relaxed text-muted">
                {tr(...stop.short)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="mt-8">
      {/* All six live in one grid cell, stacked.
          ------------------------------------------------------------------
          The card was a fixed height sized to the longest copy — and at 360px
          that copy wraps to another line, so the longest room overflowed a card
          with `overflow-hidden` and lost its last line. A stack has no magic
          number to get wrong: the cell is as tall as the tallest room *at the
          width it is actually being read at*, and it never resizes as the rooms
          change, which is the fidget a height:auto card would have. */}
      <div className="relative grid overflow-hidden rounded-2xl border border-line bg-[color-mix(in_srgb,var(--surface-card)_70%,transparent)] p-5">
        {/* The one moving decoration: a sweep that crosses the card while its
            room holds, so the wait has a visible length. It is the progress
            rail from the desktop hero, laid on its side. */}
        <motion.span
          aria-hidden
          key={`sweep-${index}-${String(steered)}`}
          className="absolute inset-x-0 top-0 h-0.5 origin-left bg-gradient-to-r from-[#14C4C1] via-[#14C4C1]/70 to-transparent"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: steered ? 1 : [0, 1] }}
          transition={{ duration: steered ? 0.4 : DWELL_MS / 1000, ease: "linear" }}
        />

        {stops.map((item, i) => {
          const active = i === index;
          return (
            <motion.div
              key={item.label[0]}
              // Every room occupies the same cell, so the tallest sets the
              // height and the others are simply invisible in it.
              style={{ gridArea: "1 / 1" }}
              aria-hidden={!active}
              className={active ? undefined : "pointer-events-none"}
              initial={false}
              animate={{ opacity: active ? 1 : 0, y: active ? 0 : 12 }}
              transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden
                  className="bg-gradient-soft grid h-9 w-9 shrink-0 place-items-center rounded-xl text-primary"
                >
                  <Icon name={item.icon} className="text-[19px]" />
                </span>
                <p className="mono-caps text-[10.5px] tracking-[0.14em] text-[#AFC9E8]">
                  {tr(...item.label)}
                </p>
              </div>

              <p className="font-display mt-4 text-[1.6rem] font-black leading-[1.12] tracking-tight text-strong">
                {tr(...item.lead)}{" "}
                <span className="text-gradient-brand">{tr(...item.accent)}</span>
              </p>
              <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-muted">
                {tr(...item.short)}
              </p>
            </motion.div>
          );
        })}
      </div>

      {/* Real buttons, not dots: this is how somebody reaches room four without
          waiting twelve seconds for it. */}
      <div role="tablist" aria-label={tr("Rooms", "Kamre")} className="mt-2 flex gap-1.5">
        {stops.map((item, i) => (
          <button
            key={item.label[0]}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-label={tr(...item.label)}
            onClick={() => choose(i)}
            className="group grid min-h-11 flex-1 place-items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <span
              aria-hidden
              className={`h-1 w-full rounded-full transition-colors duration-300 ${
                i === index ? "bg-[#14C4C1]" : "bg-white/15 group-hover:bg-white/30"
              }`}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
