"use client";

/**
 * The front door — Roman Urdu first, English one tap away.
 *
 * The person arriving here is usually worried about something, and what works
 * on them is not excitement but *relief*. Every modern-landing-page device this
 * page borrows — the dark hero with a living background, the stat strip, the
 * bento grid, staggered reveals — is pointed at that one feeling: this place is
 * calm, capable, and will not waste your effort.
 *
 * The deliberate risk stays from the last iteration: the hero shows the
 * assistant *refusing to reassure* someone with chest pain. Leading with the
 * product's most cautious moment is not the obvious sales choice — it is the
 * single most convincing thing this system does, and a health product that
 * oversells its intelligence loses trust the first time it is wrong.
 *
 * The heartbeat behind the hero is three.js, and it is the only three.js on
 * the site: marketing may spend GPU; clinical screens may not.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { Logo } from "@/components/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useReveal } from "@/lib/useReveal";
import { useTr } from "@/lib/lang";
import { homePathFor, useSession } from "@/lib/session";

/** Loaded only here, only client-side — no portal route pays for WebGL. */
const HeroScene = dynamic(() => import("@/components/HeroScene"), { ssr: false });

/* ----------------------------------------------------------------------- */
/* Small pieces                                                             */
/* ----------------------------------------------------------------------- */

function Wordmark({ onDark = false }: { onDark?: boolean }) {
  return <Logo onDark={onDark} size="md" />;
}

function Cta({
  href,
  children,
  variant = "solid",
}: {
  href: string;
  children: ReactNode;
  variant?: "solid" | "onDark" | "quiet";
}) {
  const styles = {
    solid:
      "bg-primary text-white shadow-card hover:bg-primary-hover focus-visible:outline-primary",
    onDark:
      "bg-accent-bright text-[#053B38] shadow-overlay hover:brightness-105 focus-visible:outline-white",
    quiet: "border border-white/25 text-white hover:bg-white/10 focus-visible:outline-white",
  } as const;

  return (
    <Link
      href={href}
      className={`hover-lift inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-6 text-base font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${styles[variant]}`}
    >
      {children}
    </Link>
  );
}

function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useReveal<HTMLDivElement>(delay);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/**
 * A number that counts up when it scrolls into view.
 *
 * Reduced motion, no IntersectionObserver, or no JavaScript all land on the
 * same honest fallback: the final number, immediately.
 */
function CountUp({ to, suffix = "" }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [value, setValue] = useState(to);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!("IntersectionObserver" in window)) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      // The reset happens here, inside the observer callback, not in the
      // effect body — React 19 treats a synchronous setState-in-effect as the
      // cascading-render bug it usually is. Until the strip scrolls into view
      // the element honestly shows the final number.
      setValue(0);
      const start = performance.now();
      const duration = 1400;
      const tick = (now: number) => {
        const progress = Math.min(1, (now - start) / duration);
        // Ease-out: the last digits settle slowly, which is what the eye reads.
        setValue(Math.round(to * (1 - Math.pow(1 - progress, 3))));
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [to]);

  return (
    <span ref={ref} className="tabular-nums">
      {value}
      {suffix}
    </span>
  );
}

