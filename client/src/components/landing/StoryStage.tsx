"use client";

/**
 * The picture half of the story: five drawings, scrubbed by scroll.
 *
 * This replaces a WebGL particle field, and the reason is worth writing down.
 * Twenty-four thousand additive points morphing between shapes is an
 * impressive thing to build and an unreadable thing to look at: a cloud has no
 * edge, and without an edge there is no silhouette, and without a silhouette a
 * viewer cannot say what they are looking at. The test for a scroll story is
 * whether somebody understands it with the captions covered, and the cloud
 * failed that test.
 *
 * So everything here is drawn — SVG strokes and real interface, both of which
 * have outlines. An ECG line draws itself; the line folds into the MediSense
 * mark; a report, a prescription and a vitals tile fly in and dock onto it; the
 * mark opens into three portals; the portals become a grid of clinics. Each act
 * is one clear idea and one clear shape.
 *
 * It is also smaller, sharper on every display, works with no GPU at all, and
 * cannot fail the way a WebGL context can.
 *
 * Everything is driven from a single scroll `MotionValue`, so scrubbing
 * backwards is exact rather than approximate, and nothing runs on a timer
 * except the heartbeat in act one.
 */

import { motion, useTransform, type MotionValue } from "framer-motion";

import { Icon } from "@/components/Icon";
import { useTr } from "@/lib/lang";

/** Where each act begins and ends along the whole track. */
export const ACT_SPAN = 1 / 5;

/** Fades a layer in over the first fifth of its act and out over the last. */
function useActOpacity(progress: MotionValue<number>, act: number, hold = 0) {
  const start = act * ACT_SPAN;
  const end = start + ACT_SPAN;
  return useTransform(
    progress,
    [start - 0.02, start + 0.045, end - 0.05 + hold, end - 0.005 + hold],
    [0, 1, 1, 0],
  );
}

/* -------------------------------------------------------------------------- */
/* Act I — a heartbeat, and the trace it leaves                                */
/* -------------------------------------------------------------------------- */

/**
 * The waveform the brand is built on, drawn by the scroll.
 *
 * `stroke-dashoffset` from the full length to zero is the oldest trick in SVG
 * and still the clearest: the line is not revealed, it is *written*, left to
 * right, at the speed the reader scrolls. Nobody has to be told it is a
 * heartbeat.
 */
function EcgLine({ progress }: { progress: MotionValue<number> }) {
  const LENGTH = 1180;
  const drawn = useTransform(progress, [0.02, 0.34], [LENGTH, 0]);
  const opacity = useTransform(progress, [0.0, 0.05, 0.52, 0.62], [0, 1, 1, 0.16]);

  return (
    <motion.svg
      viewBox="0 0 720 200"
      className="absolute inset-x-0 top-1/2 h-auto w-full -translate-y-1/2"
      style={{ opacity }}
      aria-hidden
    >
      <defs>
        <linearGradient id="story-trace" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#1462C4" />
          <stop offset="55%" stopColor="#1A8FC7" />
          <stop offset="100%" stopColor="#14C4C1" />
        </linearGradient>
      </defs>
      <motion.path
        d="M0 100 H210 l14 -6 l14 12 l16 -78 l18 132 l16 -60 l14 0 H430 l18 -22 l16 22 H720"
        fill="none"
        stroke="url(#story-trace)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={LENGTH}
        style={{ strokeDashoffset: drawn }}
      />
    </motion.svg>
  );
}

