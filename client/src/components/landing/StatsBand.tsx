"use client";

/**
 * The band under the hero: four numbers, and nothing else.
 *
 * Every number here is a fact about the build rather than a claim about the
 * market — tests that run, endpoints that are guarded, portals that exist, the
 * idle timeout in minutes. A landing page that opens with "10,000 happy
 * patients" on a system nobody has used yet is lying in its first breath; four
 * checkable facts are worth more than one impressive one.
 *
 * They are set as readouts rather than as marketing figures: monospaced
 * digits over a trace that draws itself, the way a monitor states a value.
 * Four gradient numbers on a bordered strip would have belonged to any
 * startup; a readout belongs to this one.
 *
 * The count-up is armed slightly before the band reaches the viewport, so the
 * reset to zero happens off screen and the reader only ever sees the climb.
 */

import { useId } from "react";

import { CountUp } from "@/components/ui";
import { useTr } from "@/lib/lang";

import { GradientRule, Shell, useStagger } from "./parts";

/** A short trace under each readout, drawn once as the band arrives. */
function Baseline({ seen, delay }: { seen: boolean; delay: number }) {
  const id = `sb-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      aria-hidden
      viewBox="0 0 120 16"
      preserveAspectRatio="none"
      className="mt-3 h-4 w-full"
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
        d="M0 9 H44 L48 9 L52 3 L57 14 L61 9 H120"
        stroke={`url(#${id})`}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        style={{
          strokeDasharray: 1,
          strokeDashoffset: seen ? 0 : 1,
          transition: `stroke-dashoffset 1.1s cubic-bezier(0.16,1,0.3,1) ${delay}ms`,
        }}
      />
    </svg>
  );
}

export function StatsBand() {
  const tr = useTr();
  // One observer for both jobs: it arms the count-up before the band arrives
  // (so the reset to zero is never watchable) and releases the text motion.
  const { ref, className, seen } = useStagger<HTMLDivElement>(0, "0px 0px 20% 0px");

  const stats: { value: number; unit?: string; label: string; caption: string }[] = [
    {
      value: 734,
      label: tr("automated tests", "khudkar tests"),
      caption: tr("run against a live database", "asal database par chalte hain"),
    },
    {
      value: 87,
      label: tr("secured endpoints", "mehfooz endpoints"),
      caption: tr("every one behind a permission", "har ek ijazat ke peeche"),
    },
    {
      value: 3,
      label: tr("role-based portals", "role ke mutabiq portals"),
      caption: tr("patient, doctor, admin", "mareez, doctor, admin"),
    },
    {
      value: 2,
      unit: "min",
      label: tr("shared-screen sign-out", "mushtarka screen sign-out"),
      caption: tr("enforced by the server", "server khud lagoo karta hai"),
    },
  ];

  return (
    <section className="relative overflow-hidden border-y border-line bg-card">
      {/* On white a plain card band is a white rectangle between two white
          rectangles. A wash of the ramp at a twelfth of its strength is the
          difference between a section and a seam. */}
      <div
        aria-hidden
        className="bg-gradient-soft pointer-events-none absolute inset-0 opacity-60"
      />
      <Shell className="relative">
        <div ref={ref} className={className}>
          <GradientRule className="max-w-[9rem]" />
          <div className="grid grid-cols-2 md:grid-cols-4 md:divide-x md:divide-line">
            {stats.map((stat, index) => (
              <div
                key={stat.label}
                className="group px-3 py-9 transition-transform duration-300 ease-out hover:-translate-y-0.5 md:px-7"
              >
                <p
                  className="ms-pop mono-caps text-[10px] text-faint"
                  style={{ animationDelay: `${index * 90}ms` }}
                >
                  {stat.label}
                </p>
                <p
                  className="ms-pop mt-2 flex items-baseline gap-1 font-mono text-[2.5rem] font-bold leading-none tabular-nums text-strong"
                  style={{ animationDelay: `${index * 90 + 70}ms` }}
                >
                  {seen ? <CountUp value={stat.value} /> : stat.value}
                  {stat.unit && (
                    <span className="text-[1.25rem] font-semibold text-accent">{stat.unit}</span>
                  )}
                </p>
                <Baseline seen={seen} delay={index * 140} />
                <p
                  className="ms-fade mt-1 text-[13px] leading-snug text-muted"
                  style={{ animationDelay: `${index * 90 + 220}ms` }}
                >
                  {stat.caption}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Shell>
    </section>
  );
}
