"use client";

/**
 * A hospital that runs while you read about it.
 *
 * Eight stops: the building from the air, then each room in the order a patient
 * meets them — reception, records, the ward, the consultation, the pharmacy,
 * administration — and out again. Scrolling walks the camera; the words on the
 * left change with it; the building itself never stops, because a still model
 * of a hospital argues nothing and a busy one argues everything the product
 * claims.
 *
 * **The words keep the landing page's own voice.** This section changes what
 * the hero *is*, not how it is set: the chip, the accented headline, the
 * paragraph and the buttons are the same components and the same classes the
 * page used before, so nothing below the fold has to be re-tuned to match.
 *
 * **The panels sit under the words, not over the building.** In the demo this
 * grew from they floated across the middle of the scene, which covered up the
 * one thing the section exists to show. A caption that hides its subject is not
 * a caption.
 *
 * **Small screens and reduced motion get the same eight stops, stacked.** A
 * pinned eight-viewport scene on a phone is a hostage situation, and a person
 * who has asked for less movement should get the argument rather than an
 * apology for it.
 */

import Link from "next/link";
import { motion, useMotionValueEvent, useScroll, useSpring, useTransform } from "framer-motion";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { MiniScreen } from "@/components/landing/hospital/MiniScreen";
import { ROOMS, type Room } from "@/components/landing/hospital/plan";
import { useTr } from "@/lib/lang";

/** Never rendered on the server, and never bundled into a portal route. */
const HospitalScene = dynamic(
  () => import("@/components/landing/hospital/HospitalScene").then((m) => m.HospitalScene),
  { ssr: false },
);

interface Stop {
  /** The room this stop frames, or null for the two wide shots. */
  room: Room["key"] | null;
  label: [string, string];
  chip: [string, string];
  lead: [string, string];
  accent: [string, string];
  body: [string, string];
}

const STOPS: Stop[] = [
  {
    room: null,
    label: ["Hospital", "Hospital"],
    chip: ["Smart Healthcare Management", "Smart Healthcare Management"],
    lead: ["A hospital that", "Ek hospital jo"],
    accent: ["runs itself.", "khud chalta hai."],
    body: [
      "Reception to billing, every job in one place. Scroll through it, or pick a room.",
      "Reception se billing tak har kaam ek jagah. Scroll karein, ya koi room chunein.",
    ],
  },
  {
    room: "reception",
    label: ["01 · Reception", "01 · Reception"],
    chip: ["Voice check-in", "Awaaz se check-in"],
    lead: ["Speak, don't", "Bolein,"],
    accent: ["write.", "likhein nahi."],
    body: [
      "The patient says what is wrong. Symptoms, severity and duration become a record on their own.",
      "Mareez apni takleef batata hai. Alamat, shiddat aur muddat khud record ban jate hain.",
    ],
  },
  {
    room: "records",
    label: ["02 · Records", "02 · Records"],
    chip: ["Reports · Prescriptions", "Reports · Nuskhe"],
    lead: ["From paper to", "Kaghaz se"],
    accent: ["data.", "data tak."],
    body: [
      "A photo of an old prescription or a lab report is read into text; the file itself is kept securely.",
      "Purane nuskhe ya lab report ki photo se text nikal aata hai; asal file mehfooz rehti hai.",
    ],
  },
  {
    room: "icu",
    label: ["03 · Ward", "03 · Ward"],
    chip: ["Live vitals · alerts", "Live vitals · alerts"],
    lead: ["Eyes on the", "Nazar"],
    accent: ["heartbeat.", "dharkan par."],
    body: [
      "Cross a threshold and the assigned doctor is alerted in about a second — watch, it happens on its own.",
      "Had cross ho to assigned doctor ko lagbhag ek second mein alert — dekhein, khud hota hai.",
    ],
  },
  {
    room: "consultation",
    label: ["04 · Consultation", "04 · Consultation"],
    chip: ["Doctor portal", "Doctor portal"],
    lead: ["The doctor already", "Doctor ko pehle se"],
    accent: ["knows.", "pata hai."],
    body: [
      "Symptoms, reports and vitals are on screen before the visit. Mark it complete and the invoice writes itself.",
      "Visit se pehle alamat, reports aur vitals screen par. Mukammal karein aur invoice khud ban jati hai.",
    ],
  },
  {
    room: "pharmacy",
    label: ["05 · Pharmacy", "05 · Pharmacy"],
    chip: ["Prescriptions · reminders", "Nuskhe · yaad-dehani"],
    lead: ["Medicine,", "Dawa,"],
    accent: ["on time.", "waqt par."],
    body: [
      "The prescription reaches the phone, reminders can be switched on, and the assistant explains each medicine.",
      "Nuskha phone par pohanchta hai, reminders on kiye ja sakte hain, aur assistant har dawa samjhata hai.",
    ],
  },
  {
    room: "admin",
    label: ["06 · Admin", "06 · Admin"],
    chip: ["Approvals · audit", "Manzoori · audit"],
    lead: ["The whole hospital,", "Poora hospital,"],
    accent: ["at a glance.", "ek nazar."],
    body: [
      "Approve doctors, watch billing, and every action is written to a log nobody can edit or delete.",
      "Doctors manzoor karein, billing dekhein, aur har amal aise log mein jata hai jo koi badal nahi sakta.",
    ],
  },
  {
    room: null,
    label: ["One record", "Ek record"],
    chip: ["Patient · Doctor · Admin", "Mareez · Doctor · Admin"],
    lead: ["One record,", "Ek record,"],
    accent: ["three portals.", "teen portals."],
    body: [
      "MediSense — a whole system for care, in one place.",
      "MediSense — sehat ka poora nizaam, ek jagah.",
    ],
  },
];