/** The single point of light the whole story starts from. */
function Heartbeat({ progress }: { progress: MotionValue<number> }) {
  const opacity = useTransform(progress, [0, 0.02, 0.12, 0.17], [1, 1, 1, 0]);
  const x = useTransform(progress, [0, 0.17], ["0%", "38%"]);

  return (
    <motion.div
      aria-hidden
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ opacity, x }}
    >
      {/* Two rings on a two-second cycle, which is sixty a minute. The only
          thing on this page that runs on a clock rather than on the scroll —
          because a pulse that stops when you stop scrolling is not a pulse. */}
      <span className="story-ring absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#14C4C1]" />
      <span className="story-ring story-ring-late absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#14C4C1]" />
      <span className="story-beat block h-4 w-4 rounded-full bg-[#14C4C1] shadow-[0_0_28px_8px_rgba(20,196,193,0.45)]" />
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Act II — a voice, becoming symptoms                                         */
/* -------------------------------------------------------------------------- */

const BARS = [14, 26, 38, 22, 46, 30, 52, 34, 44, 20, 36, 28, 48, 24, 16];

const SYMPTOMS: [string, string][] = [
  ["Chest tightness", "Seene mein jakran"],
  ["Two days", "Do din"],
  ["Worse on stairs", "Seerhi par barhti hai"],
];

/**
 * One chip, in its own component.
 *
 * Not inlined into the map above: a hook called inside a loop is a hook whose
 * call order changes with the data, and React counts on that order never
 * changing. Three chips is three components.
 */
