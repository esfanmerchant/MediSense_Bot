"use client";

/**
 * The hero.
 *
 * It used to be a navy slab with a WebGL heartbeat behind it. This one is on
 * the light canvas, because the promise of the product is *relief*, and a
 * worried person reads calm faster from daylight than from a lit control room.
 * The brand still runs through it: the mesh under the whole band, the circuit
 * field held to the right 45% where it frames the device rather than crowding
 * the sentence, and the pulse itself demoted to a single rule under the
 * headline. The ECG belongs *near* the words, never behind them — a line
 * moving under body text is the fastest way to make a health page feel unwell.
 *
 * The deliberate risk stays: the device card shows the assistant *refusing to
 * reassure* someone with chest pain. Leading with the most cautious moment
 * this product has is not the obvious sales choice — it is the single most
 * convincing thing the system does.
 */

import { useReducedMotion } from "framer-motion";
import Link from "next/link";
import { Fragment, useId, useRef, type MouseEvent } from "react";

import { Icon } from "@/components/Icon";
import { CircuitNodes } from "@/components/brand/CircuitNodes";
import { EcgLine } from "@/components/brand/EcgLine";
import { GradientText } from "@/components/brand/GradientText";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

import { Shell } from "./parts";

/* ------------------------------------------------------------------ */
/* Headline                                                            */
/* ------------------------------------------------------------------ */

/**
 * One line of the headline, its words rising out of a mask in sequence.
 *
 * `start` continues the stagger across lines, so the whole sentence reads as
 * one movement instead of three restarts. The animation is CSS, not JS, for a
 * specific reason: these words sit inside a `background-clip: text` span, and
 * a compositor-promoted transform inside one of those is how gradient
 * headlines end up invisible. A plain keyframe stays in the same paint.
 */