/** A vital tile, exactly as it appears inside the product. */
function HeroVital({
  label,
  value,
  unit,
  icon,
}: {
  label: string;
  value: string;
  unit: string;
  icon: string;
}) {
  return (
    <div className="glass-dark rounded-xl p-4">
      <div className="flex items-start justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
          {label}
        </span>
        <Icon name={icon} filled className="text-[18px] text-accent-bright" />
      </div>
      <p className="mt-3 flex items-end gap-1.5">
        <span className="text-3xl font-bold leading-none tabular-nums text-white">{value}</span>
        <span className="mb-0.5 text-xs text-white/50">{unit}</span>
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* The page                                                                 */
/* ----------------------------------------------------------------------- */

export default function Home() {
  const { user, loading } = useSession();
  const tr = useTr();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const primaryHref = user ? homePathFor(user.role) : "/register";
  const primaryLabel = loading
    ? "…"
    : user
      ? tr("Go to your dashboard", "Apne dashboard par jayein")
      : tr("Get started — free", "Shuru karein — bilkul muft");

  const portals = [
    {
      who: tr("Patients", "Mareez"),
      icon: "person",
      line: tr(
        "Book a visit, read your own history, ask a question at 2am.",
        "Appointment book karein, apni puri history parhein, raat 2 baje bhi sawal poochein.",
      ),
      points: [
        tr("Appointments and reminders", "Appointments aur yaad-dehani"),
        tr("Records, prescriptions, invoices", "Records, nuskhe aur bills"),
        tr("Health assistant with voice input", "Awaaz se chalne wala health assistant"),
      ],
    },
    {
      who: tr("Doctors", "Doctors"),
      icon: "stethoscope",
      line: tr(
        "Your patients, your alerts, your notes — one screen, not six.",
        "Aap ke mareez, aap ke alerts, aap ke notes — chhe screens nahi, sirf ek.",
      ),
      points: [
        tr("Live vital alerts as they happen", "Vitals ke alerts, usi waqt"),
        tr("Charts, prescribing, consultation notes", "Charts, nuskha likhna, consultation notes"),
        tr("Document reading with review", "Documents ki parhai, review ke saath"),
      ],
    },
    {
      who: tr("Administrators", "Intezamia"),
      icon: "admin_panel_settings",
      line: tr(
        "Run the hospital without reading anyone's diagnosis.",
        "Hospital chalayein — kisi ki bimari parhe baghair.",
      ),
      points: [
        tr("Scheduling and staff", "Schedule aur staff"),
        tr("Billing, invoices, credit notes", "Billing, invoices aur credit notes"),
        tr("Audit trail and break-glass review", "Audit trail aur emergency access ka review"),
      ],
    },
  ];

  const capabilities: [string, string, string][] = [
    [
      "monitor_heart",
      tr("Live vital monitoring", "Vitals par live nazar"),
      tr(
        "Readings are checked against configurable thresholds the moment they arrive, and the responsible doctor is told.",
        "Har reading usi lamhe muqarrar hadon se jaanchi jaati hai — had paar hui to zimmedar doctor ko foran khabar milti hai.",
      ),
    ],
    [
      "smart_toy",
      tr("AI health assistant", "AI health assistant"),
      tr(
        "Grounded in your own prescriptions and appointments. It escalates rather than reassures when something sounds serious.",
        "Aap ke apne nuskhon aur appointments par mabni. Baat sangeen lage to tasalli nahi deta — foran doctor ke paas bhejta hai.",
      ),
    ],
    [
      "mic",
      tr("Speak your symptoms", "Apni takleef bol kar batayein"),
      tr(
        "Speech becomes text on your device. You correct it before anything is stored.",
        "Aap ki awaaz aap ke apne device par likhai mein badalti hai — save hone se pehle aap khud usay durust karte hain.",
      ),
    ],
    [
      "document_scanner",
      tr("Reads your documents", "Aap ke documents parh leta hai"),
      tr(
        "Prescriptions and reports are read automatically — and a doctor confirms every value before it counts.",
        "Nuskhe aur reports khud-ba-khud parhi jaati hain — magar har qeemat doctor ki tasdeeq ke baad hi record banti hai.",
      ),
    ],
    [
      "receipt_long",
      tr("Billing that just happens", "Billing jo khud ho jaati hai"),
      tr(
        "An invoice is created the moment a consultation is completed. Exactly one, however many times it retries.",
        "Consultation mukammal hote hi invoice ban jaata hai. Sirf ek — chahe system kitni hi baar koshish kare.",
      ),
    ],
    [
      "policy",
      tr("A trail nobody can edit", "Aisa record jo koi badal nahi sakta"),
      tr(
        "Every access is hash-chained. Tampering is detectable, and the check is one button.",
        "Har rasai hash-chain mein jakri hai. Cherh-chharh pakri ja sakti hai — aur jaanch sirf ek button hai.",
      ),
    ],
  ];

  const steps: [string, string][] = [
    [
      tr("Create your account", "Apna account banayein"),
      tr("Name, email, a password. Nothing else, and nothing sold.", "Naam, email aur ek password. Bas — na kuchh aur, na kuchh becha jaata hai."),
    ],
    [
      tr("Pick a time that suits you", "Apni sahulat ka waqt chunein"),
      tr(
        "Real availability from real calendars — no double bookings, no callbacks.",
        "Asli calendars se asli waqt — na double booking, na baar baar phone.",
      ),
    ],
    [
      tr("Everything follows you", "Sab kuchh aap ke saath chalta hai"),
      tr(
        "Notes, prescriptions, results and invoices land in one place as they happen.",
        "Notes, nuskhe, reports aur bills — jaise jaise bante hain, ek hi jagah pahunchte hain.",
      ),
    ],
  ];

  const trust: [string, string, string][] = [
    [
      "verified_user",
      tr("Only your care team", "Sirf aap ki ilaaj karne wali team"),
      tr(
        "A doctor sees your record because they treat you — not because they are a doctor.",
        "Doctor aap ka record is liye dekhta hai ke woh aap ka ilaaj karta hai — sirf doctor hone ki wajah se nahi.",
      ),
    ],
    [
      "fact_check",
      tr("Every access is logged", "Har rasai darj hoti hai"),
      tr(
        "The trail is append-only and hash-chained. Nobody can edit it, including us.",
        "Record sirf barhta hai, badla nahi ja sakta — hum bhi nahi badal sakte.",
      ),
    ],
    [
      "e911_emergency",
      tr("Emergencies are controlled", "Emergency bhi qaboo mein"),
      tr(
        "Break-glass opens one chart, expires on a clock, and tells you it happened.",
        "Emergency access sirf ek mareez ki file kholta hai, waqt par khatam hota hai — aur aap ko bataya jaata hai.",
      ),
    ],
    [
      "timer",
      tr("Signed out automatically", "Khud-ba-khud sign out"),
      tr(
        "On a shared hospital terminal, two minutes of inactivity ends the session.",
        "Hospital ke mushtarka computer par do minute ki khamoshi session khatam kar deti hai.",
      ),
    ],
  ];

  return (
    <div className="min-h-screen bg-canvas">
      {/* ================= NAV ================= */}
      <header
        className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
          scrolled ? "border-b border-white/10 bg-[#0A1A4D]/85 shadow-overlay backdrop-blur-md" : ""
        }`}
      >
        <div className="mx-auto flex max-w-[1200px] items-center gap-3 px-5 py-4">
          <Wordmark onDark />
          <nav aria-label="Primary" className="ml-auto flex items-center gap-2.5">
            <LanguageToggle onDark />
            {!loading && !user && (
              <Link
                href="/login"
                className="hidden min-h-11 items-center rounded-lg px-4 text-sm font-medium text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:inline-flex"
              >
                {tr("Sign in", "Login karein")}
              </Link>
            )}
            <Cta href={user ? primaryHref : "/register"} variant="onDark">
              {loading ? "…" : user ? tr("Dashboard", "Dashboard") : tr("Get started", "Shuru karein")}
            </Cta>
          </nav>
        </div>
      </header>

      {/* ================= HERO ================= */}
      <div className="relative overflow-hidden bg-[#0A1A4D]">
        {/* Lit space, not flat fill: two drifting glows and a fine grid. */}
        <div
          aria-hidden
          className="animate-drift pointer-events-none absolute -left-40 -top-40 h-[38rem] w-[38rem] rounded-full bg-[#3B6BF0] opacity-60 blur-[130px]"
        />
        <div
          aria-hidden
          className="animate-drift-late pointer-events-none absolute -right-32 top-24 h-[32rem] w-[32rem] rounded-full bg-[#0E9E98] opacity-40 blur-[130px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
            backgroundSize: "56px 56px",
          }}
        />

        {/* The heartbeat. */}
        <HeroScene />

        <section className="relative mx-auto grid max-w-[1200px] gap-12 px-5 pb-24 pt-36 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:pb-36 lg:pt-44">
          <div>
            <Reveal>
              <p className="inline-flex items-center gap-2 rounded-full border border-accent-bright/30 bg-accent-bright/10 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-accent-bright">
                <span aria-hidden className="h-1.5 w-1.5 animate-breathe rounded-full bg-accent-bright" />
                {tr("Smart Healthcare Management", "Smart Healthcare Management")}
              </p>
            </Reveal>

            <Reveal delay={90}>
              <h1 className="mt-7 font-display text-[2.9rem] font-extrabold leading-[1.02] text-white sm:text-[4.2rem]">
                {tr("Your health,", "Aap ki sehat,")}
                <br />
                <span className="text-gradient-medical">
                  {tr("finally in one place.", "aakhirkar ek jagah par.")}
                </span>
              </h1>
            </Reveal>

            <Reveal delay={180}>
              <p className="mt-7 max-w-xl text-lg leading-relaxed text-white/75">
                {tr(
                  "Appointments, records, prescriptions, vitals and bills — with an assistant that answers in plain language and knows when to send you to a doctor instead.",
                  "Appointments, records, nuskhe, vitals aur bills — aur ek assistant jo aasan zabaan mein jawab deta hai, aur yeh bhi jaanta hai ke kab jawab dene ke bajaye aap ko doctor ke paas bhejna hai.",
                )}
              </p>
            </Reveal>

            <Reveal delay={270}>
              <div className="mt-10 flex flex-wrap items-center gap-3">
                <Cta href={primaryHref} variant="onDark">
                  {primaryLabel}
                  <Icon name="arrow_forward" className="text-[20px]" />
                </Cta>
                <Cta href="#kya-karta-hai" variant="quiet">
                  {tr("See what it does", "Dekhein yeh kya karta hai")}
                </Cta>
              </div>
            </Reveal>

            <Reveal delay={360}>
              {/* The three objections that stop a signup, in the order they
                  occur to someone hovering over the button. */}
              <ul className="mt-9 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/60">
                {[
                  tr("No card needed", "Card ki zaroorat nahi"),
                  tr("No phone calls", "Phone calls nahi"),
                  tr("Your data stays yours", "Aap ka data aap ka hi rehta hai"),
                ].map((item) => (
                  <li key={item} className="flex items-center gap-1.5">
                    <Icon name="check_circle" filled className="text-[16px] text-accent-bright" />
                    {item}
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>

          {/* The product, not a stock photo. */}
          <Reveal delay={200}>
            <div className="glass-dark hover-lift rounded-2xl p-5">
              <div className="flex items-center gap-2 pb-4">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-white/20" />
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-white/20" />
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-white/20" />
                <span className="ml-2 text-xs text-white/40">
                  {tr("Patient dashboard", "Mareez ka dashboard")}
                </span>
                <span className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold text-accent-bright">
                  <span aria-hidden className="h-1.5 w-1.5 animate-breathe rounded-full bg-accent-bright" />
                  LIVE
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <HeroVital label={tr("Heart rate", "Dil ki dharkan")} value="72" unit="bpm" icon="favorite" />
                <HeroVital label="SpO₂" value="98" unit="%" icon="pulmonology" />
                <HeroVital label={tr("Temp", "Bukhaar")} value="36.8" unit="°C" icon="thermostat" />
              </div>

              {/* The assistant refusing to reassure — the money shot. */}
              <div className="mt-4 rounded-xl border border-white/10 bg-[#001945]/60 p-4">
                <p className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-md bg-white/10 px-4 py-2.5 text-sm text-white">
                  {tr(
                    "I have chest pain going down my left arm",
                    "Seenay mein dard hai jo baayen baazu tak ja raha hai",
                  )}
                </p>
                <div className="mt-3 rounded-lg border-2 border-[#ffb4ab] bg-[#ffb4ab]/10 px-4 py-3">
                  <p className="flex items-center gap-2 text-sm font-bold text-[#ffb4ab]">
                    <Icon name="emergency" filled className="text-[18px]" />
                    {tr("This may need emergency care", "Yeh emergency ho sakti hai")}
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-white/80">
                    {tr(
                      "Do not wait for a reply here. Call your local emergency number or go to the nearest emergency department.",
                      "Yahan jawab ka intezar na karein. Foran emergency number par call karein ya qareeb tareen emergency department jayein.",
                    )}
                  </p>
                </div>
                <p className="mt-3 border-t border-white/10 pt-3 text-[11px] leading-relaxed text-white/45">
                  This information is for preliminary guidance only and does not replace evaluation
                  by a licensed healthcare professional.
                </p>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ================= STAT STRIP ================= */}
        <section className="relative border-t border-white/10">
          <div className="mx-auto grid max-w-[1200px] grid-cols-2 gap-6 px-5 py-10 sm:grid-cols-4">
            {(
              [
                [734, "", tr("automated tests", "khudkar tests")],
                [87, "", tr("secured endpoints", "mehfooz endpoints")],
                [3, "", tr("role-based portals", "role ke mutabiq portals")],
                [2, " min", tr("auto sign-out on shared screens", "mushtarka screens par auto sign-out")],
              ] as [number, string, string][]
            ).map(([to, suffix, label], index) => (
              <Reveal key={label} delay={index * 80}>
                <div className="text-center sm:text-left">
                  <p className="font-display text-4xl font-bold text-accent-bright">
                    <CountUp to={to} suffix={suffix} />
                  </p>
                  <p className="mt-1 text-sm text-white/60">{label}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>
      </div>

      <main id="main">
        {/* ================= PORTALS ================= */}
        <section className="mx-auto max-w-[1200px] px-5 py-24">
          <Reveal>
            <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-accent">
              {tr("Three portals", "Teen portals")}
            </p>
            <h2 className="mt-3 max-w-2xl font-display text-3xl font-bold text-strong sm:text-[2.6rem] sm:leading-[1.1]">
              {tr("One system, three doors", "Ek system, teen darwaze")}
            </h2>
            <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-muted">
              {tr(
                "Everyone sees exactly what their job needs and nothing more. That is not a setting — it is how the system is built.",
                "Har shakhs sirf wohi dekhta hai jo us ke kaam ke liye zaroori hai — is se zyada kuchh nahi. Yeh koi setting nahi, system isi tarah banaya gaya hai.",
              )}
            </p>
          </Reveal>

          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {portals.map((portal, index) => (
              <Reveal key={portal.icon} delay={index * 110}>
                <div className="hover-lift h-full rounded-xl border border-line bg-card p-6 shadow-card">
                  <span aria-hidden className="grid h-12 w-12 place-items-center rounded-xl bg-primary-soft">
                    <Icon name={portal.icon} filled className="text-[24px] text-primary" />
                  </span>
                  <h3 className="mt-5 font-display text-xl font-bold text-strong">{portal.who}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-muted">{portal.line}</p>
                  <ul className="mt-5 space-y-2.5 border-t border-line pt-5">
                    {portal.points.map((point) => (
                      <li key={point} className="flex items-start gap-2.5 text-sm text-muted">
                        <Icon name="check" className="mt-0.5 text-[16px] text-accent" />
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ================= CAPABILITIES ================= */}
        <section id="kya-karta-hai" className="scroll-mt-20 border-y border-line bg-card">
          <div className="mx-auto max-w-[1200px] px-5 py-24">
            <Reveal>
              <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-accent">
                {tr("Capabilities", "Salahiyatein")}
              </p>
              <h2 className="mt-3 max-w-2xl font-display text-3xl font-bold text-strong sm:text-[2.6rem] sm:leading-[1.1]">
                {tr("Everything a visit touches", "Ilaaj ka har qadam, ek jagah")}
              </h2>
              <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-muted">
                {tr(
                  "Not a folder of features — one path a patient actually walks, from booking to paying, with the clinical safety built into each step rather than bolted on.",
                  "Yeh features ki fehrist nahi — woh rasta hai jo mareez sach mein tay karta hai, booking se bill tak. Aur hifazat har qadam ke andar bani hai, upar se lagai nahi gayi.",
                )}
              </p>
            </Reveal>

            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {capabilities.map(([icon, title, body], index) => (
                <Reveal key={icon} delay={(index % 3) * 100}>
                  <div className="hover-lift h-full rounded-xl border border-line bg-canvas p-6">
                    <span aria-hidden className="grid h-11 w-11 place-items-center rounded-lg bg-accent-soft">
                      <Icon name={icon} className="text-[24px] text-accent" />
                    </span>
                    <h3 className="mt-4 text-base font-bold text-strong">{title}</h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-muted">{body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ================= HOW IT WORKS ================= */}
        <section className="mx-auto max-w-[1200px] px-5 py-24">
          <Reveal>
            <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-accent">
              {tr("How it works", "Kaise chalta hai")}
            </p>
            <h2 className="mt-3 font-display text-3xl font-bold text-strong sm:text-[2.6rem]">
              {tr("Three steps, then you are done", "Teen qadam — bas itna hi")}
            </h2>
          </Reveal>

          <ol className="mt-12 grid gap-5 md:grid-cols-3">
            {steps.map(([title, body], index) => (
              <Reveal key={title} delay={index * 110}>
                <li className="relative h-full rounded-xl border border-line bg-card p-6 shadow-card">
                  {/* Numbered because this genuinely is a sequence. */}
                  <span
                    aria-hidden
                    className="grid h-9 w-9 place-items-center rounded-full bg-primary font-display text-sm font-bold text-white"
                  >
                    {index + 1}
                  </span>
                  <h3 className="mt-4 text-base font-bold text-strong">{title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-muted">{body}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </section>

        {/* ================= TRUST ================= */}
        <section className="border-y border-line bg-card">
          <div className="mx-auto grid max-w-[1200px] gap-10 px-5 py-24 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <Reveal>
              <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-accent">
                {tr("Security", "Hifazat")}
              </p>
              <h2 className="mt-3 font-display text-3xl font-bold text-strong sm:text-[2.6rem] sm:leading-[1.1]">
                {tr("Built to be trusted with this", "Itni hifazat ke aap bharosa kar sakein")}
              </h2>
              <p className="mt-4 text-[17px] leading-relaxed text-muted">
                {tr(
                  "Specifics, because “bank-grade security” means nothing. Each of these is a property the system can be tested against, not a promise.",
                  "Waade nahi, tafseelat — kyunke “bank jaisi security” ka koi matlab nahi hota. Neeche di gayi har baat aisi hai jise test kiya ja sakta hai.",
                )}
              </p>
              <div className="mt-8">
                <Cta href={primaryHref}>{primaryLabel}</Cta>
              </div>
            </Reveal>

            <ul className="grid gap-4 sm:grid-cols-2">
              {trust.map(([icon, title, body], index) => (
                <Reveal key={icon} delay={index * 90}>
                  <li className="hover-lift h-full rounded-xl border border-line bg-canvas p-5">
                    <Icon name={icon} filled className="text-[22px] text-accent" />
                    <h3 className="mt-3 text-[15px] font-bold text-strong">{title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
                  </li>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        {/* ================= CLOSE ================= */}
        <section className="mx-auto max-w-[1200px] px-5 py-24">
          <Reveal>
            <div className="relative overflow-hidden rounded-2xl bg-[#0A1A4D] px-8 py-16 text-center">
              <div
                aria-hidden
                className="animate-drift pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-[#0E9E98] opacity-40 blur-[100px]"
              />
              <div
                aria-hidden
                className="animate-drift-late pointer-events-none absolute -bottom-24 -left-16 h-72 w-72 rounded-full bg-[#3B6BF0] opacity-60 blur-[100px]"
              />
              <div className="relative">
                <h2 className="font-display text-3xl font-bold text-white sm:text-[2.6rem]">
                  {tr("Ready when you are", "Jab aap tayyar, hum tayyar")}
                </h2>
                <p className="mx-auto mt-4 max-w-md text-[17px] leading-relaxed text-white/70">
                  {tr(
                    "Takes about a minute. You can book your first appointment straight after.",
                    "Bas ek minute lagta hai — us ke foran baad aap apni pehli appointment book kar sakte hain.",
                  )}
                </p>
                <div className="mt-9 flex justify-center">
                  <Cta href={primaryHref} variant="onDark">
                    {user
                      ? tr("Go to your dashboard", "Apne dashboard par jayein")
                      : tr("Create your account", "Apna account banayein")}
                    <Icon name="arrow_forward" className="text-[20px]" />
                  </Cta>
                </div>
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-line bg-card">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-4 px-5 py-8">
          <Wordmark />
          <p className="text-sm text-faint">
            {tr("Smart Healthcare Management System", "Smart Healthcare Management System")}
          </p>
          <div className="ml-auto flex items-center gap-4">
            <LanguageToggle />
            <Link
              href="/login"
              className="text-sm font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {tr("Sign in", "Login karein")}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
