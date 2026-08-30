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
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";

import { Icon } from "@/components/Icon";
import { CircuitNodes } from "@/components/brand/CircuitNodes";
import { EcgLine } from "@/components/brand/EcgLine";
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
function Trace({ d, speed, head }: { d: string; speed: number; head: number }) {
  const id = `tr-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // Faded on the left only: on a monitor the reading enters from the right,
  // and that edge has to stay lit for the cursor sitting on it.
  const fade = "linear-gradient(to right, transparent, #000 24%)";

  return (
    <svg
      aria-hidden
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      className="mt-2.5 h-9 w-full"
      fill="none"
      style={{ maskImage: fade, WebkitMaskImage: fade }}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0B3FA8" />
          <stop offset="0.25" stopColor="#1A8FC7" />
          <stop offset="0.5" stopColor="#14C4C1" />
          <stop offset="0.75" stopColor="#1A8FC7" />
          <stop offset="1" stopColor="#0B3FA8" />
        </linearGradient>
      </defs>
      <g className="ms-trace" style={{ "--ms-trace-speed": `${speed}s` } as CSSProperties}>
        {[0, 100].map((offset) => (
          <path
            key={offset}
            d={d}
            transform={`translate(${offset} 0)`}
            stroke={`url(#${id})`}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </g>
      {/* Where the newest reading lands. Outside the scrolling group, because
          a monitor's cursor is the one thing that does not move. */}
      <circle className="ms-trace-head" cx="96.5" cy={head} r="2.4" fill="#14C4C1" />
    </svg>
  );
}

function Vital({
  label,
  value,
  unit,
  icon,
  trace,
  speed,
  head,
}: {
  label: string;
  value: string;
  unit: string;
  icon: string;
  trace: string;
  speed: number;
  head: number;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-sunken p-2.5 sm:p-3.5">
      <div className="flex items-start justify-between gap-2">
        <span className="mono-caps text-[0.6rem] leading-tight text-muted">{label}</span>
        <span
          aria-hidden
          className="bg-gradient-soft grid h-8 w-8 shrink-0 place-items-center rounded-lg text-primary"
        >
          <Icon name={icon} filled className="text-[17px]" />
        </span>
      </div>
      <p className="mt-3 flex items-baseline gap-1">
        {/* `tabular-nums` and a fixed baseline: a number that ticks must not
            shuffle the glyphs beside it every two seconds. */}
        <span className="font-mono text-[1.35rem] font-semibold leading-none tracking-tight tabular-nums text-strong sm:text-[2rem]">
          {value}
        </span>
        <span className="text-xs text-faint">{unit}</span>
      </p>
      <Trace d={trace} speed={speed} head={head} />
    </div>
  );
}

/** Traces start and end at the same height, or the tiled copy would step. */
const TRACE_HR =
  "M0 26 H6 L9 20 L12 31 L15 26 H26 L29 11 L33 35 L36 26 H50 H56 L59 20 L62 31 L65 26 H76 L79 11 L83 35 L86 26 H100";
const TRACE_SPO2 =
  "M0 22 C 8 15, 17 29, 25 22 C 33 15, 42 29, 50 22 C 58 15, 67 29, 75 22 C 83 15, 92 29, 100 22";
const TRACE_TEMP = "M0 24 L14 20 L28 26 L42 21 L56 25 L70 19 L84 26 L100 24";

/** A reading that drifts inside a plausible band, the way a real one does. */
function useLiveReading(initial: number, low: number, high: number, decimals: number) {
  const [value, setValue] = useState(initial);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced !== false) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () =>
      setValue((current) => {
        const step = (Math.random() - 0.5) * (high - low) * 0.55;
        const next = Math.min(high, Math.max(low, current + step));
        return Number(next.toFixed(decimals));
      });
    const start = () => {
      clearInterval(timer);
      timer = setInterval(tick, 2400);
    };
    const onVisibility = () => (document.hidden ? clearInterval(timer) : start());

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduced, low, high, decimals]);

  return value.toFixed(decimals);
}

