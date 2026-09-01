"use client";

/**
 * One day, one patient — told as four acts over a pinned scene.
 *
 * A feature grid can list what this product has. It cannot show the thing the
 * product is for: that a symptom spoken at eight in the morning is already on a
 * doctor's screen at half past ten, and that nobody carried it there. That is a
 * *sequence*, and a grid is the one shape that cannot show a sequence.
 *
 * So the page opens pinned. The section is four viewports tall; the scene
 * inside it holds still while the reader scrolls through it, and the field of
 * points behind the words rearranges itself from a voice into a record, into a
 * handover, into a system. Sixty seconds and somebody has watched the product
 * work.
 *
 * **The light goes the other way to the story.** The scene starts before dawn —
 * a person awake at eight with something wrong — and ends in daylight, which is
 * the page it hands off to. A dark hero on a daylight page would be a costume;
 * a night that becomes morning is the same argument the copy is making.
 *
 * **Scroll drives everything and nothing runs on a timer.** The reader sets the
 * pace, can go back, and can stop on an act and read it. An autoplaying version
 * would be a video, and nobody scrubs a video on a landing page.
 *
 * **Reduced motion and small screens get the whole story, not a trailer.** The
 * same four acts, stacked and still, in the same order and the same words. A
 * pinned four-viewport scene on a 390px phone is a hostage situation; a person
 * who cannot take one is owed the argument, not an apology for it.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { motion, useMotionValueEvent, useScroll, useSpring, useTransform } from "framer-motion";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { useTr } from "@/lib/lang";

/** Never bundled into a portal route, and never rendered on the server. */
const StoryScene = dynamic(
  () => import("@/components/landing/StoryScene").then((m) => m.StoryScene),
  { ssr: false },
);

interface Act {
  numeral: string;
  clock: string;
  when: [string, string];
  lead: [string, string];
  accent: [string, string];
  body: [string, string];
}

/**
 * Four acts, and one accented word each.
 *
 * The accent is the only place the brand gradient appears in this section. A
 * gradient on every heading is wallpaper; on one word per act it is emphasis,
 * and it lands on the noun the act is actually about.
 */
const ACTS: Act[] = [
  {
    numeral: "I",
    clock: "08:00",
    when: ["Morning", "Subah"],
    lead: ["It starts with a", "Shuruaat hoti hai ek"],
    accent: ["spoken symptom.", "boli hui taklif se."],
    body: [
      "A patient holds the button and describes what is wrong, in their own words. No form, no dropdown, no spelling a symptom they have never had to write down.",
      "Mareez button daba kar apne alfaz mein batata hai kya taklif hai. Na form, na dropdown, na koi aisa lafz likhna jo us ne kabhi likha hi nahi.",
    ],
  },
  {
    numeral: "II",
    clock: "08:05",
    when: ["Five minutes later", "Paanch minute baad"],
    lead: ["MediSense turns it into a", "MediSense usse banata hai ek"],
    accent: ["structured record.", "record."],
    body: [
      "Their words are kept as their words. The assistant names the department to book — never the illness, because that is a doctor's sentence to write.",
      "Alfaz un ke apne rehte hain. Assistant department batata hai — bimari nahi, kyunki woh jumla doctor ka hai.",
    ],
  },
  {
    numeral: "III",
    clock: "10:30",
    when: ["Before the visit", "Visit se pehle"],
    lead: ["And hands it to the", "Aur pohanchata hai"],
    accent: ["treating doctor.", "ilaj karne wale doctor tak."],
    body: [
      "The patient carries nothing. Every access is written to a trail that cannot be edited or deleted — so the record travels, and the fact that it travelled is permanent.",
      "Mareez kuchh nahi le kar jata. Har rasai aisi trail mein likhi jati hai jo na badli ja sakti hai na mitayi — record safar karta hai, aur safar ka nishan hamesha rehta hai.",
    ],
  },
  {
    numeral: "IV",
    clock: "21:00",
    when: ["That evening", "Usi shaam"],
    lead: ["One consultation becomes a", "Ek consultation se banta hai poora"],
    accent: ["connected system.", "juda hua nizaam."],
    body: [
      "The invoice was raised the moment the visit was marked complete. The medication reminder arrives at nine. Multiply by every clinic on the platform.",
      "Visit mukammal hote hi invoice ban gaya tha. Dawa ki yaad-dehani nau baje aa jati hai. Isse platform ke har clinic se zarb dein.",
    ],
  },
];

