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

import Link from "next/link";
import { motion, useMotionValueEvent, useScroll, useSpring, useTransform } from "framer-motion";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { ACT_WINDOWS, StoryStage } from "@/components/landing/StoryStage";
import { useTr } from "@/lib/lang";

interface Act {
  numeral: string;
  chip: [string, string];
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
    chip: ["A new chapter for healthcare", "Sehat ka naya baab"],
    clock: "08:00",
    when: ["Morning", "Subah"],
    lead: ["It starts with a single", "Shuruaat hoti hai ek"],
    accent: ["heartbeat.", "dharkan se."],
    body: [
      "Every recovery begins quietly — with one symptom, one question, and somebody listening carefully.",
      "Har shifa khamoshi se shuru hoti hai — ek alamat, ek sawal, aur koi jo dhyan se sunta hai.",
    ],
  },
  {
    numeral: "II",
    chip: ["Voice symptom intake", "Awaaz se alamat"],
    clock: "08:05",
    when: ["Five minutes later", "Paanch minute baad"],
    lead: ["A pulse that", "Ek nabz jo"],
    accent: ["learns to listen.", "sunna seekh leti hai."],
    body: [
      "Speak in Urdu or English. What is said becomes symptoms, severity and duration — with no form to fill in and no word to spell.",
      "Urdu ya English mein bolein. Jo kaha jaye woh alamat, shiddat aur muddat ban jata hai — na form bharna, na koi lafz likhna.",
    ],
  },
  {
    numeral: "III",
    chip: ["Reports · Prescriptions · Vitals", "Reports · Nuskhe · Vitals"],
    clock: "10:30",
    when: ["Before the visit", "Visit se pehle"],
    lead: ["And turns it into a", "Aur usse banati hai ek"],
    accent: ["record.", "record."],
    body: [
      "Lab reports and handwritten prescriptions are read and structured; live vitals join them. Every access is written to a trail nobody can edit or delete.",
      "Lab reports aur haath se likhe nuskhe parhe aur tarteeb diye jate hain; live vitals un ke saath aa milte hain. Har rasai aisi trail mein likhi jati hai jo koi badal ya mita nahi sakta.",
    ],
  },
  {
    numeral: "IV",
    chip: ["Patient · Doctor · Admin", "Mareez · Doctor · Admin"],
    clock: "11:15",
    when: ["At the clinic", "Clinic par"],
    lead: ["One record,", "Ek record,"],
    accent: ["three views.", "teen nazrein."],
    body: [
      "Patients see their care. Doctors see everything before the visit begins. Administrators see the hospital. The same data, entered once.",
      "Mareez apna ilaj dekhta hai. Doctor visit shuru hone se pehle sab kuchh dekh leta hai. Admin poora hospital. Wahi data, ek hi baar darj.",
    ],
  },
  {
    numeral: "V",
    chip: ["Three portals · Fully audit-logged", "Teen portals · Poori audit-log"],
    clock: "21:00",
    when: ["That evening", "Usi shaam"],
    lead: ["Where every patient", "Jahan har mareez"],
    accent: ["is seen.", "dekha jata hai."],
    body: [
      "The invoice was raised the moment the visit was marked complete. The reminder arrives at nine. Multiply that by every clinic on the platform.",
      "Visit mukammal hote hi invoice ban gaya tha. Yaad-dehani nau baje aa jati hai. Isse platform ke har clinic se zarb dein.",
    ],
  },
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
  "radial-gradient(110% 70% at 50% 50%, #062A63 0%, #00194D 38%, #040B1F 100%)",
  "radial-gradient(120% 75% at 50% 44%, #083073 0%, #00194D 44%, #040B1F 100%)",
  "radial-gradient(120% 80% at 50% 38%, #0A3A80 0%, #041F55 50%, #040B1F 100%)",
  "radial-gradient(125% 85% at 50% 34%, #1257A8 0%, #062A63 48%, #020A1C 100%)",
  "radial-gradient(140% 95% at 50% 24%, #2F84C4 0%, #0B3E80 40%, #00133A 100%)",
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
      className="absolute inset-x-0 top-1/2 mx-auto max-w-xl -translate-y-1/2 text-center lg:mx-0 lg:text-left"
    >
      <span className="inline-flex items-center gap-2 rounded-full border border-white/14 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-[#AFC9E8]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#14C4C1]" />
        {tr(...act.chip)}
      </span>
      <p className="mono-caps mt-4 text-[11px] text-[#5EC8E6]">
        {act.clock} · {tr(...act.when)}
      </p>
      <p className="font-display mt-4 text-[2rem] font-black leading-[1.08] tracking-tight text-white sm:text-5xl">
        {tr(...act.lead)}{" "}
        {/* The light ramp, not the brand one: `text-gradient-brand` runs deep
            blue and all but disappears on this navy. globals.css keeps
            `text-gradient-medical` for exactly this — a coloured ground. */}
        <span className="text-gradient-medical">{tr(...act.accent)}</span>
      </p>
      <p className="mt-4 max-w-md text-[0.95rem] leading-relaxed text-[#AFC9E8] sm:text-base">
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

  // The sky is a background swap rather than an interpolation: five states,
  // cross-faded by CSS, which is one property to animate instead of three.
  //
  // Clamped at *both* ends, which the first version was not. A spring does not
  // stop at its target — it overshoots and settles — so `progress` reaches
  // slightly below zero at the top of the section and slightly above one at the
  // bottom. Flooring -0.004 gives -1, and `ACTS[-1]` is undefined, which is a
  // crash on the first pixel of upward scroll rather than a wrong colour.
  const [act, setAct] = useState(0);
  useMotionValueEvent(progress, "change", (value) => {
    const index = Math.floor(value * ACTS.length);
    setAct(Math.max(0, Math.min(ACTS.length - 1, index)));
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
                  {item.clock} · {tr(...item.when)} · {tr(...item.chip)}
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
      className="relative h-[600vh]"
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

        {/* The rail. Five ticks, filled to where the reader has got to — the
            one thing on screen that says how long this goes on for, which a
            pinned scene owes anybody who cannot tell whether scrolling is
            doing anything. */}
        <div
          aria-hidden
          className="absolute right-5 top-1/2 hidden h-52 w-0.5 -translate-y-1/2 bg-white/10 sm:block"
        >
          <motion.span
            className="absolute inset-x-0 top-0 origin-top bg-gradient-to-b from-[#14C4C1] to-[#1A8FC7]"
            style={{ height: "100%", scaleY: progress }}
          />
          {ACTS.map((item, i) => (
            <span
              key={item.numeral}
              className="absolute -left-[3px] h-2 w-2 rounded-full transition-colors duration-300"
              style={{
                top: `${(i / (ACTS.length - 1)) * 100}%`,
                background: i <= act ? "#14C4C1" : "#2A3E63",
                boxShadow: i === act ? "0 0 0 4px rgba(20,196,193,0.18)" : undefined,
              }}
            />
          ))}
        </div>

        {/* The act, so a reader always knows how much day is left. */}
        <div className="mono-caps absolute left-6 top-24 flex items-center gap-3 text-[11px] text-white/55 sm:left-10">
          <span className="h-px w-6 bg-white/40" />
          <span>{tr("Act", "Hissa")}</span>
          <span className="font-display text-base text-[#5EC8E6]">{ACTS[act].numeral}</span>
        </div>

        {/* Two columns, so nothing is read through anything. The words used to
            sit on top of the picture, which meant every frame had to be legible
            over whatever the scene happened to be doing — and the compromise
            that makes is a picture too dim to read and text too dark to skim.
            Side by side, both get to be themselves. */}
        {/* Both columns carry an explicit height, and they have to. Their only
            children are absolutely positioned — five frames stacked in the same
            place, one visible at a time — and a box whose every child is out of
            flow collapses to nothing. When it did, all five headlines centred
            on a zero-height line and printed on top of each other. */}
        <div className="relative mx-auto grid h-full max-w-7xl content-center gap-6 px-6 lg:grid-cols-2 lg:items-center lg:gap-12">
          <div className="relative order-2 h-[19rem] lg:order-1 lg:h-[26rem]">
            {ACTS.map((item, i) => (
              <Frame key={item.numeral} act={item} range={ACT_WINDOWS[i]} progress={progress}>
              {i === ACTS.length - 1 && (
                <div className="pointer-events-auto mt-7 flex flex-wrap justify-center gap-3 lg:justify-start">
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

          <div className="relative order-1 h-[15rem] lg:order-2 lg:h-[26rem]">
            <StoryStage progress={progress} />
          </div>
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