function SymptomChip({
  progress,
  symptom,
  index,
}: {
  progress: MotionValue<number>;
  symptom: [string, string];
  index: number;
}) {
  const tr = useTr();
  const from = 0.26 + index * 0.02;
  const opacity = useTransform(progress, [from, from + 0.05], [0, 1]);
  const y = useTransform(progress, [from, from + 0.05], [14, 0]);

  return (
    <motion.span
      className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-[#0A1733]/80 px-3 py-1.5 text-xs font-semibold text-[#DCEBFF]"
      style={{ opacity, y }}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-[#14C4C1]" />
      {tr(...symptom)}
    </motion.span>
  );
}

/**
 * Bars that collapse into the line.
 *
 * The act is "it listens", and listening is the bars *going into* the trace
 * rather than sitting beside it. They flatten to nothing as the chips appear,
 * so the eye reads one thing turning into another.
 */
function Voice({ progress }: { progress: MotionValue<number> }) {
  const opacity = useActOpacity(progress, 1);
  const flatten = useTransform(progress, [0.24, 0.35], [1, 0.06]);

  return (
    <motion.div
      className="absolute inset-x-0 top-1/2 -translate-y-1/2"
      style={{ opacity }}
      aria-hidden
    >
      <div className="flex items-center justify-center gap-[5px]">
        {BARS.map((h, i) => (
          <motion.span
            key={i}
            className="w-[4px] rounded-full bg-gradient-to-b from-[#14C4C1] to-[#1462C4]"
            style={{ height: h * 1.5, scaleY: flatten }}
          />
        ))}
      </div>

      <div className="mt-10 flex flex-wrap justify-center gap-2">
        {SYMPTOMS.map((symptom, i) => (
          <SymptomChip key={symptom[0]} progress={progress} symptom={symptom} index={i} />
        ))}
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Act III — the mark, and what docks onto it                                  */
/* -------------------------------------------------------------------------- */

/** The logo's rounded cross, with the pulse running through it. */
function Mark({ progress }: { progress: MotionValue<number> }) {
  const opacity = useTransform(progress, [0.36, 0.44, 0.62, 0.68], [0, 1, 1, 0]);
  const scale = useTransform(progress, [0.36, 0.46], [0.72, 1]);

  return (
    <motion.svg
      viewBox="0 0 200 200"
      className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 sm:h-48 sm:w-48"
      style={{ opacity, scale }}
      aria-hidden
    >
      <defs>
        <linearGradient id="story-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0B3FA8" />
          <stop offset="55%" stopColor="#1A8FC7" />
          <stop offset="100%" stopColor="#14C4C1" />
        </linearGradient>
      </defs>
      {/* Two rounded bars crossed — the mark itself, not an approximation of
          it, so the moment the record forms it is unmistakably this product. */}
      <path
        d="M74 26h52a20 20 0 0 1 20 20v28h28a20 20 0 0 1 20 20v52a20 20 0 0 1-20 20h-28v28a20 20 0 0 1-20 20H74a20 20 0 0 1-20-20v-28H26a20 20 0 0 1-20-20V94a20 20 0 0 1 20-20h28V46a20 20 0 0 1 20-20Z"
        fill="url(#story-mark)"
        opacity="0.16"
        stroke="url(#story-mark)"
        strokeWidth="2.5"
      />
      <path
        d="M18 104h34l10-22 16 46 12-30 10 6h82"
        fill="none"
        stroke="#14C4C1"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </motion.svg>
  );
}

const DOCKING: {
  icon: string;
  label: [string, string];
  detail: string;
  from: [number, number];
  at: [number, number];
  window: [number, number];
}[] = [
  {
    icon: "lab_panel",
    label: ["Lab report · read", "Lab report · parh li"],
    detail: "CBC · 12 values",
    from: [-330, -150],
    at: [-118, -92],
    window: [0.4, 0.47],
  },
  {
    icon: "prescriptions",
    label: ["Prescription", "Nuskha"],
    detail: "Amlodipine 5 mg",
    from: [340, -20],
    at: [122, -14],
    window: [0.45, 0.52],
  },
  {
    icon: "monitor_heart",
    label: ["Vitals", "Vitals"],
    detail: "SpO₂ 98% · HR 78",
    from: [-320, 170],
    at: [-114, 92],
    window: [0.5, 0.57],
  },
];

/** One card, so its three hooks are not called inside a loop. */
function DockCard({
  progress,
  item,
}: {
  progress: MotionValue<number>;
  item: (typeof DOCKING)[number];
}) {
  const tr = useTr();
  const x = useTransform(progress, item.window, [item.from[0], item.at[0]]);
  const y = useTransform(progress, item.window, [item.from[1], item.at[1]]);
  const opacity = useTransform(progress, [item.window[0], item.window[0] + 0.02], [0, 1]);

  return (
    <motion.div
      className="absolute left-1/2 top-1/2 w-36 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/15 bg-[#0A1733]/85 p-2.5 backdrop-blur-sm"
      style={{ x, y, opacity }}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#5EC8E6]">
        <Icon name={item.icon} className="text-[15px]" />
        {tr(...item.label)}
      </p>
      <p className="mt-1 text-sm font-semibold text-[#DCEBFF]">{item.detail}</p>
    </motion.div>
  );
}

/**
 * Three things flying in and docking onto the mark.
 *
 * The act's whole sentence is "and turns it into a record", and a record is
 * made of things arriving from elsewhere. Each card travels from off-screen to
 * a fixed berth beside the mark and stops there — motion with a destination,
 * rather than drift.
 */
function Docking({ progress }: { progress: MotionValue<number> }) {
  const opacity = useTransform(progress, [0.38, 0.46, 0.62, 0.68], [0, 1, 1, 0]);

  return (
    <motion.div className="absolute inset-0" style={{ opacity }} aria-hidden>
      {DOCKING.map((item) => (
        <DockCard key={item.detail} progress={progress} item={item} />
      ))}
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Act IV — one record, three portals                                          */
/* -------------------------------------------------------------------------- */

const PORTALS: {
  title: [string, string];
  rows: [string, string][];
  offset: number;
  tilt: number;
}[] = [
  {
    title: ["Patient", "Mareez"],
    rows: [
      ["Next visit · 11:00", "Agli visit · 11:00"],
      ["Amlodipine 5 mg", "Amlodipine 5 mg"],
      ["Invoice · due in 3 days", "Invoice · 3 din mein"],
    ],
    offset: -1,
    tilt: 7,
  },
  {
    title: ["Doctor", "Doctor"],
    rows: [
      ["Reported · chest tightness", "Bataya · seene mein jakran"],
      ["Last report · CBC", "Pichhli report · CBC"],
      ["Write consultation note", "Consultation note likhein"],
    ],
    offset: 0,
    tilt: 0,
  },
  {
    title: ["Admin", "Admin"],
    rows: [
      ["Payments to confirm · 2", "Tasdeeq baqi · 2"],
      ["Doctor requests · 1", "Doctor darkhwastein · 1"],
      ["Revenue · this month", "Aamdani · is mahine"],
    ],
    offset: 1,
    tilt: -7,
  },
];

/** One panel, for the same reason as the chip and the card above. */
function PortalCard({
  progress,
  portal,
}: {
  progress: MotionValue<number>;
  portal: (typeof PORTALS)[number];
}) {
  const tr = useTr();
  const x = useTransform(progress, [0.6, 0.68], [portal.offset * -60, 0]);

  return (
    <motion.div
      className="w-[7.5rem] shrink-0 rounded-lg border border-[#14C4C1]/35 bg-[#071129]/90 p-2.5 sm:w-36"
      style={{ rotateY: portal.tilt, x }}
    >
      <p className="mono-caps text-[10px] text-[#5EC8E6]">{tr(...portal.title)}</p>
      <ul className="mt-2.5 space-y-1.5">
        {portal.rows.map((row) => (
          <li
            key={row[0]}
            className="rounded-md bg-white/[0.05] px-2 py-1.5 text-[11px] text-[#C6D8F0]"
          >
            {tr(...row)}
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

/** The same record, opened three ways. */
function Portals({ progress }: { progress: MotionValue<number> }) {
  const opacity = useTransform(progress, [0.6, 0.67, 0.79, 0.84], [0, 1, 1, 0]);

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center"
      style={{ opacity }}
      aria-hidden
    >
      <div className="flex items-center gap-2.5" style={{ perspective: "1000px" }}>
        {PORTALS.map((portal) => (
          <PortalCard key={portal.title[0]} progress={progress} portal={portal} />
        ))}
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Act V — every clinic                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A field of the same mark, small.
 *
 * Crosses rather than dots, deliberately: a field of dots is a starfield, a
 * field of crosses is a map of clinics — and the one in the middle is larger
 * and still beating, which is the patient the story started with.
 */
function City({ progress }: { progress: MotionValue<number> }) {
  const opacity = useTransform(progress, [0.79, 0.86, 1], [0, 1, 1]);
  const scale = useTransform(progress, [0.79, 0.94], [1.35, 1]);
  const cells = Array.from({ length: 88 }, (_, i) => i);

  return (
    <motion.div
      className="absolute inset-0 grid place-items-center"
      style={{ opacity, scale }}
      aria-hidden
    >
      <div className="grid w-full max-w-md grid-cols-11 gap-x-3 gap-y-2.5">
        {cells.map((i) => {
          const home = i === 38;
          return (
            <span
              key={i}
              className={home ? "story-beat" : undefined}
              style={{
                opacity: home ? 1 : 0.28 + ((i * 37) % 11) / 20,
              }}
            >
              <svg viewBox="0 0 24 24" className={home ? "h-5 w-5" : "h-3 w-3"} aria-hidden>
                <path
                  d="M9 2h6a2 2 0 0 1 2 2v3h3a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-3v3a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-3H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3V4a2 2 0 0 1 2-2Z"
                  fill={home ? "#14C4C1" : "#1A8FC7"}
                />
              </svg>
            </span>
          );
        })}
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */

export function StoryStage({ progress }: { progress: MotionValue<number> }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="relative mx-auto h-full w-full max-w-xl">
        <EcgLine progress={progress} />
        <Heartbeat progress={progress} />
        <Voice progress={progress} />
        <Mark progress={progress} />
        <Docking progress={progress} />
        <Portals progress={progress} />
        <City progress={progress} />
      </div>
    </div>
  );
}
