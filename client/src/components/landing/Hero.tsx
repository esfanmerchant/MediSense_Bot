"use client";

/**
 * The hero.
 *
 * It sits on the light canvas, because the promise of the product is *relief*,
 * and a worried person reads calm faster from daylight than from a lit control
 * room. What daylight does not give away for free is depth — so the ground is
 * built rather than assumed: the design system's mesh, three slow ramp washes
 * drifting behind it, a film of grain so the white reads as paper instead of
 * as an unpainted div, and in the right-hand frame a WebGL lattice of the
 * logo's own circuit nodes.
 *
 * **The sentence rotates.** "Aap ki sehat," is fixed; the half that completes
 * it cycles through four endings, each of which is a thing the product
 * actually does — one record, your own words, two in the morning — and none of
 * which promises an outcome. The endings live in a stacked grid, so the block
 * is as tall as the longest of them from the first paint and the page never
 * reflows mid-phrase. The transition is a masked flip, not a crossfade: the
 * old ending leaves through the top of its mask while the new one arrives from
 * under the bottom, which is a mechanism a reader can see.
 *
 * **The alignment rule for the canvas.** The 3D field is given exactly the box
 * the flat SVG decoration already occupied — the right 52%, radially masked so
 * it is gone long before the headline column — and it is only mounted above
 * `lg`, only when WebGL actually exists, and only as a *lean* toward the
 * cursor rather than a pan, so the composition it was placed into is the
 * composition it stays in. Below `lg` it never loads at all.
 *
 * The deliberate risk stays: the monitor shows the assistant *refusing to
 * reassure* someone with chest pain. Leading with the most cautious moment
 * this product has is not the obvious sales choice — it is the single most
 * convincing thing the system does.
 */

import { useReducedMotion } from "framer-motion";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { CircuitNodes } from "@/components/brand/CircuitNodes";
import { EcgLine } from "@/components/brand/EcgLine";
import { RecordAssembly } from "@/components/landing/RecordAssembly";
import { GradientText } from "@/components/brand/GradientText";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

import { Aurora, Grain, MaskedRun, Parallax, Shell, useMinWidth, useMounted } from "./parts";

/**
 * ~150KB of WebGL that never reaches a portal route, and never reaches a
 * phone: the component is only rendered above `lg`, so below that the import
 * is never even requested.
 */
const HeroScene = dynamic(() => import("@/components/HeroScene").then((m) => m.HeroScene), {
  ssr: false,
});

/* ------------------------------------------------------------------ */
/* Headline                                                            */
/* ------------------------------------------------------------------ */

/**
 * The fixed first line, its words rising out of a mask on load.
 *
 * CSS rather than JS because this fires on mount, not on scroll: a keyframe
 * with a delay needs no observer, no state and no hydration to be correct.
 */
