"use client";

/**
 * The headline, drawn instead of written.
 *
 * The sentence beside this says a record finally ends up in one place. A card of
 * live vitals did not say that — it said "here is a monitor", which is one of
 * the three things, sitting on its own, being exactly the problem the sentence
 * claims to solve.
 *
 * So: a lab report, a prescription and a set of vitals arrive from three
 * different directions and settle into one patient record. Nothing types, no
 * word rotates. The meaning is in the motion, and if the motion never runs the
 * picture is still true — three things, in one card.
 *
 * **It plays once.** This is the top of the page and a person is reading the
 * headline next to it; a loop would pull their eye back every few seconds, and
 * on a health page a thing that keeps twitching reads as an alarm. Reduced
 * motion gets the settled record with no animation scheduled at all, which is
 * the same picture a second later.
 */

import { motion, useReducedMotion } from "framer-motion";

import { Icon } from "@/components/Icon";
import { LogoMark } from "@/components/brand/Logo";
import { cx } from "@/components/ui";
import { useTr } from "@/lib/lang";

/** Where each piece comes in from, and when. */
interface Arrival {
  icon: string;
  title: string;
  detail: string;
  /** The value that makes it a real record entry rather than a label. */
  value: string;
  /** Start offset, in pixels — a different direction for each. */
  from: { x: number; y: number; rotate: number };
  delay: number;
  tone: "primary" | "accent" | "stable";
}

const TONE: Record<Arrival["tone"], string> = {
  primary: "text-primary",
  accent: "text-accent",
  stable: "text-stable",
};

function Row({ item, still }: { item: Arrival; still: boolean }) {
  return (
    <motion.li
      // Off its mark and turned slightly, so each one reads as having come from
      // somewhere rather than having faded up in place.
      initial={
        still
          ? false
          : { opacity: 0, x: item.from.x, y: item.from.y, rotate: item.from.rotate, scale: 0.92 }
      }
      animate={{ opacity: 1, x: 0, y: 0, rotate: 0, scale: 1 }}
      transition={{
        delay: item.delay,
        duration: 0.72,
        // A settle, not a bounce: it slows into place and stops. A spring that
        // overshoots would make a medical record look springy.
        ease: [0.16, 1, 0.3, 1],
      }}
      className="flex items-center gap-3 rounded-xl border border-line bg-card px-3.5 py-3 shadow-sm"
    >
      <span
        aria-hidden
        className={cx(
          "bg-gradient-soft grid h-9 w-9 shrink-0 place-items-center rounded-lg",
          TONE[item.tone],
        )}
      >
        <Icon name={item.icon} className="text-[19px]" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-strong">{item.title}</span>
        <span className="block truncate text-[11.5px] text-muted">{item.detail}</span>
      </span>

      <span className="shrink-0 font-mono text-[12px] font-bold tabular-nums text-strong">
        {item.value}
      </span>
    </motion.li>
  );
}

export function RecordAssembly() {
  const tr = useTr();
  const still = useReducedMotion() === true;

  const arrivals: Arrival[] = [
    {
      icon: "labs",
      title: tr("Blood test", "Khoon ka test"),
      detail: tr("Lab report · 12 Aug", "Lab report · 12 Aug"),
      value: "Hb 13.2",
      from: { x: -132, y: -84, rotate: -9 },
      delay: 0.35,
      tone: "primary",
    },
    {
      icon: "prescriptions",
      title: tr("Metformin 500mg", "Metformin 500mg"),
      detail: tr("Prescription · Dr Iyer", "Nuskha · Dr Iyer"),
      value: tr("After dinner", "Khane ke baad"),
      from: { x: 148, y: 12, rotate: 8 },
      delay: 0.62,
      tone: "accent",
    },
    {
      icon: "vital_signs",
      title: tr("Vitals", "Vitals"),
      detail: tr("Recorded at the clinic", "Clinic par darj"),
      value: "72 · 98% · 36.8°",
      from: { x: -108, y: 96, rotate: 7 },
      delay: 0.89,
      tone: "stable",
    },
  ];

  return (
    <div className="animate-float-slow relative">
      {/* The card's own light, so it reads as raised rather than pasted on. */}
      <div
        aria-hidden
        className="bg-gradient-soft pointer-events-none absolute -inset-8 rounded-[2.5rem] opacity-70 blur-2xl"
      />

      <motion.div
        // `overflow` stays visible on purpose: the rows begin outside these
        // bounds, and clipping them would delete the only thing being shown.
        initial={still ? false : { opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="relative rounded-[1.75rem] border border-line bg-card p-5 shadow-float"
      >
        {/* Whose record this is. Present from the first frame, so the pieces
            arrive *into* something rather than assembling out of nothing. */}
        <div className="flex items-center gap-3 border-b border-line pb-4">
          <span className="bg-gradient-brand grid h-10 w-10 shrink-0 place-items-center rounded-xl shadow-sm">
            <LogoMark onDark className="h-4 w-auto" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-display text-[15px] font-bold text-strong">
              {tr("Ayesha Khan", "Ayesha Khan")}
            </span>
            <span className="block truncate font-mono text-[11px] text-muted">MRN-2026-0148</span>
          </span>
          <span className="mono-caps shrink-0 text-[0.55rem] text-faint">
            {tr("One record", "Ek record")}
          </span>
        </div>

        <ul className="mt-4 space-y-2.5">
          {arrivals.map((item) => (
            <Row key={item.title} item={item} still={still} />
          ))}
        </ul>

        {/* The closing line arrives last, once there is something to close. */}
        <motion.p
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.5, duration: 0.5 }}
          className="mt-4 flex items-center gap-2 border-t border-line pt-3.5 text-[12px] text-muted"
        >
          <Icon name="check_circle" className="shrink-0 text-[16px] text-stable" />
          {tr(
            "Every visit, in one place.",
            "Har visit, ek hi jagah.",
          )}
        </motion.p>
      </motion.div>
    </div>
  );
}