/**
 * When each stop's words are on screen.
 *
 * These *overlap* on purpose. The first version left a gap between one stop
 * fading out and the next fading in, and in that gap — about a fifth of a
 * second of scrolling — the column was blank while the label at the top of the
 * screen already named the next room. A reader passing through it sees a
 * caption for nothing. Each window now reaches a tenth of a stop into its
 * neighbours, so one line is always going as the other arrives.
 */
const WINDOWS: [number, number, number, number][] = STOPS.map((_, i) => {
  const span = 1 / (STOPS.length - 1);
  const centre = i * span;
  return [
    i === 0 ? -0.1 : centre - span * 0.55,
    i === 0 ? -0.05 : centre - span * 0.3,
    i === STOPS.length - 1 ? 1 : centre + span * 0.3,
    i === STOPS.length - 1 ? 1 : centre + span * 0.55,
  ];
});

function Words({
  stop,
  range,
  progress,
  critical,
  children,
}: {
  stop: Stop;
  range: [number, number, number, number];
  progress: ReturnType<typeof useSpring>;
  critical: boolean;
  children?: React.ReactNode;
}) {
  const tr = useTr();
  const opacity = useTransform(progress, range, [0, 1, 1, 0]);
  const y = useTransform(progress, range, [12, 0, 0, -12]);

  return (
    <motion.div style={{ opacity, y }} className="absolute inset-x-0 top-1/2 max-w-xl -translate-y-1/2">
      <span className="inline-flex items-center gap-2 rounded-full border border-white/14 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-[#AFC9E8]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#14C4C1]" />
        {tr(...stop.chip)}
      </span>
      <p className="font-display mt-4 text-[2rem] font-black leading-[1.08] tracking-tight text-white sm:text-5xl">
        {tr(...stop.lead)} <span className="text-gradient-medical">{tr(...stop.accent)}</span>
      </p>
      <p className="mt-4 max-w-md text-[0.95rem] leading-relaxed text-[#AFC9E8] sm:text-base">
        {tr(...stop.body)}
      </p>
      {stop.room && (
        <div className="pointer-events-auto mt-4 max-w-[24rem]">
          <MiniScreen room={stop.room} critical={critical} />
        </div>
      )}
      {children}
    </motion.div>
  );
}