function DeviceCard() {
  const tr = useTr();
  const reduced = useReducedMotion();
  const card = useRef<HTMLDivElement | null>(null);

  const heart = useLiveReading(72, 68, 77, 0);
  const spo2 = useLiveReading(98, 96, 99, 0);
  const temp = useLiveReading(36.8, 36.5, 37.1, 1);

  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    const element = card.current;
    if (!element || reduced) return;
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    element.style.transform = `perspective(1100px) rotateX(${(-y * 6).toFixed(2)}deg) rotateY(${(x * 6).toFixed(2)}deg)`;
  };
  const onLeave = () => {
    if (card.current) card.current.style.transform = "";
  };

  return (
    // The float loop lives on the wrapper and the tilt on the card: an element
    // has one transform, and a loop on it would swallow the cursor.
    <div className="animate-float-slow relative">
      {/* The card's own light, so it reads as raised off a white page rather
          than pasted onto one. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-8 rounded-[2.5rem]"
        style={{
          background:
            "radial-gradient(58% 52% at 52% 46%, rgb(20 196 193 / 0.2), transparent 72%), radial-gradient(50% 46% at 26% 78%, rgb(11 63 168 / 0.16), transparent 72%)",
        }}
      />

      <div
        ref={card}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        className="tilt border-gradient-thick ms-elevate relative overflow-hidden rounded-2xl p-5"
      >
        {/* One slow sheen, so the surface reads as glass under a light. */}
        <span
          aria-hidden
          className="ms-sheen pointer-events-none absolute -top-1/2 left-0 h-[200%] w-[26%] motion-reduce:hidden"
          style={{
            background: "linear-gradient(90deg, transparent, rgb(20 196 193 / 0.16), transparent)",
          }}
        />

        <div className="relative flex items-center gap-2 pb-4">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#0B3FA8]" />
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#1A8FC7]" />
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#14C4C1]" />
          <span className="mono-caps ml-2 min-w-0 truncate text-[0.6rem] text-faint">
            {tr("Patient dashboard", "Mareez ka dashboard")}
          </span>
          <span className="mono-caps ml-auto flex shrink-0 items-center gap-1.5 text-[0.6rem] text-accent">
            <span aria-hidden className="pulse-dot-brand h-1.5 w-1.5 rounded-full bg-accent-bright" />
            LIVE
          </span>
        </div>

        <div className="relative grid grid-cols-3 gap-2 sm:gap-2.5">
          <Vital
            label={tr("Heart rate", "Dil ki dharkan")}
            value={heart}
            unit="bpm"
            icon="favorite"
            trace={TRACE_HR}
            speed={2.6}
            head={26}
          />
          <Vital
            label="SpO₂"
            value={spo2}
            unit="%"
            icon="pulmonology"
            trace={TRACE_SPO2}
            speed={4.2}
            head={22}
          />
          <Vital
            label={tr("Temp", "Bukhaar")}
            value={temp}
            unit="°C"
            icon="thermostat"
            trace={TRACE_TEMP}
            speed={6.5}
            head={24}
          />
        </div>

        {/* The assistant refusing to reassure — the money shot. */}
        <div className="relative mt-4 rounded-xl border border-line bg-sunken p-4">
          <p className="bg-gradient-brand ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm text-white shadow-sm">
            {tr(
              "I have chest pain going down my left arm",
              "Seenay mein dard hai jo baayen baazu tak ja raha hai",
            )}
          </p>
          <div className="glow-critical mt-3 rounded-lg border border-critical bg-critical-soft px-4 py-3">
            <p className="flex items-center gap-2 text-sm font-bold text-critical">
              <span aria-hidden className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-critical" />
              {tr("This may need emergency care", "Yeh emergency ho sakti hai")}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-strong">
              {tr(
                "Do not wait for a reply here. Call your local emergency number or go to the nearest emergency department.",
                "Yahan jawab ka intezar na karein. Foran emergency number par call karein ya qareeb tareen emergency department jayein.",
              )}
            </p>
          </div>
          <p className="mt-3 border-t border-line pt-3 text-[0.72rem] leading-relaxed text-faint">
            This information is for preliminary guidance only and does not replace evaluation by a
            licensed healthcare professional.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

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

        <DeviceCard />
      </Shell>
    </section>
  );
}