/** Where each act fades in, holds, and leaves. */
const WINDOWS: [number, number, number, number][] = [
  [0.0, 0.03, 0.19, 0.24],
  [0.26, 0.31, 0.44, 0.49],
  [0.51, 0.56, 0.69, 0.74],
  [0.76, 0.81, 1.0, 1.0],
];

/**
 * The ground, act by act. One blue, lit four ways.
 *
 * #00194D throughout, with a soft light source that rises and widens as the
 * story opens out — the same trick the object uses. Four *hues* would read as
 * four scenes; one hue under a moving light reads as one place at four times of
 * day, which is what this is.
 *
 * A CSS gradient behind a transparent canvas rather than three.js fog: fog
 * costs a pass on the GPU to do what two background colours already do, and
 * this keeps working on the machines with no WebGL at all.
 */
const SKIES = [
  "radial-gradient(120% 80% at 50% 8%, #062A63 0%, #00194D 46%, #000E2C 100%)",
  "radial-gradient(120% 80% at 50% 18%, #0A3A80 0%, #00194D 52%, #000E2C 100%)",
  "radial-gradient(120% 80% at 50% 34%, #1257A8 0%, #06285C 54%, #00133A 100%)",
  "radial-gradient(120% 90% at 50% 62%, #2F84C4 0%, #0B3E80 46%, #00194D 100%)",
];

