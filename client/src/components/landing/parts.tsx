"use client";

/**
 * The pieces every landing section shares.
 *
 * `LandingStyles` is the one place this page is allowed to add CSS. The design
 * system in `globals.css` owns the vocabulary; a marketing page still needs a
 * handful of keyframes nothing else in the product wants — a word rising out
 * of a mask, a phrase flipping to the next one, a hairline drawing itself in
 * the brand ramp. They are declared once, through React 19's stylesheet
 * hoisting, so the rules land in `<head>` exactly once however many sections
 * render. Every value in them is a token or a stop on the brand ramp: no
 * colour is invented here.
 *
 * `useInView` is the "start when it is seen" primitive. Its honest failure is
 * *finished*, never *hidden*: no IntersectionObserver, or reduced motion, and
 * the caller is told the element is in view immediately, so the count-ups show
 * their number and the drawn lines show their shape.
 *
 * `useStagger` is the same idea one level up, and it is the reason none of the
 * text motion on this page can ever hide anything. It hands back a class name
 * that is empty on the server, empty for anyone who asked for less motion, and
 * empty until React has mounted — so server-rendered HTML, a crawler and a
 * broken bundle all see finished type. Only once it is armed does the CSS dare
 * to translate a word off its line.
 *
 * `Rise`, `SplitText`, `SectionHead` and the decorative layers (`Grain`,
 * `Aurora`, `GradientRule`, `Parallax`) are the vocabulary the sections build
 * from, so the whole page arrives with one accent instead of six.
 */

import { useReducedMotion } from "framer-motion";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { GradientText } from "@/components/brand/GradientText";
import { cx } from "@/components/ui";
import { useReveal } from "@/lib/useReveal";

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

/**
 * Grain, as a data URI rather than a file: a landing page that waits on a
 * network round trip to stop looking flat still looks flat for the only second
 * that matters. `feTurbulence`, desaturated to grey, so the blend mode decides
 * what it does to the ground under it.
 */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E\")";