export function Hero({
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
   * Decided before paint and kept in step, because a pinned scene that appears
   * for one frame on a phone and then unmounts is worse than never trying.
   */
  const [still, setStill] = useState(false);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 899px)");
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

  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setDark(root.classList.contains("dark"));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const { scrollYProgress } = useScroll({ target: track, offset: ["start start", "end end"] });
  const progress = useSpring(scrollYProgress, {
    stiffness: 80,
    damping: 26,
    mass: 0.45,
    restDelta: 0.0001,
  });

  /** The scene reads this every frame; React never re-renders for the scroll. */
  const scenePosition = useRef(0);
  useMotionValueEvent(progress, "change", (value) => {
    scenePosition.current = value;
  });

  const [stop, setStop] = useState(0);
  const [hovered, setHovered] = useState<Room | null>(null);
  const [critical, setCritical] = useState(false);

  const goToStop = (index: number) => {
    const node = track.current;
    if (!node) return;
    const travel = node.offsetHeight - window.innerHeight;
    window.scrollTo({
      top: node.offsetTop + travel * (index / (STOPS.length - 1)),
      behavior: "smooth",
    });
  };

  const hintOpacity = useTransform(progress, [0, 0.02, 0.05], [1, 1, 0]);

  if (still) {
    return (
      <section className="border-b border-line bg-canvas">
        <div className="mx-auto max-w-2xl px-6 py-16">
          <p className="mono-caps text-xs text-primary">
            {tr("A hospital that runs itself", "Ek hospital jo khud chalta hai")}
          </p>
          <h1 className="font-display mt-3 text-4xl font-black leading-[1.05] tracking-tight text-strong">
            {tr("Reception to billing, in one place.", "Reception se billing tak, ek jagah.")}
          </h1>
          <ol className="mt-10 space-y-9">
            {STOPS.map((item) => (
              <li key={item.label[0]} className="border-l-2 border-line pl-5">
                <p className="mono-caps text-[11px] text-primary">
                  {tr(...item.label)} · {tr(...item.chip)}
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
      aria-label={tr("A hospital that runs itself", "Ek hospital jo khud chalta hai")}
      className="relative h-[820vh]"
      style={{ background: "radial-gradient(120% 90% at 50% 10%, #0A2A63 0%, #00194D 48%, #040B1F 100%)" }}
    >
      <div className="sticky top-0 h-screen overflow-hidden">
        {/* Two columns. The words never sit on the building, and the building
            is never hidden by the words — which is the whole reason this
            section can afford to be a hospital rather than a diagram. */}
        <div className="relative mx-auto grid h-full max-w-7xl grid-cols-[minmax(0,26rem)_1fr] items-center gap-8 px-6 xl:gap-12">
          <div className="relative z-10 h-[30rem]">
            {STOPS.map((item, i) => (
              <Words
                key={item.label[0]}
                stop={item}
                range={WINDOWS[i]}
                progress={progress}
                critical={critical}
              >
                {i === 0 && (
                  <div className="pointer-events-auto mt-5 flex flex-wrap gap-1.5">
                    {ROOMS.map((room) => (
                      <button
                        key={room.key}
                        type="button"
                        onClick={() => goToStop(room.id)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-1 text-[11px] font-semibold text-[#DCEBFF] transition-colors hover:border-[#14C4C1]"
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: `#${room.colour.toString(16).padStart(6, "0")}` }}
                        />
                        {tr(...STOPS[room.id].label).split("· ")[1] ?? room.key}
                      </button>
                    ))}
                  </div>
                )}
                {i === STOPS.length - 1 && (
                  <div className="pointer-events-auto mt-6 flex flex-wrap gap-3">
                    <Link
                      href={primaryHref}
                      className="bg-gradient-brand inline-flex min-h-12 items-center gap-2 whitespace-nowrap rounded-xl px-6 font-bold text-white"
                    >
                      {primaryLabel}
                      <Icon name="arrow_forward" className="text-[20px]" />
                    </Link>
                    <Link
                      href="/login"
                      className="inline-flex min-h-12 items-center whitespace-nowrap rounded-xl border border-white/25 px-6 font-semibold text-white transition-colors hover:bg-white/10"
                    >
                      {tr("Sign in", "Sign in")}
                    </Link>
                  </div>
                )}
              </Words>
            ))}
          </div>

          <div className="relative h-full">
            <HospitalScene
              progress={scenePosition}
              stops={STOPS.length}
              onStop={setStop}
              onHover={setHovered}
              onAlert={setCritical}
              onRoomClick={(room) => goToStop(room.id)}
              dark={dark}
            />
          </div>
        </div>

        {/* Which stop, and how much is left. */}
        <div className="mono-caps absolute left-6 top-24 flex items-center gap-3 text-[11px] text-white/55">
          <span className="h-px w-6 bg-white/40" />
          <span className="text-[#5EC8E6]">{tr(...STOPS[stop].label)}</span>
        </div>

        <div
          aria-hidden
          className="absolute right-5 top-1/2 hidden h-56 w-0.5 -translate-y-1/2 bg-white/10 sm:block"
        >
          <motion.span
            className="absolute inset-x-0 top-0 h-full origin-top bg-gradient-to-b from-[#14C4C1] to-[#1A8FC7]"
            style={{ scaleY: progress }}
          />
          {STOPS.map((item, i) => (
            <span
              key={item.label[0]}
              className="absolute -left-[3px] h-2 w-2 rounded-full transition-colors duration-300"
              style={{
                top: `${(i / (STOPS.length - 1)) * 100}%`,
                background: i <= stop ? "#14C4C1" : "#2A3E63",
                boxShadow: i === stop ? "0 0 0 4px rgba(20,196,193,0.18)" : undefined,
              }}
            />
          ))}
        </div>

        {/* The one thing allowed to sit over the building. */}
        {hovered && (
          <span className="pointer-events-none absolute bottom-24 right-8 rounded-lg border border-white/15 bg-[#0A1733]/90 px-3 py-1.5 text-xs font-semibold text-[#DCEBFF]">
            {tr(...STOPS[hovered.id].label)}
          </span>
        )}
        {critical && (
          <span className="pointer-events-none absolute bottom-36 right-8 rounded-lg border border-[#7a3a3a] bg-[#4a2020] px-3 py-1.5 text-xs font-semibold text-[#ff9a9a]">
            {tr("Alert → the ward doctor", "Alert → ward ke doctor ko")}
          </span>
        )}

        <motion.div
          style={{ opacity: hintOpacity }}
          className="mono-caps pointer-events-none absolute bottom-8 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2 text-[10px] text-white/55"
        >
          <span>{tr("Scroll to walk through", "Andar chalne ke liye scroll karein")}</span>
          <Icon name="keyboard_arrow_down" className="text-[18px] text-[#5EC8E6]" />
        </motion.div>
      </div>
    </section>
  );
}
