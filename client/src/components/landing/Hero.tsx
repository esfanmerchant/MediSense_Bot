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
 * **A phone gets a different telling, not a squeezed one.** The pinned scene
 * is a mouse-and-wheel experience — eight viewports of it on a phone is a
 * hostage situation, and the hover labels and clickable rooms do not exist
 * under a finger. So a touch device or a narrow window gets one picture of the
 * building and the six rooms as a short list: the same argument, in about a
 * third of the words, because on a phone the scroll *is* the cost. Reduced
 * motion gets the same, for the same reason in a different key.
 */

import Image from "next/image";
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
  /**
   * The same point, for a phone.
   *
   * Not a truncation of `body` — a sentence cut in half stops being one. Each
   * of these is written to stand alone at about a third of the length, because
   * on a small screen every extra line is a scroll somebody pays for.
   */
  short: [string, string];
  /** Material Symbol for the compact list, where there is no scene to look at. */
  icon: string;
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
    short: ["Reception to billing, in one place.", "Reception se billing tak, ek jagah."],
    icon: "domain",
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
    short: ["Symptoms spoken become a record.", "Boli hui takleef record ban jati hai."],
    icon: "record_voice_over",
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
    short: ["Photograph a report; it becomes text.", "Report ki photo — text ban jati hai."],
    icon: "document_scanner",
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
    short: ["A reading out of range alerts the doctor.", "Had se bahar reading — doctor ko alert."],
    icon: "monitor_heart",
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
    short: ["Everything on screen before the visit.", "Visit se pehle sab kuch screen par."],
    icon: "stethoscope",
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
    short: ["The prescription reaches the phone, with reminders.", "Nuskha phone par, reminders ke saath."],
    icon: "pill",
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
    short: ["Approvals, billing, and a log nobody can edit.", "Manzoori, billing, aur log jo koi badal nahi sakta."],
    icon: "admin_panel_settings",
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
    short: ["One record, three portals.", "Ek record, teen portals."],
    icon: "hub",
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
    <motion.div style={{ opacity, y }} className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2">
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
   * Who gets the stacked telling instead of the scene.
   *
   * Width is not the whole question. A tablet held in portrait is 1024px wide
   * and still the wrong device for this: the scene answers a wheel, and its
   * hover labels and clickable rooms have no equivalent under a finger. So a
   * coarse pointer opts out at any width, which is what actually distinguishes
   * "phone or tablet" from "laptop" — a touchscreen laptop reports a fine
   * primary pointer and keeps the scene.
   *
   * Decided before paint and kept in step, because a pinned scene that appears
   * for one frame on a phone and then unmounts is worse than never trying.
   */
  const [still, setStill] = useState(false);
  useEffect(() => {
    const queries = [
      window.matchMedia("(max-width: 899px)"),
      window.matchMedia("(pointer: coarse)"),
      window.matchMedia("(prefers-reduced-motion: reduce)"),
    ];
    const update = () => setStill(queries.some((q) => q.matches));
    update();
    queries.forEach((q) => q.addEventListener("change", update));
    return () => queries.forEach((q) => q.removeEventListener("change", update));
  }, []);

  /**
   * The scene is always daylight, and the band around it is always night.
   *
   * The landing does not follow the theme toggle any more — it alternates dark
   * and light down its own length, and that alternation *is* the design. A
   * hero that flipped with the reader's night setting would break the first
   * beat of it, and the building's own lawn and shadows were drawn for a
   * daylight sun.
   */
  const { scrollYProgress } = useScroll({ target: track, offset: ["start start", "end end"] });
  /**
   * The scroll, smoothed.
   *
   * Overdamped on purpose — the damping ratio here is about two and a half, so
   * the value glides to the scroll position and never overshoots it. Raw scroll
   * is mechanical and an underdamped spring rings, which on a camera reads as a
   * wobble at the end of every move. It also means progress cannot stray below
   * zero or past one, which an overshooting spring did, and which used to index
   * off the end of the stop list.
   */
  const progress = useSpring(scrollYProgress, {
    stiffness: 70,
    damping: 30,
    mass: 0.5,
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

  /**
   * True once the scene has decided this machine cannot run it.
   *
   * A browser with no WebGL, or one falling back to a software rasteriser,
   * gets the rendered still in the same slot. The picture came out of this
   * scene, so it is the same hospital — just the one frame of it.
   */
  const [stillOnly, setStillOnly] = useState(false);

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
    /* The six rooms are the argument; the two wide shots at either end only
       restate the headline above them, so on a phone they are the headline and
       nothing else. */
    const rooms = STOPS.filter((item) => item.room !== null);

    return (
      /* pt clears the fixed 72px header, which the old py-16 did not — the
         eyebrow was printing underneath it. */
      <section className="band-dark border-b border-line">
        <div className="mx-auto max-w-2xl px-5 pb-14 pt-28 sm:px-6 sm:pb-16 sm:pt-32">
          <p className="mono-caps text-[11px] text-primary sm:text-xs">
            {tr("A hospital that runs itself", "Ek hospital jo khud chalta hai")}
          </p>
          <h1 className="font-display mt-3 text-[2.125rem] font-black leading-[1.05] tracking-tight text-strong sm:text-4xl">
            {tr("Reception to billing, in one place.", "Reception se billing tak, ek jagah.")}
          </h1>
          <p className="mt-3 text-base leading-relaxed text-muted">
            {tr(
              "One record, three portals — patient, doctor, administration.",
              "Ek record, teen portals — mareez, doctor, intezamia.",
            )}
          </p>

          {/* One frame of the scene, rendered from the scene itself rather than
              drawn — a hand-made picture of a building would be wrong the first
              time a room moved. Somebody who cannot have the moving version
              still gets to see the place. */}
          <Image
            src="/hero/hospital-light.webp"
            alt={tr(
              "The hospital: reception, records, ward, consultation, pharmacy and administration around a corridor.",
              "Hospital: corridor ke ird-gird reception, records, ward, consultation, pharmacy aur administration.",
            )}
            width={880}
            height={718}
            priority
            className="mt-6 w-full rounded-2xl border border-line"
          />

          {/* Six lines, not six paragraphs. Each names a room and says the one
              thing it does; the long version is the scene, and the scene is not
              on this device. */}
          <ul className="mt-8 divide-y divide-line overflow-hidden rounded-2xl border border-line">
            {rooms.map((item) => (
              <li key={item.label[0]} className="flex items-start gap-3.5 p-4">
                <span
                  aria-hidden
                  className="bg-gradient-soft grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary"
                >
                  <Icon name={item.icon} className="text-[20px]" />
                </span>
                <div className="min-w-0">
                  <p className="font-display text-[1.0625rem] font-bold leading-snug text-strong">
                    {tr(...item.lead)} <span className="text-gradient-brand">{tr(...item.accent)}</span>
                  </p>
                  <p className="mt-1 text-[0.9375rem] leading-relaxed text-muted">
                    {tr(...item.short)}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <Link
            href={primaryHref}
            className="bg-gradient-brand mt-8 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-6 font-bold text-white sm:w-auto"
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
      className="band-dark relative h-[820vh]"
      style={{ background: "radial-gradient(120% 90% at 50% 10%, #0A2A63 0%, #00194D 48%, #040B1F 100%)" }}
    >
      <div className="sticky top-0 h-screen overflow-hidden">
        {/* The building fills the frame, and the words sit on it.
            ------------------------------------------------------
            It was two columns, which kept them apart but also kept the
            hospital in half a screen — and a hospital in half a screen is a
            diagram of one. Full bleed, with the camera aimed so the building
            sits right of centre and the left third stays clear, gives the
            scene the room it needs and the words somewhere to stand. */}
        <div className="absolute inset-0">
          {stillOnly ? (
            <div className="flex h-full items-center justify-end pr-[4vw]">
              <Image
                src="/hero/hospital-light.webp"
                alt={tr(
                  "The hospital: reception, records, ward, consultation, pharmacy and administration around a corridor.",
                  "Hospital: corridor ke ird-gird reception, records, ward, consultation, pharmacy aur administration.",
                )}
                width={880}
                height={718}
                className="w-[min(62vw,60rem)] rounded-2xl"
              />
            </div>
          ) : (
            <HospitalScene
              progress={scenePosition}
              stops={STOPS.length}
              onStop={setStop}
              onHover={setHovered}
              onAlert={setCritical}
              onRoomClick={(room) => goToStop(room.id)}
              onUnsupported={() => setStillOnly(true)}
              dark={false}
            />
          )}
        </div>

        {/* Enough ground under the words to read them on, and no more. A panel
            would cut the building in half again; a gradient that fades out
            before the middle of the screen does not. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-[62%]"
          style={{
            background:
              "linear-gradient(90deg, rgba(4,11,31,0.92) 0%, rgba(4,11,31,0.78) 34%, rgba(4,11,31,0) 100%)",
          }}
        />

        <div className="pointer-events-none absolute inset-y-0 left-0 flex w-[min(30rem,46vw)] items-center px-6 lg:pl-[5vw]">
          <div className="relative h-[30rem] w-full">
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
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-[11px] font-semibold text-[#DCEBFF] transition-colors hover:border-[#14C4C1]"
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