function Frame({
  act,
  range,
  progress,
  children,
}: {
  act: Act;
  range: [number, number, number, number];
  progress: ReturnType<typeof useSpring>;
  children?: React.ReactNode;
}) {
  const tr = useTr();
  const opacity = useTransform(progress, range, [0, 1, 1, 0]);
  const y = useTransform(progress, range, [18, 0, 0, -18]);

  return (
    <motion.div
      style={{ opacity, y }}
      className="absolute inset-x-0 mx-auto max-w-3xl px-6 text-center"
    >
      <p className="mono-caps text-[11px] text-[#5EC8E6]">
        {act.clock} · {tr(...act.when)}
      </p>
      <p className="font-display mt-4 text-4xl font-black leading-[1.06] tracking-tight text-white sm:text-6xl lg:text-7xl">
        {tr(...act.lead)}{" "}
        {/* The light ramp, not the brand one: `text-gradient-brand` runs deep
            blue and all but disappears on this navy. globals.css keeps
            `text-gradient-medical` for exactly this — a coloured ground. */}
        <span className="text-gradient-medical">{tr(...act.accent)}</span>
      </p>
      <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-[#AFC9E8] sm:text-lg">
        {tr(...act.body)}
      </p>
      {children}
    </motion.div>
  );
}

export function Story({
  primaryHref,
  primaryLabel,
}: {
  primaryHref: string;
  primaryLabel: string;
}) {
  const tr = useTr();
  const track = useRef<HTMLElement | null>(null);

  /**
   * Small screens and reduced motion both get the stacked telling.
   *
   * Read once before paint and then kept in step, because a pinned scene that
   * appears for one frame on a phone and then unmounts is worse than never
   * having tried.
   */
  const [still, setStill] = useState(false);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 767px)");
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setStill(narrow.matches || calm.matches);
    update();
    narrow.addEventListener("change", update);
    calm.addEventListener("change", update);
    return () => {
      narrow.removeEventListener("change", update);
      calm.removeEventListener("change", update);
    };
  }, []);

  const { scrollYProgress } = useScroll({
    target: track,
    offset: ["start start", "end end"],
  });

  // Raw scroll is mechanical; a spring is what makes it read as camera work.
  const progress = useSpring(scrollYProgress, {
    stiffness: 80,
    damping: 26,
    mass: 0.45,
    restDelta: 0.0001,
  });

  /**
   * The scene reads this every frame. A ref rather than state on purpose: a
   * component that re-rendered on every scroll frame would drop frames on the
   * phone this was built to impress.
   */
  const scenePosition = useRef(0);
  useMotionValueEvent(progress, "change", (value) => {
    scenePosition.current = value;
  });

  // The sky is a background swap rather than an interpolation: four states,
  // cross-faded by CSS, which is one property to animate instead of three.
  const [act, setAct] = useState(0);
  useMotionValueEvent(progress, "change", (value) => {
    setAct(Math.min(ACTS.length - 1, Math.floor(value * ACTS.length)));
  });

  const hintOpacity = useTransform(progress, [0, 0.03, 0.07], [1, 1, 0]);

  if (still) {
    return (
      <section className="border-b border-line bg-canvas">
        <div className="mx-auto max-w-2xl px-6 py-16">
          <p className="mono-caps text-xs text-primary">
            {tr("One day, one patient", "Ek din, ek mareez")}
          </p>
          <h1 className="font-display mt-3 text-4xl font-black leading-[1.05] tracking-tight text-strong">
            {tr("A symptom at eight is on the chart by ten.", "Aath baje ki taklif, das baje chart par.")}
          </h1>
          <ol className="mt-10 space-y-9">
            {ACTS.map((item) => (
              <li key={item.numeral} className="border-l-2 border-line pl-5">
                <p className="mono-caps text-[11px] text-primary">
                  {item.clock} · {tr(...item.when)}
                </p>
                <p className="font-display mt-1.5 text-2xl font-bold leading-tight text-strong">
                  {tr(...item.lead)} <span className="text-gradient-brand">{tr(...item.accent)}</span>
                </p>
                <p className="mt-2 text-base leading-relaxed text-muted">{tr(...item.body)}</p>
              </li>
            ))}
          </ol>
          <Link
            href={primaryHref}
            className="bg-gradient-brand mt-10 inline-flex min-h-12 items-center gap-2 rounded-xl px-6 font-bold text-white"
          >
            {primaryLabel}
            <Icon name="arrow_forward" className="text-[20px]" />
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={track}
      aria-label={tr("One day, one patient", "Ek din, ek mareez")}
      className="relative h-[400vh]"
    >
      <div className="sticky top-0 h-screen overflow-hidden">
        {/* The sky. Four states, cross-faded — night at eight in the morning,
            because that is what a person awake with a symptom is looking at,
            and daylight by the end, which is the page underneath. */}
        {SKIES.map((sky, i) => (
          <div
            key={sky}
            aria-hidden
            className="absolute inset-0 transition-opacity duration-700"
            style={{ background: sky, opacity: i === act ? 1 : 0 }}
          />
        ))}

        <StoryScene progress={scenePosition} />

        {/* Readability, not decoration: the words sit over a moving field, and
            a headline that is legible only on some frames is not legible. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(0,15,45,0.62) 0%, rgba(0,15,45,0) 64%)",
            // The last act is the brightest, and a scrim tuned for the dark
            // ones would sit on it as a smudge.
            opacity: act === 3 ? 0.45 : 1,
            transition: "opacity 700ms",
          }}
        />

        {/* The act, so a reader always knows how much day is left. */}
        <div className="mono-caps absolute left-6 top-24 flex items-center gap-3 text-[11px] text-white/55 sm:left-10">
          <span className="h-px w-6 bg-white/40" />
          <span>{tr("Act", "Hissa")}</span>
          <span className="font-display text-base text-[#5EC8E6]">{ACTS[act].numeral}</span>
        </div>

        <div className="absolute inset-0 grid place-items-center">
          {ACTS.map((item, i) => (
            <Frame key={item.numeral} act={item} range={WINDOWS[i]} progress={progress}>
              {i === ACTS.length - 1 && (
                <div className="pointer-events-auto mt-8 flex flex-wrap justify-center gap-3">
                  <Link
                    href={primaryHref}
                    className="bg-gradient-brand inline-flex min-h-12 items-center gap-2 rounded-xl px-6 font-bold text-white"
                  >
                    {primaryLabel}
                    <Icon name="arrow_forward" className="text-[20px]" />
                  </Link>
                  <Link
                    href="/login"
                    className="inline-flex min-h-12 items-center rounded-xl border border-white/25 px-6 font-semibold text-white transition-colors hover:bg-white/10"
                  >
                    {tr("Sign in", "Sign in")}
                  </Link>
                </div>
              )}
            </Frame>
          ))}
        </div>

        <motion.div
          style={{ opacity: hintOpacity }}
          className="mono-caps pointer-events-none absolute bottom-9 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2 text-[10px] text-white/55"
        >
          <span>{tr("Scroll to follow the day", "Din dekhne ke liye scroll karein")}</span>
          <Icon name="keyboard_arrow_down" className="text-[18px] text-[#5EC8E6]" />
        </motion.div>
      </div>
    </section>
  );
}