const LANDING_CSS = `
/* ==================================================================
   Text motion
   ==================================================================
   Every rule below is gated on .ms-armed, which JavaScript adds after
   mount and never adds under prefers-reduced-motion. Un-armed markup is
   finished markup: nothing here can leave a headline invisible. */

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

/* The scroll-triggered sibling of .ms-word: one mask per word, so the reveal
   survives any wrap at any breakpoint without measuring a line. */
.ms-w {
  display: inline-block;
  overflow: hidden;
  padding-bottom: 0.14em;
  margin-bottom: -0.14em;
  vertical-align: bottom;
}
.ms-w > span { display: inline-block; }
.ms-armed .ms-w > span { transform: translateY(118%); }
.ms-armed.ms-in .ms-w > span {
  animation: ms-word-rise 0.9s var(--ease-out-soft) both;
}

/* Per-character, for a line short enough that a reader can follow it. */
@keyframes ms-char-in {
  from { opacity: 0; transform: translateY(0.45em); }
  to { opacity: 1; transform: none; }
}
.ms-c { display: inline-block; white-space: pre; }
.ms-armed .ms-c { opacity: 0; }
.ms-armed.ms-in .ms-c { animation: ms-char-in 0.5s var(--ease-out-soft) both; }

/* A paragraph or a row arriving under the heading it belongs to. */
@keyframes ms-fade-up {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: none; }
}
.ms-armed .ms-fade { opacity: 0; }
.ms-armed.ms-in .ms-fade { animation: ms-fade-up 0.8s var(--ease-out-soft) both; }

@keyframes ms-pop-up {
  from { opacity: 0; transform: translateY(10px) scale(0.96); }
  to { opacity: 1; transform: none; }
}
.ms-armed .ms-pop { opacity: 0; }
.ms-armed.ms-in .ms-pop { animation: ms-pop-up 0.6s var(--ease-out-soft) both; }

/* A hairline in the brand ramp that draws itself left to right, faded at both
   ends so it reads as a rule rather than a progress bar. */
.ms-rule {
  height: 1.5px;
  border-radius: 2px;
  background-image: var(--ms-gradient);
  mask-image: linear-gradient(to right, transparent, #000 14%, #000 86%, transparent);
  -webkit-mask-image: linear-gradient(to right, transparent, #000 14%, #000 86%, transparent);
  transform-origin: left center;
  transition: transform 1.2s var(--ease-out-soft);
}
.ms-armed .ms-rule { transform: scaleX(0); }
.ms-armed.ms-in .ms-rule { transform: scaleX(1); }

/* The rotating half of the hero sentence.
   Two named animations rather than one crossfade: the old ending leaves
   upward through the top of its mask while the new one arrives from under the
   bottom, which is a mechanism a reader can see, not a dissolve they cannot.
   Gated on .ms-rot-live, added only after mount and never under reduced
   motion, so the first ending is simply *there* for everybody else. */
@keyframes ms-rot-in {
  from { opacity: 0; transform: translateY(112%); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes ms-rot-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-112%); }
}
.ms-rot-live .ms-rot .ms-w > span { opacity: 0; transform: translateY(112%); }
.ms-rot-live .ms-rot.is-in .ms-w > span {
  animation: ms-rot-in 0.66s var(--ease-out-soft) both;
}
.ms-rot-live .ms-rot.is-out .ms-w > span {
  animation: ms-rot-out 0.44s var(--ease-out-soft) both;
}

/* Reduced motion collapses durations globally but not delays, and a 600ms
   delay on a 0.01ms animation is 600ms of blank. Nothing on this page waits. */
@media (prefers-reduced-motion: reduce) {
  .ms-word,
  .ms-w > span,
  .ms-c,
  .ms-fade,
  .ms-pop,
  .ms-settle,
  .ms-rule,
  .ms-ocr-fill,
  .ms-bill-row,
  .pop-in,
  .stagger > * { animation-delay: 0ms !important; transition-delay: 0ms !important; }
}

/* ==================================================================
   Block motion
   ================================================================== */

/* A card lifting into place. It lives on a wrapper, never on the card itself:
   a settled element must own its transform again or its hover lift is dead. */
.ms-settle {
  transition:
    opacity 0.8s var(--ease-out-soft),
    transform 0.8s var(--ease-out-soft);
}
.ms-settle.ms-armed {
  opacity: 0;
  transform: translateY(var(--ms-rise-y, 28px)) scale(var(--ms-rise-scale, 0.98));
  will-change: opacity, transform;
}
.ms-settle.ms-armed.ms-in {
  opacity: 1;
  transform: none;
}

/* ==================================================================
   Ground: what light mode is missing
   ==================================================================
   Dark mode gets depth for free — every surface glows against a navy that is
   already three shades deep. On white, flat is the default state, so the depth
   has to be built: a drifting ramp wash, a grain that stops the paper reading
   as a screenshot, and elevation tinted with the brand's own royal blue rather
   than the neutral grey a shadow defaults to. */

.ms-grain {
  background-image: ${GRAIN};
  opacity: 0.055;
  mix-blend-mode: multiply;
}
.dark .ms-grain {
  opacity: 0.085;
  mix-blend-mode: screen;
}

.ms-aurora > span {
  position: absolute;
  display: block;
  border-radius: 9999px;
}
.ms-aurora-a { background: radial-gradient(closest-side, rgb(11 63 168 / 0.17), transparent); }
.ms-aurora-b { background: radial-gradient(closest-side, rgb(20 196 193 / 0.22), transparent); }
.ms-aurora-c { background: radial-gradient(closest-side, rgb(26 143 199 / 0.16), transparent); }
.dark .ms-aurora-a { background: radial-gradient(closest-side, rgb(11 63 168 / 0.5), transparent); }
.dark .ms-aurora-b { background: radial-gradient(closest-side, rgb(20 196 193 / 0.16), transparent); }
.dark .ms-aurora-c { background: radial-gradient(closest-side, rgb(26 143 199 / 0.22), transparent); }

/* Elevation that reads on white: three stacked shadows tinted with the ramp's
   own royal blue, because a grey shadow on a blue-white canvas looks like dirt. */
.ms-elevate {
  box-shadow:
    0 1px 2px rgb(11 63 168 / 0.06),
    0 10px 24px -14px rgb(11 63 168 / 0.28),
    0 36px 64px -32px rgb(11 63 168 / 0.34);
}
.dark .ms-elevate { box-shadow: var(--shadow-float); }

/* An accent that survives on white: a hairline in the ramp across the top of a
   card, arriving under the cursor. */
.ms-edge { position: relative; }
.ms-edge::after {
  content: "";
  position: absolute;
  left: 1.5rem;
  right: 1.5rem;
  top: 0;
  height: 2px;
  border-radius: 2px;
  background-image: var(--ms-gradient);
  mask-image: linear-gradient(to right, transparent, #000, transparent);
  -webkit-mask-image: linear-gradient(to right, transparent, #000, transparent);
  opacity: 0;
  transform: scaleX(0.5);
  transition:
    opacity 0.35s ease,
    transform 0.55s var(--ease-out-soft);
  pointer-events: none;
}
.group:hover .ms-edge::after,
.group:focus-within .ms-edge::after {
  opacity: 1;
  transform: none;
}

/* A node with a halo — the one decorative glow bright enough to read on white
   and dim enough not to shout on navy. */
@keyframes ms-halo {
  0%, 100% { opacity: 0.3; transform: scale(0.75); }
  50% { opacity: 0.85; transform: scale(1.25); }
}
.ms-node { position: relative; }
.ms-node::before {
  content: "";
  position: absolute;
  inset: -7px;
  border-radius: 9999px;
  background: radial-gradient(closest-side, rgb(20 196 193 / 0.6), transparent);
  animation: ms-halo 3.2s ease-in-out infinite;
  pointer-events: none;
}

/* The reading-progress hairline under the bar. */
.ms-progress {
  transform-origin: left center;
  background-image: var(--ms-gradient);
}

/* ==================================================================
   The hero's monitor
   ================================================================== */

/* A trace that scrolls the way a bedside monitor's does: the path is drawn
   twice, end to end, and the pair slides one full copy to the left forever, so
   there is no seam and no JavaScript. */
   The contract: the group holds the same path twice, the second translated
   by +100 user units, inside a viewBox exactly 100 wide. CSS transform
   lengths on an SVG element are user units, so -100px is precisely one copy
   and the loop has no seam. */
@keyframes ms-trace-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(-100px); }
}
.ms-trace { animation: ms-trace-scroll var(--ms-trace-speed, 3.4s) linear infinite; }

/* The cursor sitting where the newest reading lands. */
@keyframes ms-trace-head {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
.ms-trace-head { animation: ms-trace-head 1.1s ease-in-out infinite; }

/* One slow sheen crossing the card, so the glass reads as glass. */
@keyframes ms-sheen {
  0% { transform: translateX(-130%) rotate(14deg); }
  55%, 100% { transform: translateX(420%) rotate(14deg); }
}
.ms-sheen { animation: ms-sheen 7s ease-in-out infinite; }

/* ==================================================================
   Tile demos
   ==================================================================
   A demo runs on hover, and once — unprompted — as its tile arrives.

   The one-shot exists because hover-only had a resting state of nothing:
   six grey wells on a desktop nobody hovered, and on a phone, where
   there is no hover at all, six grey wells permanently. That is the
   wrong resting state for the one section whose whole job is to show
   what the product does.

   Three phases, and the third is the one that matters:
   - untouched: paused at frame zero, exactly as before;
   - .ms-playing: the same animations, running, for one pass;
   - .ms-rested: paused again, with every demo pinned to its *finished*
     frame — the reply still on screen, the trace still drawn. A demo
     that plays and then erases itself is worse than one that never
     played.

   Every rest rule steps aside for :hover and :focus-within, so the
   replay still works — and steps back the instant the cursor leaves,
   which is also how an interrupted replay lands on something sensible
   instead of freezing mid-frame. */

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
.group:focus-within .ms-type,
.ms-playing .ms-type {
  animation: ms-type 1.6s steps(34) 0.15s forwards;
}
/* At rest the reply stops being a typewriter and becomes a message: the
   nowrap that makes the typing legible would otherwise leave a phone with a
   sentence cut off mid-word, which is a worse resting state than none. */
.ms-rested:not(:hover):not(:focus-within) .ms-type {
  width: 100%;
  white-space: normal;
}

/* The citation under the reply, arriving once the sentence has finished
   typing. Hidden by default rather than faded, so it cannot be read before
   the answer it belongs to exists. */
@keyframes ms-cite-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.ms-cite {
  opacity: 0;
}
.group:hover .ms-cite,
.group:focus-within .ms-cite,
.ms-playing .ms-cite {
  animation: ms-cite-in 0.5s var(--ease-out-soft) 1.75s forwards;
}
.ms-rested:not(:hover):not(:focus-within) .ms-cite {
  opacity: 1;
}

/* A demo only runs while its tile is under the cursor: six looping animations
   at rest would be a fairground, not a product. Descendants are paused too,
   because animation-play-state does not inherit. */
.ms-demo,
.ms-demo * { animation-play-state: paused; }
.group:hover .ms-demo,
.group:hover .ms-demo *,
.group:focus-within .ms-demo,
.group:focus-within .ms-demo *,
.ms-playing .ms-demo,
.ms-playing .ms-demo * { animation-play-state: running; }

/* ---- the finished frames ---------------------------------------------- */

/* Voice: the bars stop where a recorded waveform would, not all at one
   height. The per-bar value is set inline so the shape is deterministic. */
.ms-rested:not(:hover):not(:focus-within) .voice-bars > span {
  animation: none;
  transform: scaleY(var(--ms-rest, 0.5));
}

/* Document reading: the fields fill in behind the scan line, and the scan
   line leaves once it has crossed. A reader arriving late sees a read
   document, which is the claim the tile is making. */
.ms-ocr-fill {
  background-image: var(--ms-gradient);
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform 0.5s var(--ease-out-soft);
}
.ms-playing .ms-ocr-fill,
.ms-rested .ms-ocr-fill,
.group:hover .ms-ocr-fill,
.group:focus-within .ms-ocr-fill { transform: scaleX(1); }
.ms-rested:not(:hover):not(:focus-within) .scan-line {
  opacity: 0;
  transition: opacity 0.45s ease;
}

/* Vitals: the trace rests drawn. Dropping the animation entirely is what
   lets the element own its own dash offset again — a paused loop holds
   whatever frame it stopped on, which here is a blank line. */
.ms-rested:not(:hover):not(:focus-within) .ecg-draw-loop {
  animation: none;
  stroke-dashoffset: 0;
}

/* Billing: the lines arrive and stay arrived. The dimmed, offset state is
   declared here rather than in utilities so one rule can release it for
   the one-shot and for hover alike. */
.ms-bill-row {
  opacity: 0.45;
  transform: translateX(-0.5rem);
  transition:
    opacity 0.5s var(--ease-out-soft),
    transform 0.5s var(--ease-out-soft);
}
.ms-playing .ms-bill-row,
.ms-rested .ms-bill-row,
.group:hover .ms-bill-row,
.group:focus-within .ms-bill-row {
  opacity: 1;
  transform: none;
}

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

/** True once React has mounted on the client. Nothing is hidden before this. */
export function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // A frame later rather than in the effect body: this flips content from
    // "finished" to "waiting to animate", and doing that inside the same
    // commit is the cascading render React 19 warns about.
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return mounted;
}

/**
 * The scroll-triggered stagger, as two class names.
 *
 * `ms-armed` is what gives the CSS permission to hide anything, and it is
 * added only on a mounted client whose owner has not asked for less motion.
 * `ms-in` then releases it. The consequence worth stating: with JavaScript
 * off, with reduced motion on, or before hydration, the returned class name is
 * empty and every `.ms-w`, `.ms-fade` and `.ms-rule` inside renders finished.
 */
export function useStagger<T extends HTMLElement = HTMLDivElement>(
  threshold = 0.18,
  rootMargin = "0px 0px -8% 0px",
) {
  const [ref, seen] = useInView<T>(threshold, rootMargin);
  const reduced = useReducedMotion();
  const mounted = useMounted();
  const armed = mounted && reduced === false;
  return {
    ref,
    /** Put on the container that wraps the animated children. */
    className: cx(armed && "ms-armed", armed && seen && "ms-in"),
    seen,
    armed,
  } as const;
}

/**
 * Play once on arrival, then rest finished.
 *
 * The tile it is put on gets `ms-playing` for one pass and `ms-rested`
 * forever after; the stylesheet decides what each demo's finished frame
 * looks like. Four properties this has to hold, all of them things the
 * hover-only version got wrong or never had to answer:
 *
 * - **Once per element per visit.** The observer disconnects on its first
 *   intersection, so scrolling the section past twice does not restart six
 *   loops behind the reader.
 * - **One at a time.** `delay` is the tile's place in the row, so the eye is
 *   led across the grid instead of ambushed by six demos at once.
 * - **Nothing runs behind a hidden tab.** If the tile is intersecting while
 *   the tab is in the background, the whole schedule waits for the tab to
 *   come back rather than burning its one pass where nobody is.
 * - **Reduced motion schedules nothing at all** — no observer, no timers, the
 *   finished frame immediately. Which is also, deliberately, the state anyone
 *   without JavaScript gets: the rest rules only *add* a finished frame, they
 *   never hide what was already readable.
 *
 * The observer is per tile rather than one for the grid on purpose. A single
 * section-level observer fires all six from one viewport's worth of the top
 * of the grid — which on a phone, where the grid is one column and four
 * screens tall, would play five of the six demos to an empty room. That is
 * the exact failure this is here to fix.
 */
export function useOneShot<T extends HTMLElement = HTMLDivElement>({
  delay = 0,
  duration = 1900,
}: { delay?: number; duration?: number } = {}) {
  const ref = useRef<T | null>(null);
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<"idle" | "playing" | "rested">("idle");

  useEffect(() => {
    if (reduced === null) return; // Not resolved yet; this effect re-runs.
    const element = ref.current;
    if (!element) return;

    // Nothing to wait for. Show the finished frame and schedule nothing.
    if (reduced || !("IntersectionObserver" in window)) {
      const frame = requestAnimationFrame(() => setPhase("rested"));
      return () => cancelAnimationFrame(frame);
    }

    let startTimer: ReturnType<typeof setTimeout> | undefined;
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let stopWaiting: (() => void) | undefined;

    const play = () => {
      startTimer = setTimeout(() => {
        setPhase("playing");
        endTimer = setTimeout(() => setPhase("rested"), duration);
      }, delay);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.disconnect();
          if (!document.hidden) {
            play();
            return;
          }
          const onVisible = () => {
            if (document.hidden) return;
            stopWaiting?.();
            play();
          };
          stopWaiting = () => {
            document.removeEventListener("visibilitychange", onVisible);
            stopWaiting = undefined;
          };
          document.addEventListener("visibilitychange", onVisible);
          return;
        }
      },
      { threshold: 0.3, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(element);

    return () => {
      observer.disconnect();
      clearTimeout(startTimer);
      clearTimeout(endTimer);
      stopWaiting?.();
    };
  }, [reduced, delay, duration]);

  return {
    ref,
    /** Put on the tile that owns the `.ms-demo` — it is also the `.group`. */
    className: cx(phase === "playing" && "ms-playing", phase === "rested" && "ms-rested"),
  } as const;
}

/** `true` once the viewport is at least `px` wide. `false` until mounted. */
export function useMinWidth(px: number) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (!("matchMedia" in window)) return;
    const query = window.matchMedia(`(min-width: ${px}px)`);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [px]);
  return matches;
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

export type TitlePart = string | { text: string; gradient: true };

export function splitWords(text: string) {
  return text.split(" ").filter(Boolean);
}

/**
 * One mask around a whole run, with the run's content inside the moving span.
 *
 * This exists for exactly one reason, and it is worth stating plainly because
 * it is invisible in a diff and catastrophic on screen: **an element with a
 * running or filling animation inside a `background-clip: text` span does not
 * paint at all.** The animation promotes it to its own compositing layer, the
 * clip is resolved without it, and the gradient headline renders as blank
 * space — no error, no warning, just a missing sentence.
 *
 * So the gradient half of a headline is never split into animated words.
 * Instead the mask and the moving span sit *outside* `GradientText`, which is
 * then a static descendant of a composited layer — which is fine — and the
 * ramp still runs continuously across the whole run instead of restarting on
 * every word.
 */
export function MaskedRun({ children, delay }: { children: ReactNode; delay: number }) {
  return (
    <span className="ms-w">
      <span style={{ animationDelay: `${delay}ms` }}>{children}</span>
    </span>
  );
}

/**
 * A run of plain words, each in its own mask.
 *
 * Per word rather than per line on purpose: a line mask has to know where the
 * browser broke the text, which is a measurement that goes wrong at exactly
 * the breakpoint nobody tested. A word carries its own.
 */
export function MaskedWords({
  text,
  start = 0,
  step = 55,
  offset = 0,
}: {
  text: string;
  start?: number;
  step?: number;
  /** Word index this run begins at, so a stagger can span several runs. */
  offset?: number;
}) {
  return splitWords(text).map((word, position) => (
    <span key={`${word}-${position}`}>
      {position > 0 && " "}
      <span className="ms-w">
        <span style={{ animationDelay: `${start + (offset + position) * step}ms` }}>{word}</span>
      </span>
    </span>
  ));
}

/** A headline split into masked words, driven by the nearest `useStagger`. */
export function SplitText({
  parts,
  start = 0,
  step = 55,
  className,
}: {
  parts: TitlePart[];
  /** Milliseconds before the first word moves. */
  start?: number;
  /** Milliseconds between words. */
  step?: number;
  className?: string;
}) {
  // The stagger runs across the whole title, so each part has to know how many
  // words came before it. Computed up front rather than accumulated inside the
  // map: a counter mutated from a render closure is a bug waiting for a
  // re-render to find it.
  const lengths = parts.map((part) =>
    splitWords(typeof part === "string" ? part : part.text).length,
  );
  const offsets = lengths.map((_, index) =>
    lengths.slice(0, index).reduce((total, length) => total + length, 0),
  );

  return (
    <span className={className}>
      {parts.map((part, partIndex) => (
        <span key={partIndex}>
          {partIndex > 0 && " "}
          {typeof part === "string" ? (
            <MaskedWords text={part} start={start} step={step} offset={offsets[partIndex]} />
          ) : (
            // One run, one mask — see `MaskedRun` for why the gradient half is
            // never split into animated words.
            <MaskedRun delay={start + offsets[partIndex] * step}>
              <GradientText>{part.text}</GradientText>
            </MaskedRun>
          )}
        </span>
      ))}
    </span>
  );
}

/** A short line, one character at a time. Only for labels — never a sentence. */
export function SplitChars({
  text,
  start = 0,
  step = 22,
  className,
}: {
  text: string;
  start?: number;
  step?: number;
  className?: string;
}) {
  return (
    <span className={className}>
      {Array.from(text).map((character, index) => (
        <span
          key={`${character}-${index}`}
          className="ms-c"
          style={{ animationDelay: `${start + index * step}ms` }}
        >
          {character}
        </span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Decorative layers                                                   */
/* ------------------------------------------------------------------ */

/**
 * The grain. Rendered as its own element rather than a `::after` on the
 * section, because a pseudo-element paints last and a multiply blend painted
 * last is a multiply blend over the copy.
 */
export function Grain({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cx("ms-grain pointer-events-none absolute inset-0", className)} />
  );
}

/**
 * Three slow ramp washes drifting behind a light section.
 *
 * `mesh-light` in the design system is two static blobs. This adds movement
 * and a third stop, which is the difference between "a gradient was applied"
 * and "the page has weather".
 */
export function Aurora({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cx("ms-aurora pointer-events-none absolute inset-0", className)}>
      <span
        className="ms-aurora-a animate-drift"
        style={{ left: "-14%", top: "-26%", width: "58%", paddingBottom: "58%" }}
      />
      <span
        className="ms-aurora-b animate-drift-late"
        style={{ right: "-16%", top: "4%", width: "62%", paddingBottom: "62%" }}
      />
      <span
        className="ms-aurora-c animate-float-slow"
        style={{ left: "24%", bottom: "-34%", width: "52%", paddingBottom: "52%" }}
      />
    </div>
  );
}

/** The brand ramp as a hairline. Draws itself inside an armed stagger. */
export function GradientRule({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden className={cx("ms-rule block w-full", className)} style={style} />;
}

/**
 * A decorative layer that drifts against the scroll.
 *
 * Only ever wrapped around decoration — never around text somebody is reading,
 * where a few pixels of drift is the difference between a page and a boat.
 * The translation is vertical and lives inside an `overflow-hidden` section, so
 * it can never widen the document.
 */
export function Parallax({
  speed = 24,
  className,
  children,
}: {
  /** Pixels of travel across a full viewport of scroll. */
  speed?: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced !== false) return;
    const element = ref.current;
    if (!element) return;

    let frame = 0;
    let queued = false;
    const update = () => {
      queued = false;
      const rect = element.getBoundingClientRect();
      const viewport = window.innerHeight || 1;
      // -0.5 … 0.5 as the element crosses the viewport.
      const progress = (rect.top + rect.height / 2) / viewport - 0.5;
      element.style.transform = `translate3d(0, ${(progress * speed).toFixed(2)}px, 0)`;
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [reduced, speed]);

  return (
    <div ref={ref} className={className} style={{ willChange: "transform" }}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rhythm                                                              */
/* ------------------------------------------------------------------ */

/** The original fade-up wrapper, kept for blocks that want no stagger. */
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

/**
 * A block that lifts and settles as it arrives.
 *
 * The transform sits on this wrapper, never on the child, so a card inside
 * keeps its own hover lift once the entrance is over.
 */
export function Rise({
  children,
  delay = 0,
  y = 28,
  scale = 0.98,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  scale?: number;
  className?: string;
}) {
  const [ref, seen] = useInView<HTMLDivElement>(0.12, "0px 0px -6% 0px");
  const reduced = useReducedMotion();
  const mounted = useMounted();
  const armed = mounted && reduced === false;

  return (
    <div
      ref={ref}
      className={cx("ms-settle", armed && "ms-armed", armed && seen && "ms-in", className)}
      style={
        {
          "--ms-rise-y": `${y}px`,
          "--ms-rise-scale": scale,
          transitionDelay: `${delay}ms`,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

/** The small gradient-dotted label that opens a section. */
export function Eyebrow({
  children,
  tone = "accent",
}: {
  children: ReactNode;
  tone?: "accent" | "light";
}) {
  return (
    <p
      className={cx(
        "mono-caps inline-flex items-center gap-2.5 text-[0.7rem]",
        tone === "accent" ? "text-accent" : "text-[#5EEAD4]",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "ms-node h-1.5 w-1.5 rounded-full",
          tone === "accent" ? "bg-gradient-brand" : "bg-[#5EEAD4]",
        )}
      />
      {typeof children === "string" ? <SplitChars text={children} start={80} /> : children}
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
  /** Split into masked words; `{ text, gradient: true }` runs the brand ramp. */
  title: TitlePart[];
  lede?: string;
  align?: "left" | "center";
  className?: string;
}) {
  const { ref: headRef, className: headMotion } = useStagger<HTMLDivElement>();
  const wordCount = title.reduce(
    (total, part) => total + splitWords(typeof part === "string" ? part : part.text).length,
    0,
  );

  return (
    <div
      ref={headRef}
      className={cx(
        headMotion,
        align === "center" && "flex flex-col items-center text-center",
        className,
      )}
    >
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-4 max-w-2xl font-display text-[2rem] font-bold leading-[1.12] text-strong sm:text-[2.6rem]">
        <SplitText parts={title} start={180} />
      </h2>
      <GradientRule
        className={cx("mt-5 max-w-[7rem]", align === "center" && "mx-auto")}
        style={{ transitionDelay: `${180 + wordCount * 55}ms` }}
      />
      {lede && (
        <p
          className="ms-fade mt-5 max-w-[52ch] text-[17px] leading-relaxed text-muted"
          style={{ animationDelay: `${260 + wordCount * 55}ms` }}
        >
          {lede}
        </p>
      )}
    </div>
  );
}

/** The container every section shares, so the page has one column. */
export function Shell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-[1180px] px-5", className)}>{children}</div>;
}

/** How far down the document the reader is, 0 … 1. Cheap, rAF-throttled. */
export function useScrollProgress() {
  const [progress, setProgress] = useState(0);
  const queued = useRef(false);

  const measure = useCallback(() => {
    queued.current = false;
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - window.innerHeight;
    setProgress(scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0);
  }, []);

  useEffect(() => {
    const onScroll = () => {
      if (queued.current) return;
      queued.current = true;
      requestAnimationFrame(measure);
    };
    const first = requestAnimationFrame(measure);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(first);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [measure]);

  return progress;
}
