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
import { GradientText } from "@/components/brand/GradientText";
import { useTr } from "@/lib/lang";

import { SectionHead, Shell, useInView } from "./parts";

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
  const [ref, drawn] = useInView<HTMLOListElement>(0.15);

  const steps: { icon: string; title: string; body: string }[] = [
    {
      icon: "record_voice_over",
      title: tr("Speak or type", "Bolein ya likhein"),
      body: tr(
        "Say what is wrong in your own words, or type it. Speech becomes text on your device.",
        "Apni takleef apne alfaz mein bolein ya likhein. Awaaz aap ke apne device par likhai banti hai.",
      ),
    },
    {
      icon: "psychology",
      title: tr("Symptoms are picked out", "Symptoms nikalti hain"),
      body: tr(
        "The parts that matter are pulled out of the sentence and shown back to you first.",
        "Jumle se ahem baatein alag ki jaati hain aur pehle aap ko hi dikhai jaati hain.",
      ),
    },
    {
      icon: "hub",
      title: tr("A department is suggested", "AI department suggest karta hai"),
      body: tr(
        "The assistant proposes where to go — and escalates instead when it sounds serious.",
        "Assistant batata hai kahan jana hai — aur baat sangeen lage to seedha doctor ki taraf bhejta hai.",
      ),
    },
    {
      icon: "inventory_2",
      title: tr("It is saved to your record", "Record mein save ho jata hai"),
      body: tr(
        "Nothing is retyped later. The note joins your history the moment you send it.",
        "Baad mein kuchh dobara likhna nahi parta. Bhejte hi yeh baat aap ki history ka hissa ban jaati hai.",
      ),
    },
    {
      icon: "stethoscope",
      title: tr("Your doctor reads it first", "Doctor visit se pehle dekh leta hai"),
      body: tr(
        "The visit starts with your story already read, not with the same three questions.",
        "Visit ka aaghaz aap ki kahani parh kar hota hai — wahi teen sawal dobara nahi.",
      ),
    },
  ];

  return (
    <section id="kaise" className="scroll-mt-24 py-24">
      <Shell>
        <SectionHead
          eyebrow={tr("How it works", "Kaise chalta hai")}
          title={
            <>
              {tr("How this", "Yeh kaise")}{" "}
              <GradientText>{tr("actually works", "kaam karta hai")}</GradientText>
            </>
          }
          lede={tr(
            "One sentence from you, and it is already where it needs to be by the time you sit down.",
            "Aap ka ek jumla — aur baithne se pehle hi woh apni sahi jagah pahunch chuka hota hai.",
          )}
        />

        <ol ref={ref} className="relative mt-14 grid gap-6 md:grid-cols-5">
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

              <span
                aria-hidden
                className="bg-gradient-brand relative z-10 grid h-14 w-14 shrink-0 place-items-center rounded-2xl p-[2px] shadow-card"
              >
                <span className="grid h-full w-full place-items-center rounded-[14px] bg-card text-primary">
                  <Icon name={step.icon} filled className="text-[24px]" />
                </span>
              </span>

              <div className="md:mt-6">
                <p className="mono-caps text-[0.6rem] text-faint">
                  {tr("Step", "Qadam")} {String(index + 1).padStart(2, "0")}
                </p>
                <h3 className="mt-1.5 font-display text-[16px] font-bold leading-snug text-strong">
                  {step.title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Shell>
    </section>
  );
}