function Line({
  text,
  start,
  className,
}: {
  text: string;
  start: number;
  className?: string;
}) {
  const words = text.split(" ");
  return (
    <span className={cx("ms-line", className)}>
      {words.map((word, index) => (
        // The space lives between the spans, not inside one: trailing white
        // space at the end of an inline-block is dropped, and the headline
        // would set itself as one long word.
        <Fragment key={`${word}-${index}`}>
          {index > 0 && " "}
          <span
            className="ms-word"
            style={{ animationDelay: `${(start + index) * 60 + 120}ms` }}
          >
            {word}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Device card                                                         */
/* ------------------------------------------------------------------ */

/** A 40px sparkline in the brand ramp, with a highlight running along it. */
function Sparkline({ points }: { points: string }) {
  const id = `sp-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      className="mt-3 h-10 w-full"
      fill="none"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0B3FA8" />
          <stop offset="0.55" stopColor="#1A8FC7" />
          <stop offset="1" stopColor="#14C4C1" />
        </linearGradient>
      </defs>
      <path
        d={points}
        stroke={`url(#${id})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        opacity="0.5"
      />
      <path
        d={points}
        stroke={`url(#${id})`}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        className="ms-spark motion-reduce:hidden"
      />
    </svg>
  );
}

function Vital({
  label,
  value,
  unit,
  icon,
  points,
}: {
  label: string;
  value: string;
  unit: string;
  icon: string;
  points: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-sunken p-2.5 sm:p-3.5">
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
        <span className="font-mono text-[1.35rem] font-semibold leading-none tracking-tight text-strong sm:text-[2rem]">
          {value}
        </span>
        <span className="text-xs text-faint">{unit}</span>
      </p>
      <Sparkline points={points} />
    </div>
  );
}

function DeviceCard() {
  const tr = useTr();
  const reduced = useReducedMotion();
  const card = useRef<HTMLDivElement | null>(null);

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
    <div className="animate-float-slow">
      <div
        ref={card}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        className="tilt rounded-2xl border border-line bg-card p-5"
        style={{ boxShadow: "var(--shadow-float), var(--glow)" }}
      >
        <div className="flex items-center gap-2 pb-4">
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

        <div className="grid grid-cols-3 gap-2 sm:gap-2.5">
          <Vital
            label={tr("Heart rate", "Dil ki dharkan")}
            value="72"
            unit="bpm"
            icon="favorite"
            points="M2 28 L14 24 L26 30 L38 12 L50 26 L62 20 L74 30 L86 16 L98 22"
          />
          <Vital
            label="SpO₂"
            value="98"
            unit="%"
            icon="pulmonology"
            points="M2 22 L14 18 L26 24 L38 16 L50 20 L62 12 L74 22 L86 14 L98 18"
          />
          <Vital
            label={tr("Temp", "Bukhaar")}
            value="36.8"
            unit="°C"
            icon="thermostat"
            points="M2 26 L14 28 L26 20 L38 24 L50 14 L62 22 L74 18 L86 26 L98 20"
          />
        </div>

        {/* The assistant refusing to reassure — the money shot. */}
        <div className="mt-4 rounded-xl border border-line bg-sunken p-4">
          <p className="bg-gradient-brand ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm text-white shadow-sm">
            {tr(
              "I have chest pain going down my left arm",
              "Seenay mein dard hai jo baayen baazu tak ja raha hai",
            )}
          </p>
          <div className="mt-3 rounded-lg border border-critical bg-critical-soft px-4 py-3">
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

export function Hero({
  primaryHref,
  primaryLabel,
}: {
  primaryHref: string;
  primaryLabel: string;
}) {
  const tr = useTr();

  const line1 = tr("Your health,", "Aap ki sehat,");
  const line2 = tr("finally in", "aakhirkar ek");
  const line3 = tr("one place.", "jagah par.");
  const words1 = line1.split(" ").length;
  const words2 = line2.split(" ").length;

  const trust = [
    tr("No card needed", "Card ki zaroorat nahi"),
    tr("No phone calls", "Phone calls nahi"),
    tr("Your data stays yours", "Aap ka data aap ka hi rehta hai"),
  ];

  return (
    <section className="mesh-light relative overflow-hidden bg-canvas">
      {/* The circuit field frames the device and stops well short of the
          sentence: decoration behind reading matter is a readability tax. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 hidden w-[45%] lg:block"
        style={{
          maskImage: "linear-gradient(to left, rgb(0 0 0 / 0.9), transparent 88%)",
          WebkitMaskImage: "linear-gradient(to left, rgb(0 0 0 / 0.9), transparent 88%)",
        }}
      >
        <CircuitNodes density="low" />
      </div>

      <Shell className="relative grid gap-14 pb-20 pt-[116px] lg:grid-cols-[1.02fr_0.98fr] lg:items-center lg:gap-16 lg:pb-28 lg:pt-[150px]">
        <div className="max-w-[36rem]">
          <p className="pop-in mono-caps inline-flex items-center gap-2 rounded-full border border-line bg-card px-3.5 py-1.5 text-[0.65rem] text-accent shadow-sm">
            <span aria-hidden className="bg-gradient-brand animate-breathe h-1.5 w-1.5 rounded-full" />
            {tr("Smart Healthcare Management", "Smart Healthcare Management")}
          </p>

          <h1 className="mt-7 font-display text-[2.4rem] font-bold leading-[1.05] tracking-tight sm:text-[3.4rem] xl:text-[4rem]">
            <Line text={line1} start={0} className="text-strong" />
            <GradientText>
              <Line text={line2} start={words1} />
              <Line text={line3} start={words1 + words2} />
            </GradientText>
          </h1>

          {/* The pulse, as a rule rather than a background. */}
          <div className="mt-6 max-w-[26rem]">
            <EcgLine width={2} height={22} speed={2.6} />
          </div>

          <p className="mt-6 max-w-[52ch] text-[17px] leading-relaxed text-muted">
            {tr(
              "Appointments, records, prescriptions, vitals and bills — with an assistant that answers in plain language and knows when to send you to a doctor instead.",
              "Appointments, records, nuskhe, vitals aur bills — aur ek assistant jo aasan zabaan mein jawab deta hai, aur yeh bhi jaanta hai ke kab jawab dene ke bajaye aap ko doctor ke paas bhejna hai.",
            )}
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href={primaryHref}
              className="btn-gradient btn-shine group inline-flex min-h-[52px] items-center gap-2 rounded-xl px-6 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {primaryLabel}
              <Icon
                name="arrow_forward"
                className="text-[20px] transition-transform duration-200 group-hover:translate-x-1"
              />
            </Link>
            <Link
              href="#kya-karta-hai"
              className="ms-ghost-cta inline-flex min-h-[52px] items-center gap-2 rounded-xl px-6 text-base font-semibold text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {tr("See what it does", "Dekhein yeh kya karta hai")}
            </Link>
          </div>

          {/* The three objections that stop a signup, in the order they occur
              to someone hovering over the button. */}
          <ul className="mt-10 flex flex-wrap gap-x-7 gap-y-3">
            {trust.map((label) => (
              <li key={label} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="bg-gradient-brand grid h-6 w-6 shrink-0 place-items-center rounded-full text-white shadow-sm"
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
