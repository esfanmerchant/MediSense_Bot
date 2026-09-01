"use client";

/**
 * One day, one patient. Scrolling is the clock.
 *
 * A feature list tells somebody what a product has. It does not tell them what
 * using it is like, and this product's argument is entirely about the second
 * thing: that a symptom described at eight in the morning is already on the
 * doctor's screen at half past ten, without the patient carrying anything.
 * That is a *sequence*, and a grid of cards is the one shape that cannot show a
 * sequence.
 *
 * So the page opens pinned. The scene holds still while the page scrolls
 * through it: the light moves from morning to night, a phone turns in the
 * light, and the screen on it plays Hamza's day one beat at a time. Sixty
 * seconds of scrolling and somebody has seen the whole product work.
 *
 * Three decisions worth stating, because each is a thing that usually goes
 * wrong in a scene like this:
 *
 * **Scroll drives everything; nothing runs on a timer.** The reader sets the
 * pace, can go back, and can stop on a beat and read it. An autoplaying
 * sequence would be a video, and nobody scrubs a video on a landing page.
 *
 * **Reduced motion gets the whole story, not a fallback.** Turn animation off
 * and the five beats render as five plain cards in order — the same content,
 * the same sequence, no pinning and no parallax. A person who cannot take
 * motion should not be handed a shorter argument.
 *
 * **The device is CSS, not WebGL.** `three` is in the bundle for one component
 * elsewhere; loading a renderer to rotate one rectangle would cost more than
 * the whole rest of this page. A transformed div with a real perspective is
 * indistinguishable here and costs nothing.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

import { Icon } from "@/components/Icon";
import { useTr } from "@/lib/lang";

/**
 * The five beats, and the sky each one happens under.
 *
 * The colours are the point of the whole scene: a reader does not read "08:00"
 * and picture morning, but they do feel a screen getting warmer and then
 * darker. `sky` is the ground, `glow` the sun's own colour, and `ink` the text
 * that has to stay legible against both — which is why it is stated per beat
 * rather than derived, since the flip from dark ink to light happens between
 * two specific beats and nowhere else.
 */
interface Beat {
  clock: string;
  time: [string, string];
  title: [string, string];
  body: [string, string];
  /** Where the sun sits, as a percentage across and down the sky. */
  sun: [number, number];
  sky: [string, string];
  glow: string;
  ink: "dark" | "light";
  screen: "voice" | "triage" | "chart" | "invoice" | "reminder";
}

const BEATS: Beat[] = [
  {
    clock: "08:00",
    time: ["Morning", "Subah"],
    title: ["Hamza just says what hurts", "Hamza bas bata deta hai kya taklif hai"],
    body: [
      "He holds the button and speaks. No form, no dropdown, no spelling a symptom he has never written down.",
      "Button daba kar bolta hai. Na form, na dropdown, na koi aisa lafz likhna jo us ne kabhi likha hi nahi.",
    ],
    sun: [12, 74],
    sky: ["#FFE7C4", "#CFE2F5"],
    glow: "#FFB765",
    ink: "dark",
    screen: "voice",
  },
  {
    clock: "08:05",
    time: ["Five minutes later", "Paanch minute baad"],
    title: ["It names the department, not the illness", "Woh department batata hai, bimari nahi"],
    body: [
      "The assistant never diagnoses. It reads what he said, checks it for red flags, and tells him which clinic to book.",
      "Assistant tashkhees nahi karta. Jo Hamza ne kaha usse parhta hai, khatre ki alamaat dekhta hai, aur batata hai kis clinic mein jana hai.",
    ],
    sun: [30, 50],
    sky: ["#EAF3FE", "#D3E6F8"],
    glow: "#FFD08A",
    ink: "dark",
    screen: "triage",
  },
  {
    clock: "10:30",
    time: ["Before the visit", "Visit se pehle"],
    title: ["The doctor already has it", "Doctor ke paas pehle se hai"],
    body: [
      "Hamza carries nothing. His own words, his last report and his medicines are on the chart before he sits down.",
      "Hamza kuchh nahi le kar jata. Us ke apne alfaz, pichhli report aur dawaiyan bethne se pehle chart par hain.",
    ],
    sun: [52, 26],
    sky: ["#F4F9FF", "#E3EEFA"],
    glow: "#FFF0CE",
    ink: "dark",
    screen: "chart",
  },
  {
    clock: "11:15",
    time: ["After the consultation", "Consultation ke baad"],
    title: ["The bill writes itself", "Bill khud ban jata hai"],
    body: [
      "Marking the visit complete raises the invoice in the same transaction. Nobody types an amount, so nobody mistypes one.",
      "Visit mukammal hote hi usi transaction mein invoice ban jata hai. Koi raqam likhta hi nahi, to koi galat bhi nahi likhta.",
    ],
    sun: [74, 42],
    sky: ["#F3F1FB", "#DCC9E4"],
    glow: "#FFAE7A",
    ink: "dark",
    screen: "invoice",
  },
  {
    clock: "21:00",
    time: ["That evening", "Usi shaam"],
    title: ["And it remembers for him", "Aur yaad bhi woh rakhta hai"],
    body: [
      "One dose, one reminder. The medicine his doctor prescribed this morning, at the hour it was prescribed for.",
      "Ek khurak, ek yaad-dehani. Wahi dawa jo subah doctor ne likhi, usi waqt par jis waqt ke liye likhi thi.",
    ],
    sun: [92, 84],
    sky: ["#16265A", "#070F26"],
    glow: "#4E6BD0",
    ink: "light",
    screen: "reminder",
  },
];