function Line({ text, start, className }: { text: string; start: number; className?: string }) {
  const words = text.split(" ");
  return (
    <span className={cx("ms-line", className)}>
      {words.map((word, index) => (
        // The space lives between the spans, not inside one: trailing white
        // space at the end of an inline-block is dropped, and the headline
        // would set itself as one long word.
        <Fragment key={`${word}-${index}`}>
          {index > 0 && " "}
          <span className="ms-word" style={{ animationDelay: `${(start + index) * 60 + 120}ms` }}>
            {word}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The half of the sentence that changes.
 *
 * Every ending is stacked in one grid cell, so the tallest reserves the height
 * for all of them and a longer phrase cannot push the buttons down the page.
 * Only the arriving and the leaving phrase are `visible`; the rest hold the
 * cell open with `visibility: hidden`, which costs no paint and no reflow.
 *
 * It stops when nobody is watching — a hidden tab, or an owner who asked for
 * reduced motion, who simply gets the first ending, still.
 */
function RotatingLine({ phrases, holdMs = 2900 }: { phrases: string[]; holdMs?: number }) {
  const reduced = useReducedMotion();
  const mounted = useMounted();
  const live = mounted && reduced === false && phrases.length > 1;

  const [active, setActive] = useState(0);
  const [previous, setPrevious] = useState(-1);
  const index = useRef(0);

  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const from = index.current;
        const to = (from + 1) % phrases.length;
        index.current = to;
        setPrevious(from);
        setActive(to);
        schedule();
      }, holdMs);
    };

    const onVisibility = () => {
      if (document.hidden) clearTimeout(timer);
      else schedule();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [live, holdMs, phrases.length]);

  return (
    <span className={cx("grid", live && "ms-rot-live")}>
      {phrases.map((phrase, position) => (
        <span
          key={phrase}
          aria-hidden={position !== active}
          className={cx(
            "ms-rot",
            position === active && "is-in",
            position === previous && position !== active && "is-out",
          )}
          style={{
            gridArea: "1 / 1",
            visibility: position === active || position === previous ? "visible" : "hidden",
          }}
        >
          {/* The mask and the moving span are outside the gradient, never
              inside it: an animating element within a `background-clip: text`
              span is composited out of the clip and paints nothing at all. */}
          <MaskedRun delay={0}>
            <GradientText>{phrase}</GradientText>
          </MaskedRun>
        </span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* The monitor                                                         */
/* ------------------------------------------------------------------ */

/**
 * A trace that scrolls the way a bedside monitor's does.
 *
 * The same path twice, the second offset by exactly one viewBox width, sliding
 * left forever — so it never restarts and never seams. The ramp is mirrored
 * (blue → teal → blue) across the tile for the same reason: at the join, the
 * colour has to meet itself.
 */
export function Hero({ primaryHref, primaryLabel }: { primaryHref: string; primaryLabel: string }) {
  const tr = useTr();

  // The canvas is a desktop-only luxury. Below `lg` the dynamic import is
  // never requested, so a phone pays nothing — not a byte, not a context.
  const wide = useMinWidth(1024);
  const [webgl, setWebgl] = useState(false);
  const onSceneReady = useCallback((ok: boolean) => setWebgl(ok), []);

  const fixed = tr("Your health,", "Aap ki sehat,");
  // Four endings, every one of them a thing the product actually does, none of
  // them a promise about an outcome. Kept to a similar length on purpose: the
  // block reserves the height of the longest, and a phrase that wraps when its
  // neighbours do not leaves a hole under the headline for the other three.
  const endings = [
    tr("all in one place.", "ek hi jagah par."),
    tr("in one record.", "ek hi record mein."),
    tr("in your own words.", "aap ke alfaz mein."),
    tr("answered at 2am.", "raat do baje bhi."),
  ];

  const trust = [
    tr("No card needed", "Card ki zaroorat nahi"),
    tr("No phone calls", "Phone calls nahi"),
    tr("Your data stays yours", "Aap ka data aap ka hi rehta hai"),
  ];

  return (
    <section className="mesh-light relative overflow-hidden bg-canvas">
      {/* Ground, in three layers: the washes drift on their own and lag the
          scroll, the grain stops the white reading as an unpainted div. */}
      <Parallax speed={70} className="pointer-events-none absolute inset-0">
        <Aurora />
      </Parallax>
      <Grain />

      {/* The right-hand frame. Whatever fills it, it stops well short of the
          sentence: decoration behind reading matter is a readability tax. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 hidden w-[52%] lg:block"
        style={{
          maskImage:
            "radial-gradient(118% 100% at 106% 50%, #000 16%, rgb(0 0 0 / 0.55) 52%, transparent 84%)",
          WebkitMaskImage:
            "radial-gradient(118% 100% at 106% 50%, #000 16%, rgb(0 0 0 / 0.55) 52%, transparent 84%)",
        }}
      >
        {/* The flat field holds the frame until — and unless — WebGL arrives. */}
        <div
          className={cx(
            "absolute inset-0 transition-opacity duration-700",
            webgl && "opacity-0",
          )}
        >
          <CircuitNodes density="low" />
        </div>
        {wide && <HeroScene onReady={onSceneReady} />}
      </div>

      <Shell className="relative grid gap-14 pb-20 pt-[116px] lg:grid-cols-[1.02fr_0.98fr] lg:items-center lg:gap-16 lg:pb-28 lg:pt-[150px]">
        <div className="max-w-[36rem]">
          <p className="pop-in mono-caps inline-flex items-center gap-2 rounded-full border border-line bg-card px-3.5 py-1.5 text-[0.65rem] text-accent shadow-sm">
            <span aria-hidden className="bg-gradient-brand animate-breathe h-1.5 w-1.5 rounded-full" />
            {tr("Smart Healthcare Management", "Smart Healthcare Management")}
          </p>

          <h1 className="mt-7 font-display text-[2.35rem] font-bold leading-[1.06] tracking-tight sm:text-[3rem] xl:text-[3.5rem]">
            <Line text={fixed} start={0} className="text-strong" />
            <RotatingLine phrases={endings} />
          </h1>

          {/* The pulse, as a rule rather than a background. */}
          <div className="mt-6 max-w-[26rem]">
            <EcgLine width={2} height={22} speed={2.6} />
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href={primaryHref}
              className="btn-gradient btn-shine pop-in group inline-flex min-h-[52px] items-center gap-2 rounded-xl px-7 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              style={{ animationDelay: "560ms" }}
            >
              {primaryLabel}
              <Icon
                name="arrow_forward"
                className="text-[20px] transition-transform duration-200 group-hover:translate-x-1"
              />
            </Link>
            <Link
              href="#kya-karta-hai"
              className="ms-ghost-cta pop-in inline-flex min-h-[52px] items-center gap-2 rounded-xl px-7 text-base font-semibold text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              style={{ animationDelay: "640ms" }}
            >
              {tr("Take a look", "Dekhein")}
            </Link>
          </div>

          {/* The three objections that stop a signup, in the order they occur
              to someone hovering over the button. */}
          <ul className="mt-10 flex flex-wrap gap-x-7 gap-y-3">
            {trust.map((label, index) => (
              <li
                key={label}
                className="pop-in flex items-center gap-2"
                style={{ animationDelay: `${720 + index * 80}ms` }}
              >
                <span
                  aria-hidden
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-white shadow-sm"
                >
                  <Icon name="check" className="text-[15px]" />
                </span>
                <span className="mono-caps text-[0.75rem] text-muted">{label}</span>
              </li>
            ))}
          </ul>
        </div>

        <RecordAssembly />
      </Shell>
    </section>
  );
}
