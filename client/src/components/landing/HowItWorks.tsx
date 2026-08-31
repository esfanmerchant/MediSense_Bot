"use client";

/**
 * Five steps, joined by a circuit trace that draws itself as you arrive.
 *
 * The line is the logo's own motif, routed the way a board is: a run, a jog,
 * a node, another run. It is not one long path but five segments, one per
 * step, each starting at its own icon and reaching the next — which means the
 * geometry is correct at every breakpoint without measuring anything, and the
 * draw arrives step by step instead of sweeping past all five at once.
 *
 * The mechanism is an IntersectionObserver and `stroke-dashoffset`, with
 * `pathLength={1}` doing the normalising so no path length has to be known.
 * No animation library: a 60KB dependency to move one number from 1 to 0
 * would be a poor trade on a marketing page. Under reduced motion the hook
 * reports "seen" immediately and the transition is already collapsed by the
 * global rule, so the trace is simply there, complete.
 */

import { useId } from "react";

import { Icon } from "@/components/Icon";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

import { SectionHead, Shell, useStagger } from "./parts";

/** A run, a jog to a node, a run — alternating above and below the line. */
const SEGMENT_UP = "M0 22 H30 L38 8 H62 L70 22 H100";
const SEGMENT_DOWN = "M0 22 H30 L38 36 H62 L70 22 H100";

function Connector({ index, drawn }: { index: number; drawn: boolean }) {
  const id = `hw-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const up = index % 2 === 0;

  return (
    <svg
      aria-hidden
      viewBox="0 0 100 44"
      preserveAspectRatio="none"
      // Starts at this step's icon centre (28px in) and reaches the next one:
      // one column width plus the grid gap.
      className="pointer-events-none absolute left-7 top-7 hidden h-11 w-[calc(100%+1.5rem)] -translate-y-1/2 md:block"
      fill="none"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1A8FC7" />
          <stop offset="1" stopColor="#14C4C1" />
        </linearGradient>
      </defs>
      <path
        d={up ? SEGMENT_UP : SEGMENT_DOWN}
        stroke={`url(#${id})`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        pathLength={1}
        style={{
          strokeDasharray: 1,
          strokeDashoffset: drawn ? 0 : 1,
          transition: `stroke-dashoffset 0.75s linear ${index * 300}ms`,
        }}
      />
      <circle
        cx="50"
        cy={up ? 8 : 36}
        r="2.4"
        fill="#14C4C1"
        style={{
          opacity: drawn ? 1 : 0,
          transition: `opacity 0.3s ease ${index * 300 + 420}ms`,
        }}
      />
    </svg>
  );
}

export function HowItWorks() {
  const tr = useTr();
  const { ref, className, seen: drawn } = useStagger<HTMLOListElement>(0.15);

  const steps: { icon: string; title: string; body: string }[] = [
    {
      icon: "record_voice_over",
      title: tr("Speak or type", "Bolein ya likhein"),
      body: tr(
        "Say what is wrong, in your own words.",
        "Apni takleef apne alfaz mein batayein.",
      ),
    },
    {
      icon: "psychology",
      title: tr("Symptoms are picked out", "Symptoms nikalti hain"),
      body: tr(
        "The parts that matter come back for you to check.",
        "Ahem baatein aap ke samne aa jaati hain.",
      ),
    },
    {
      icon: "hub",
      title: tr("A department is suggested", "AI department suggest karta hai"),
      body: tr(
        "It says where to go, or sends you straight on.",
        "Batata hai kahan jana hai — ya seedha aage bhej deta hai.",
      ),
    },
    {
      icon: "inventory_2",
      title: tr("It is saved to your record", "Record mein save ho jata hai"),
      body: tr(
        "It joins your history the moment you send it.",
        "Bhejte hi yeh aap ki history ka hissa ban jaata hai.",
      ),
    },
    {
      icon: "stethoscope",
      title: tr("Your doctor reads it first", "Doctor visit se pehle dekh leta hai"),
      body: tr(
        "The visit starts with your story already read.",
        "Visit shuru hoti hai aap ki kahani parhi hui.",
      ),
    },
  ];

  return (
    <section id="kaise" className="relative scroll-mt-24 overflow-hidden py-24">
      <Shell className="relative">
        <SectionHead
          eyebrow={tr("How it works", "Kaise chalta hai")}
          title={[
            tr("How this", "Yeh kaise"),
            { text: tr("actually works", "kaam karta hai"), gradient: true },
          ]}
          lede={tr(
            "One sentence from you. That is the whole of it.",
            "Aap ka ek jumla. Bas itna hi.",
          )}
        />

        <ol ref={ref} className={cx("relative mt-14 grid gap-6 md:grid-cols-5", className)}>
          {steps.map((step, index) => (
            <li key={step.title} className="relative flex gap-4 md:flex-col md:gap-0">
              {index < steps.length - 1 && <Connector index={index} drawn={drawn} />}

              {/* The mobile route is vertical, so the trace is too. */}
              {index < steps.length - 1 && (
                <span
                  aria-hidden
                  className="absolute -bottom-6 left-7 top-14 w-px origin-top md:hidden"
                  style={{
                    background: "linear-gradient(to bottom, var(--ms-azure-400), var(--ms-teal-300))",
                    transform: drawn ? "scaleY(1)" : "scaleY(0)",
                    transition: `transform 0.6s ease ${index * 200}ms`,
                  }}
                />
              )}

              {/* Each step arrives just behind the trace that reaches it, so
                  the eye follows the route rather than five boxes at once. */}
              <span
                aria-hidden
                className="bg-gradient-brand ms-pop relative z-10 grid h-14 w-14 shrink-0 place-items-center rounded-2xl p-[2px] shadow-card"
                style={{ animationDelay: `${index * 300}ms` }}
              >
                <span className="grid h-full w-full place-items-center rounded-[14px] bg-card text-primary">
                  <Icon name={step.icon} filled className="text-[24px]" />
                </span>
              </span>

              <div className="md:mt-6">
                <p
                  className="ms-fade mono-caps text-[0.6rem] text-faint"
                  style={{ animationDelay: `${index * 300 + 90}ms` }}
                >
                  {tr("Step", "Qadam")} {String(index + 1).padStart(2, "0")}
                </p>
                <h3
                  className="ms-fade mt-1.5 font-display text-[16px] font-bold leading-snug text-strong"
                  style={{ animationDelay: `${index * 300 + 150}ms` }}
                >
                  {step.title}
                </h3>
                <p
                  className="ms-fade mt-1.5 text-sm leading-relaxed text-muted"
                  style={{ animationDelay: `${index * 300 + 210}ms` }}
                >
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Shell>
    </section>
  );
}