/** Linear blend between two `#rrggbb` strings. */
function mix(from: string, to: string, t: number): string {
  const read = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ar, ag, ab] = read(from);
  const [br, bg, bb] = read(to);
  const at = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${at(ar, br)} ${at(ag, bg)} ${at(ab, bb)})`;
}

/**
 * Where the reader is in the day, as a number.
 *
 * `index` is the beat being read and `blend` how far into the next one the
 * light has travelled — the sky moves continuously while the words change on a
 * beat, because a sentence that cross-fades is a sentence nobody finishes.
 */
function useDayProgress(steps: number, enabled: boolean) {
  const track = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState({ index: 0, blend: 0, done: 0 });

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;

    const measure = () => {
      frame = 0;
      const node = track.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const scrollable = rect.height - window.innerHeight;
      if (scrollable <= 0) return;
      // 0 when the scene pins, 1 when it releases.
      const done = Math.min(1, Math.max(0, -rect.top / scrollable));
      const position = done * (steps - 1);
      setState({
        index: Math.min(steps - 1, Math.round(position)),
        blend: position - Math.floor(position),
        done,
      });
    };

    const onScroll = () => {
      // One measurement per frame. A scroll handler that reads layout on every
      // event is how a page like this ends up janking on the phone it was
      // built to impress.
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [steps, enabled]);

  return { track, ...state };
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

/** Chrome shared by every screen, so they read as one product. */
function Screen({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-[#F6F9FC] text-[#0E1B33]">
      <div className="flex items-center gap-2 border-b border-[#DCE6F2] px-4 py-2.5">
        <span className="bg-gradient-brand h-4 w-4 rounded-[5px]" />
        <span className="text-[11px] font-bold tracking-tight">{title}</span>
        <span className="ml-auto text-[10px] font-semibold text-[#7A8CA8]">MediSense</span>
      </div>
      <div className="flex-1 space-y-2.5 overflow-hidden p-4">{children}</div>
    </div>
  );
}

function Line({ w, tone = "muted" }: { w: string; tone?: "muted" | "faint" | "strong" }) {
  const tones = { muted: "bg-[#C2D1E6]", faint: "bg-[#DCE6F2]", strong: "bg-[#0E1B33]" };
  return <span className={`block h-2 rounded-sm ${tones[tone]}`} style={{ width: w }} />;
}

function VoiceScreen() {
  const tr = useTr();
  return (
    <Screen title={tr("Health assistant", "Health assistant")}>
      <p className="text-[13px] font-semibold">{tr("Describe your symptoms", "Apni taklif batayein")}</p>
      <div className="rounded-lg border border-[#DCE6F2] bg-white p-3">
        <p className="text-[12px] leading-snug text-[#33456A]">
          “{tr("Two days chest tightness, worse when I climb stairs.", "Do din se seene mein jakran, seerhi charhne par barhti hai.")}”
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-[#0B3FA8] text-white">
          <Icon name="mic" filled className="text-[20px]" />
        </span>
        {/* A waveform, not a spinner: the point is that he is speaking. */}
        <span className="flex h-8 flex-1 items-center gap-[3px]">
          {[9, 18, 26, 14, 30, 20, 11, 24, 16, 28, 12, 22, 8, 19, 27].map((h, i) => (
            <span key={i} className="w-[3px] rounded-full bg-[#1A8FC7]" style={{ height: h }} />
          ))}
        </span>
      </div>
    </Screen>
  );
}

function TriageScreen() {
  const tr = useTr();
  return (
    <Screen title={tr("Health assistant", "Health assistant")}>
      <div className="rounded-lg border border-[#F0C98A] bg-[#FDF6EA] p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#9A6412]">
          <Icon name="info" className="text-[14px]" />
          {tr("Not a diagnosis", "Tashkhees nahi")}
        </p>
        <p className="mt-1.5 text-[12px] leading-snug text-[#33456A]">
          {tr(
            "This should be seen by a doctor today. Book with Cardiology.",
            "Aaj hi doctor ko dikhayein. Cardiology mein book karein.",
          )}
        </p>
      </div>
      <div className="rounded-lg border border-[#DCE6F2] bg-white p-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-[#7A8CA8]">
          {tr("Available today", "Aaj dastyab")}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-[#EEF4FA] text-[11px] font-bold text-[#0B3FA8]">
            EM
          </span>
          <span className="flex-1">
            <span className="block text-[12px] font-bold">Dr Esfan Merchant</span>
            <span className="block text-[11px] text-[#7A8CA8]">Cardiology · Karachi</span>
          </span>
          <span className="rounded-md bg-[#0B3FA8] px-2 py-1 text-[10px] font-bold text-white">
            11:00
          </span>
        </div>
      </div>
    </Screen>
  );
}

function ChartScreen() {
  const tr = useTr();
  return (
    <Screen title={tr("Patient chart", "Mareez ka chart")}>
      <div className="flex items-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[#EEF4FA] text-[12px] font-bold text-[#0B3FA8]">
          H
        </span>
        <span className="flex-1">
          <span className="block text-[13px] font-bold">Hamza Iqbal</span>
          <span className="block text-[10px] text-[#7A8CA8]">MRN-2026-566599</span>
        </span>
      </div>
      <div className="rounded-lg border border-[#BFE3E1] bg-[#EDF9F8] p-2.5">
        <p className="text-[10px] font-bold uppercase tracking-wider text-[#0B6B66]">
          {tr("Reported by the patient", "Mareez ne khud bataya")}
        </p>
        <p className="mt-1 text-[12px] font-semibold">
          {tr("Chest tightness — 2 days", "Seene mein jakran — 2 din")}
        </p>
      </div>
      <div className="space-y-2 rounded-lg border border-[#DCE6F2] bg-white p-2.5">
        <Line w="72%" tone="strong" />
        <Line w="90%" />
        <Line w="58%" />
        <Line w="80%" tone="faint" />
      </div>
    </Screen>
  );
}

function InvoiceScreen() {
  const tr = useTr();
  return (
    <Screen title={tr("Invoice", "Invoice")}>
      <div className="rounded-lg border border-[#DCE6F2] bg-white p-3">
        <p className="text-[10px] font-bold uppercase tracking-wider text-[#7A8CA8]">
          INV-2026-000148
        </p>
        <div className="mt-2.5 space-y-1.5 text-[11px]">
          <span className="flex justify-between">
            <span className="text-[#33456A]">{tr("Consultation", "Consultation")}</span>
            <span className="font-semibold tabular-nums">5,000.00</span>
          </span>
          <span className="flex justify-between">
            <span className="text-[#33456A]">{tr("Platform fee", "Platform fee")}</span>
            <span className="font-semibold tabular-nums">500.00</span>
          </span>
          <span className="flex justify-between border-t border-[#DCE6F2] pt-1.5">
            <span className="font-bold">{tr("Total", "Kul")}</span>
            <span className="font-bold tabular-nums">PKR 5,922.50</span>
          </span>
        </div>
      </div>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[#0B6B66]">
        <Icon name="task_alt" filled className="text-[15px]" />
        {tr("Raised automatically · due in 3 days", "Khud ba khud bana · 3 din mein waajib")}
      </p>
    </Screen>
  );
}

function ReminderScreen() {
  const tr = useTr();
  return (
    <Screen title={tr("Reminder", "Yaad-dehani")}>
      <div className="rounded-lg border border-[#DCE6F2] bg-white p-3">
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#0B3FA8]">
          <Icon name="pill" filled className="text-[14px]" />
          9:00 PM
        </p>
        <p className="mt-1.5 text-[13px] font-bold">Aspirin 75 mg</p>
        <p className="text-[11px] text-[#7A8CA8]">
          {tr("One tablet, after food", "Ek goli, khane ke baad")}
        </p>
      </div>
      <div className="flex gap-2">
        <span className="flex-1 rounded-md bg-[#0B3FA8] px-3 py-2 text-center text-[11px] font-bold text-white">
          {tr("Taken", "Le li")}
        </span>
        <span className="flex-1 rounded-md border border-[#DCE6F2] px-3 py-2 text-center text-[11px] font-bold text-[#33456A]">
          {tr("Snooze", "Baad mein")}
        </span>
      </div>
    </Screen>
  );
}

const SCREENS = {
  voice: VoiceScreen,
  triage: TriageScreen,
  chart: ChartScreen,
  invoice: InvoiceScreen,
  reminder: ReminderScreen,
} as const;

// ---------------------------------------------------------------------------

export function DayInTheLife({
  primaryHref,
  primaryLabel,
}: {
  primaryHref: string;
  primaryLabel: string;
}) {
  const tr = useTr();
  const reduced = useReducedMotion();
  const { track, index, blend, done } = useDayProgress(BEATS.length, !reduced);

  const beat = BEATS[index];
  const next = BEATS[Math.min(BEATS.length - 1, index + 1)];
  const sky = [
    mix(beat.sky[0], next.sky[0], blend),
    mix(beat.sky[1], next.sky[1], blend),
  ];
  const glow = mix(beat.glow, next.glow, blend);
  const sun = [
    beat.sun[0] + (next.sun[0] - beat.sun[0]) * blend,
    beat.sun[1] + (next.sun[1] - beat.sun[1]) * blend,
  ];
  const light = beat.ink === "light";

  /**
   * Reduced motion: the same five beats, stacked and still.
   *
   * Not a summary and not a shorter page — the argument is the sequence, and
   * somebody who cannot take a pinned scene is owed the sequence too.
   */
  if (reduced) {
    return (
      <section className="border-b border-line bg-canvas">
        <div className="mx-auto max-w-4xl px-6 py-20">
          <p className="mono-caps text-xs text-primary">{tr("One day, one patient", "Ek din, ek mareez")}</p>
          <h1 className="font-display mt-3 text-4xl font-black tracking-tight text-strong sm:text-5xl">
            {tr("A symptom at eight is on the chart by ten.", "Aath baje ki taklif, das baje chart par.")}
          </h1>
          <div className="mt-10 space-y-8">
            {BEATS.map((item) => {
              const Body = SCREENS[item.screen];
              return (
                <div key={item.clock} className="grid gap-5 sm:grid-cols-[1fr_15rem] sm:items-center">
                  <div>
                    <p className="mono-caps text-xs text-primary">
                      {item.clock} · {tr(...item.time)}
                    </p>
                    <h2 className="font-display mt-1.5 text-xl font-bold text-strong">
                      {tr(...item.title)}
                    </h2>
                    <p className="mt-1.5 text-base leading-relaxed text-muted">{tr(...item.body)}</p>
                  </div>
                  <div className="h-64 overflow-hidden rounded-xl border border-line">
                    <Body />
                  </div>
                </div>
              );
            })}
          </div>
          <Link
            href={primaryHref}
            className="bg-gradient-brand mt-10 inline-flex min-h-12 items-center gap-2 rounded-lg px-6 font-bold text-white"
          >
            {primaryLabel}
          </Link>
        </div>
      </section>
    );
  }

  const Body = SCREENS[beat.screen];

  return (
    <section
      ref={track}
      aria-label={tr("One day, one patient", "Ek din, ek mareez")}
      style={{ height: `${BEATS.length * 100}vh` }}
    >
      <div
        className="sticky top-0 flex h-screen items-center overflow-hidden"
        style={{
          background: `linear-gradient(170deg, ${sky[0]}, ${sky[1]})`,
          transition: "background 200ms linear",
        }}
      >
        {/* The sun. One soft disc that travels an arc across the sky and takes
            the whole page's colour temperature with it — this, rather than any
            label, is what makes the passage of time legible. */}
        <span
          aria-hidden
          className="pointer-events-none absolute h-[38rem] w-[38rem] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
          style={{
            left: `${sun[0]}%`,
            top: `${sun[1]}%`,
            background: `radial-gradient(circle, ${glow} 0%, transparent 68%)`,
            opacity: 0.75,
          }}
        />

        <div className="relative mx-auto grid w-full max-w-6xl gap-10 px-6 lg:grid-cols-[auto_1fr_auto] lg:items-center">
          {/* The clock face of the whole scene: five marks, filled up to now. */}
          <ol className="hidden gap-0 lg:grid" aria-hidden>
            {BEATS.map((item, i) => (
              <li key={item.clock} className="flex items-start gap-3">
                <span className="flex flex-col items-center">
                  <span
                    className="h-2.5 w-2.5 rounded-full transition-colors duration-300"
                    style={{
                      background: i <= index ? "#0B3FA8" : light ? "#33456A" : "#C2D1E6",
                    }}
                  />
                  {i < BEATS.length - 1 && (
                    <span
                      className="w-px flex-1"
                      style={{ background: light ? "#33456A" : "#C2D1E6", minHeight: "3.5rem" }}
                    >
                      <span
                        className="block w-px bg-[#0B3FA8] transition-[height] duration-300"
                        style={{ height: i < index ? "100%" : i === index ? `${blend * 100}%` : "0%" }}
                      />
                    </span>
                  )}
                </span>
                <span
                  className="mono-caps -mt-1 text-[11px] transition-opacity duration-300"
                  style={{
                    color: light ? "#EAF1FB" : "#0E1B33",
                    opacity: i === index ? 1 : 0.4,
                  }}
                >
                  {item.clock}
                </span>
              </li>
            ))}
          </ol>

          <div style={{ color: light ? "#EAF1FB" : "#0E1B33" }}>
            <p className="mono-caps text-xs" style={{ color: light ? "#8FB6FF" : "#0B3FA8" }}>
              {beat.clock} · {tr(...beat.time)}
            </p>
            {/* Only the first beat carries the page's headline. After that the
                beat's own title is the heading — one h1 per page, and the
                reader is inside a story rather than at the top of one. */}
            {index === 0 ? (
              <h1 className="font-display mt-3 max-w-xl text-4xl font-black leading-[1.05] tracking-tight sm:text-5xl">
                {tr(
                  "A symptom at eight is on the chart by ten.",
                  "Aath baje ki taklif, das baje chart par.",
                )}
              </h1>
            ) : (
              <p className="font-display mt-3 max-w-xl text-3xl font-black leading-[1.1] tracking-tight sm:text-4xl">
                {tr(...beat.title)}
              </p>
            )}
            <p
              className="mt-4 max-w-md text-base leading-relaxed sm:text-lg"
              style={{ color: light ? "#B9C8E6" : "#33456A" }}
            >
              {tr(...beat.body)}
            </p>

            {index === 0 && (
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Link
                  href={primaryHref}
                  className="bg-gradient-brand inline-flex min-h-12 items-center gap-2 rounded-lg px-6 font-bold text-white"
                >
                  {primaryLabel}
                  <Icon name="arrow_forward" className="text-[20px]" />
                </Link>
                <span className="text-sm" style={{ color: "#33456A" }}>
                  {tr("Scroll to follow the day", "Din dekhne ke liye scroll karein")}
                </span>
              </div>
            )}
          </div>

          {/* The device. Perspective on the parent, rotation on the child, so
              the screen inside is a real plane rather than a squashed image. */}
          <div className="mx-auto" style={{ perspective: "1400px" }}>
            <div
              className="relative h-[30rem] w-[15rem] rounded-[2rem] border border-white/50 bg-white/25 p-2 shadow-[0_40px_80px_-30px_rgba(6,20,50,0.55)] backdrop-blur-md"
              style={{
                transform: `rotateY(${18 - done * 30}deg) rotateX(${6 - done * 8}deg) translateZ(0)`,
                transition: "transform 220ms cubic-bezier(0.22,1,0.36,1)",
              }}
            >
              <div className="h-full overflow-hidden rounded-[1.6rem]">
                <Body />
              </div>
              <span
                aria-hidden
                className="absolute left-1/2 top-3.5 h-1 w-12 -translate-x-1/2 rounded-full bg-black/15"
              />
            </div>
          </div>
        </div>

        {/* Progress, for anyone who wants to know how much day is left. */}
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 bg-black/5"
        >
          <span
            className="bg-gradient-brand block h-full"
            style={{ width: `${done * 100}%` }}
          />
        </span>
      </div>
    </section>
  );
}
